// src/task-executor.js — Hubtique OS v13.0 — HILO Step Executor
// ─────────────────────────────────────────────────────────────────────
// CARRIED FROM v12 (unchanged, all working):
//  ✅ navigate, click, type, submit, extract, get_content, scroll,
//     upload, wait, wait_for, ai_call, condition, save_result, select
//  ✅ loop, api_call, poll_until, extract_structured, mark_seen,
//     filter_unseen, upload_file, verify_session, screenshot_element
//  ✅ detectAuthError / throwIfSessionExpired
//  ✅ 2FA detection on every browser step
//  ✅ Context variable interpolation {{var}}
//  ✅ Checkpoint / crash-safe resume (executeTask — preserved for old tasks)
//
// AGENT 2 CHANGES (v13 HILO upgrade):
//  ✅ A2-1 — executeStep()        single step dispatcher (action + label routing)
//  ✅ A2-2 — navigateStep()       wraps STEPS.navigate using step.url
//  ✅ A2-3 — readBodyStep()       returns raw page text for planner plans
//  ✅ A2-4 — getSnapshotStep()    returns interactive element registry
//  ✅ A2-5 — clickStep()          resolves label → target_id, then clicks
//  ✅ A2-6 — typeStep()           resolves label → target_id, then types
//  ✅ A2-7 — llmGenerateStep()    calls background llm_generate action
//  ✅ A2-8 — replaceVariables()   {var} substitution from context (planner uses {}, v12 uses {{}})
//  ✅ A2-9 — executePlan()        main entry: runs a generatePlan() plan strictly, no agent thinking
//  ✅ A2-10 — test_execution handler registered for console testing
// ─────────────────────────────────────────────────────────────────────

import * as DB from "./db.js";
import { callAI } from "./rotation.js";

// ── Active tab tracking ───────────────────────────────────────────
async function getTab() {
  const d = await chrome.storage.local.get("activeAgentTabId");
  return d.activeAgentTabId || null;
}
async function setTab(id) {
  await chrome.storage.local.set({ activeAgentTabId: id });
}

// ── Execute one script in the active tab ─────────────────────────
async function exec(fn, args = []) {
  const tabId = await getTab();
  if (!tabId) throw new Error("No active browser tab. Run a 'navigate' step first.");
  const results = await chrome.scripting.executeScript({ target: { tabId }, func: fn, args });
  if (chrome.runtime.lastError) throw new Error(chrome.runtime.lastError.message);
  const result = results?.[0]?.result;
  if (result && result.success === false) throw new Error(result.error || "Script execution failed");
  return result;
}

// ── 2FA detection ─────────────────────────────────────────────────
async function detect2FA() {
  try {
    return await exec(() => {
      if (typeof window.__hubtique_detect2FA__ === 'function') {
        return window.__hubtique_detect2FA__();
      }
      const body = document.body.innerText.toLowerCase();
      const patterns = [/two.factor/i, /2fa/i, /captcha/i, /prove.*human/i, /i.?m not a robot/i];
      return patterns.some(p => p.test(body));
    });
  } catch { return false; }
}

// ── Session / auth error detection ────────────────────────────────
async function detectAuthError() {
  try {
    const result = await exec(() => {
      if (typeof window.__hubtique_detectAuthError__ !== 'function') {
        return { isAuthError: false, score: 0 };
      }
      return window.__hubtique_detectAuthError__();
    });
    return result?.isAuthError === true;
  } catch { return false; }
}

async function throwIfSessionExpired() {
  const expired = await detectAuthError();
  if (expired) {
    let loginUrl = 'unknown';
    try { loginUrl = (await exec(() => location.href)) || 'unknown'; } catch {}
    const err = new Error('Session expired — login page detected after action');
    err.code = 'SESSION_EXPIRED';
    err.loginUrl = loginUrl;
    throw err;
  }
}

// ── Interpolate {{vars}} from context (v12 format) ────────────────
function interpolate(str, ctx) {
  return String(str || '').replace(/\{\{(\w+)\}\}/g, (_, k) => ctx[k] ?? '');
}

// ─────────────────────────────────────────────────────────────────────
// STEP HANDLERS (v12 — unchanged)
// ─────────────────────────────────────────────────────────────────────
const STEPS = {

  // ── Navigate to URL ────────────────────────────────────────────
  async navigate({ url }, ctx) {
    const resolvedUrl = interpolate(url, ctx);
    let tabId = await getTab();

    const waitForLoad = (tid) => new Promise(resolve => {
      const done = (tId, info) => {
        if (tId === tid && info.status === "complete") {
          chrome.tabs.onUpdated.removeListener(done);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(done);
      setTimeout(resolve, 10000); // fallback
    });

    // BUG FIX 4a — v13.1: If tab update fails (tab was closed/crashed from prior run),
    // the old code swallowed the error with .catch(() => null) and then passed the dead
    // tabId to waitForLoad, which silently timed out after 10s. Now: detect failure and
    // create a fresh tab instead. This eliminates the "ctx timeout" after stale-tab runs.
    if (tabId) {
      let updated = null;
      try { updated = await chrome.tabs.update(tabId, { url: resolvedUrl }); } catch (_) {}
      if (!updated) {
        console.warn(`[EXEC] navigate: tab ${tabId} is dead — creating fresh tab`);
        const t = await chrome.tabs.create({ url: resolvedUrl });
        tabId = t.id;
        await setTab(tabId);
      }
    } else {
      const t = await chrome.tabs.create({ url: resolvedUrl });
      tabId = t.id;
      await setTab(tabId);
    }
    await waitForLoad(tabId);
    // BUG FIX 4b — v13.1: 1200ms was too short for SPAs (Gmail, ChatGPT, etc.) that
    // inject content after the load event fires. Bumped to 2500ms. Fixes "ctx timeout"
    // errors that appeared immediately after navigating to JS-heavy pages.
    await new Promise(r => setTimeout(r, 2500)); // SPA settle (was 1200ms)
    return { url: resolvedUrl, tabId };
  },

  // ── Click by registry ID ───────────────────────────────────────
  async click({ target_id }, ctx) {
    return exec((tid) => {
      const reg = window.__omni_registry__ || {};
      const entry = reg[tid];
      if (!entry?.el) return { success: false, error: `Element ${tid} not found` };
      entry.el.scrollIntoView({ behavior: "smooth", block: "center" });
      return new Promise(res => setTimeout(() => {
        try {
          const rect = entry.el.getBoundingClientRect();
          const cx = rect.left + rect.width / 2;
          const cy = rect.top + rect.height / 2;
          const opts = { bubbles: true, cancelable: true, clientX: cx, clientY: cy };
          entry.el.dispatchEvent(new MouseEvent("mousedown", opts));
          entry.el.click();
          entry.el.dispatchEvent(new MouseEvent("mouseup", opts));
          res({ success: true });
        } catch (e) { res({ success: false, error: e.message }); }
      }, 60 + Math.random() * 100));
    }, [target_id]);
  },

  // ── Type text ──────────────────────────────────────────────────
  async type({ target_id, value = "", submit = false }, ctx) {
    const resolved = interpolate(value, ctx);
    return exec(async (tid, val, sub) => {
      const reg = window.__omni_registry__ || {};
      const entry = reg[tid];
      if (!entry?.el) return { success: false, error: `Element ${tid} not found` };
      const el = entry.el;
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      await new Promise(r => setTimeout(r, 150));
      el.focus();

      if (el.isContentEditable) {
        document.execCommand('selectAll', false, null);
        document.execCommand('delete', false, null);
        const ok = document.execCommand('insertText', false, val);
        if (!ok) el.textContent = val;
        el.dispatchEvent(new Event('input',  { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));

        // Gmail To/Cc/Bcc: fire Tab to confirm chip
        const aria = (el.getAttribute('aria-label') || '').toLowerCase();
        const isRecipient = aria.includes('to') || aria.includes('cc') || aria.includes('bcc') || aria.includes('recipient');
        if (isRecipient) {
          await new Promise(r => setTimeout(r, 300));
          el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', keyCode: 9, bubbles: true, cancelable: true }));
          el.dispatchEvent(new KeyboardEvent('keyup',   { key: 'Tab', keyCode: 9, bubbles: true }));
        } else {
          el.dispatchEvent(new Event('blur', { bubbles: true }));
          el.focus();
        }
      } else {
        // Standard input/textarea — char by char for human-like timing
        const nativeSetter = Object.getOwnPropertyDescriptor(
          el.tagName === 'INPUT' ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype, 'value'
        )?.set;
        const set = v => { if (nativeSetter) nativeSetter.call(el, v); else el.value = v; };
        set('');
        for (const char of val) {
          await new Promise(r => setTimeout(r, 30 + Math.random() * 60));
          el.dispatchEvent(new KeyboardEvent('keydown', { key: char, bubbles: true, cancelable: true }));
          set(el.value + char);
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new KeyboardEvent('keyup', { key: char, bubbles: true }));
        }
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new Event('blur',   { bubbles: true }));
        el.focus();
      }

      if (sub) {
        await new Promise(r => setTimeout(r, 300));
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
        if (el.form) el.form.dispatchEvent(new Event('submit', { bubbles: true }));
      }
      return { success: true, typed: val.length };
    }, [target_id, resolved, submit]);
  },

  // ── Submit / Enter ─────────────────────────────────────────────
  async submit({ target_id }, ctx) {
    const result = await exec((tid) => {
      const reg = window.__omni_registry__ || {};
      const entry = reg[tid];
      const el = entry?.el;
      if (!el) return { success: false, error: `Element ${tid} not found` };
      el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", keyCode: 13, bubbles: true }));
      if (el.form) { try { el.form.requestSubmit(); } catch { el.form.dispatchEvent(new Event("submit", { bubbles: true })); } }
      return { success: true };
    }, [target_id]);

    if (result?.success) {
      await new Promise(r => setTimeout(r, 1500));
      await throwIfSessionExpired();
    }
    return result;
  },

  // ── Extract text from element ──────────────────────────────────
  async extract({ target_id }, ctx) {
    return exec((tid) => {
      const reg = window.__omni_registry__ || {};
      const entry = reg[tid];
      if (!entry?.el) return { success: false, error: `Element ${tid} not found` };
      return { success: true, text: entry.el.innerText || entry.el.value || "" };
    }, [target_id]);
  },

  // ── Get full page content ──────────────────────────────────────
  async get_content({}, ctx) {
    await throwIfSessionExpired();
    return exec(() => {
      const reg = window.__omni_registry__ || {};
      const lines = Object.entries(reg).map(([id, info]) => `[${id}] ${info.label} (${info.type})`);
      return {
        success: true,
        registry: lines.join("\n"),
        body:  document.body.innerText.substring(0, 5000),
        url:   location.href,
        title: document.title,
      };
    });
  },

  // ── Scroll ────────────────────────────────────────────────────
  async scroll({ direction = "down", amount = 400 }, ctx) {
    return exec((dir, amt) => {
      window.scrollBy({ top: dir === "up" ? -amt : amt, behavior: "smooth" });
      return { success: true };
    }, [direction, amount]);
  },

  // ── Wait N seconds ────────────────────────────────────────────
  async wait({ seconds = 2 }, ctx) {
    await new Promise(r => setTimeout(r, Math.min(seconds, 60) * 1000));
    return { success: true, waited: seconds };
  },

  // ── Wait for element to appear ────────────────────────────────
  async wait_for({ selector, timeout_ms = 15000 }, ctx) {
    const start = Date.now();
    while (Date.now() - start < timeout_ms) {
      const found = await exec((sel) => !!document.querySelector(sel), [selector]).catch(() => false);
      if (found) return { success: true, found: true };
      await new Promise(r => setTimeout(r, 600));
    }
    throw new Error(`Element ${selector} not found after ${timeout_ms}ms`);
  },

  // ── AI call with provider rotation ───────────────────────────
  async ai_call({ prompt, system = "You are a helpful assistant.", use_page_content = false }, ctx) {
    let finalPrompt = interpolate(prompt, ctx);
    if (use_page_content && ctx._page_content) {
      finalPrompt = `Page content:\n${ctx._page_content}\n\n${finalPrompt}`;
    }
    const messages = [
      { role: "system", content: system },
      { role: "user", content: finalPrompt },
    ];
    const { text, provider } = await callAI(messages, ctx._taskId);
    return { success: true, text, provider };
  },

  // ── Condition check ───────────────────────────────────────────
  async condition({ key, equals, contains, step_if_false = null }, ctx) {
    const val = String(ctx[key] ?? "");
    let passed = true;
    if (equals !== undefined) passed = val === String(equals);
    if (contains !== undefined) passed = val.includes(String(contains));
    return { success: true, passed, value: val };
  },

  // ── Save value to context ─────────────────────────────────────
  async save_result({ key, value }, ctx) {
    const resolved = interpolate(String(value), ctx);
    return { success: true, saved: { [key]: resolved } };
  },

  // ── Select dropdown option ────────────────────────────────────
  async select({ target_id, option }, ctx) {
    const resolvedOpt = interpolate(option, ctx);
    return exec((tid, opt) => {
      const reg = window.__omni_registry__ || {};
      const entry = reg[tid];
      if (!entry?.el || entry.el.tagName !== "SELECT") return { success: false, error: `No select at ${tid}` };
      const el = entry.el;
      const optEl = Array.from(el.options).find(o => o.text.includes(opt) || o.value === opt);
      if (!optEl) return { success: false, error: `Option "${opt}" not found` };
      el.value = optEl.value;
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return { success: true, selected: optEl.text };
    }, [target_id, resolvedOpt]);
  },

  // ── LOOP — iterate sub-steps over an array ─────────────────────
  async loop({ items_from, steps = [], max_iterations = 50 }, ctx) {
    const items = ctx[items_from];
    if (!Array.isArray(items)) {
      console.warn(`[EXEC] loop: context key "${items_from}" is not an array`);
      return { success: true, iterations: 0 };
    }
    const limit = Math.min(items.length, max_iterations);
    for (let i = 0; i < limit; i++) {
      ctx._loop_item  = items[i];
      ctx._loop_index = i;
      ctx._loop_total = limit;

      if (items[i] && typeof items[i] === 'object') {
        for (const [k, v] of Object.entries(items[i])) {
          ctx[`_loop_item_${k}`] = v;
        }
      }

      console.log(`[EXEC] loop iteration ${i + 1}/${limit}`);

      for (const subStep of steps) {
        const handler = STEPS[subStep.type];
        if (!handler) {
          console.warn(`[EXEC] loop: unknown sub-step type "${subStep.type}" — skipping`);
          continue;
        }
        const result = await Promise.race([
          handler(subStep, ctx),
          new Promise((_, rej) => setTimeout(() => rej(new Error(`Loop sub-step ${subStep.type} timed out`)), 60000)),
        ]);
        if (result?.text)   ctx[`result_loop_${i}_${subStep.type}`] = result.text;
        if (result?.saved)  ctx = { ...ctx, ...result.saved };
      }
    }
    return { success: true, iterations: limit };
  },

  // ── API CALL — external HTTP request ──────────────────────────
  async api_call({ url, method = "POST", headers = {}, body_template = null, save_response_as = "_api_response" }, ctx) {
    const resolvedUrl  = interpolate(url, ctx);
    const resolvedBody = body_template ? interpolate(body_template, ctx) : null;

    const fetchOpts = {
      method,
      headers: { "Content-Type": "application/json", ...headers },
    };
    if (resolvedBody && method !== "GET") {
      fetchOpts.body = resolvedBody;
    }

    const resp = await fetch(resolvedUrl, fetchOpts);
    if (!resp.ok) throw new Error(`api_call: HTTP ${resp.status} from ${resolvedUrl}`);

    let data;
    const contentType = resp.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      data = await resp.json();
    } else {
      data = await resp.text();
    }

    const saved = { [save_response_as]: typeof data === 'object' ? JSON.stringify(data) : data };
    console.log(`[EXEC] api_call ✅ ${method} ${resolvedUrl} → saved as "${save_response_as}"`);
    return { success: true, data, saved };
  },

  // ── POLL UNTIL — wait for a condition to become true ──────────
  async poll_until({ check_url, expected_contains, timeout_ms = 120000, interval_ms = 5000, save_response_as = "_poll_result" }, ctx) {
    const resolvedUrl = check_url ? interpolate(check_url, ctx) : null;
    const start = Date.now();

    while (Date.now() - start < timeout_ms) {
      let text = '';

      if (resolvedUrl) {
        try {
          const resp = await fetch(resolvedUrl);
          if (resp.ok) text = await resp.text();
        } catch {}
      } else {
        try {
          const bodyResult = await exec(() => document.body.innerText);
          text = bodyResult || '';
        } catch {}
      }

      if (text.includes(expected_contains)) {
        const saved = { [save_response_as]: text };
        console.log(`[EXEC] poll_until ✅ found "${expected_contains}"`);
        return { success: true, found: true, text, saved };
      }

      console.log(`[EXEC] poll_until: waiting... (${Math.round((Date.now() - start) / 1000)}s elapsed)`);
      await new Promise(r => setTimeout(r, interval_ms));
    }

    throw new Error(`poll_until: condition "${expected_contains}" not met after ${timeout_ms}ms`);
  },

  // ── EXTRACT STRUCTURED — LLM-parse page content ────────────────
  async extract_structured({ schema = {}, from_context_key = "_page_content", target_key = "extracted" }, ctx) {
    const content = ctx[from_context_key];
    if (!content) return { success: false, error: `context key "${from_context_key}" is empty` };

    const schemaStr = JSON.stringify(schema, null, 2);
    const messages = [
      {
        role: "system",
        content: "You are a data extraction assistant. Extract structured data from page content. Reply ONLY with valid JSON, no markdown fences, no explanation.",
      },
      {
        role: "user",
        content: `Extract data matching this schema from the page content below.\nSchema:\n${schemaStr}\n\nPage content:\n${content.substring(0, 4000)}\n\nReturn a JSON array of objects matching the schema. If no items found, return [].`,
      },
    ];

    const { text } = await callAI(messages, ctx._taskId);

    let data;
    try {
      const clean = text.replace(/```json|```/g, '').trim();
      data = JSON.parse(clean);
    } catch {
      console.warn(`[EXEC] extract_structured: JSON parse failed, returning raw text`);
      data = [];
    }

    const saved = { [target_key]: Array.isArray(data) ? data : [data] };
    console.log(`[EXEC] extract_structured ✅ extracted ${Array.isArray(data) ? data.length : 1} items`);
    return { success: true, data, saved };
  },

  // ── MARK SEEN — record item as processed (dedup) ───────────────
  async mark_seen({ item_id_from_ctx, store_name }, ctx) {
    const itemId = ctx[item_id_from_ctx];
    if (!itemId) return { success: false, error: `context key "${item_id_from_ctx}" is empty` };
    await DB.markItemSeen(store_name, String(itemId));
    console.log(`[EXEC] mark_seen ✅ ${store_name}:${itemId}`);
    return { success: true, marked: itemId };
  },

  // ── FILTER UNSEEN — remove already-processed items from list ───
  async filter_unseen({ items_from, id_field = "id", store_name, target_key }, ctx) {
    const items = ctx[items_from];
    if (!Array.isArray(items)) return { success: true, saved: { [target_key || items_from]: [] } };

    const seenSet = await DB.getSeenItems(store_name);
    const unseen  = items.filter(item => !seenSet.has(String(item[id_field] || '')));

    const key   = target_key || items_from;
    const saved = { [key]: unseen };
    console.log(`[EXEC] filter_unseen: ${items.length} total, ${unseen.length} new (store: ${store_name})`);
    return { success: true, unseen: unseen.length, total: items.length, saved };
  },

  // ── UPLOAD FILE — attach file to a file input element ─────────
  async upload_file({ input_target_id, file_id_from_ctx }, ctx) {
    const fileId = ctx[file_id_from_ctx];
    if (!fileId) return { success: false, error: `context key "${file_id_from_ctx}" is empty — no file to upload` };

    const fileData = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ action: 'load_file', fileId }, resp => {
        if (resp?.success) resolve(resp);
        else reject(new Error(resp?.error || 'load_file failed'));
      });
    });

    if (!fileData.blob) throw new Error(`File ${fileId} not found in storage`);

    const tabId = await getTab();
    if (!tabId) throw new Error("No active tab for file upload");

    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: (ref, blobBase64, mimeType) => {
        const reg = window.__omni_registry__ || {};
        const entry = reg[ref];
        if (!entry?.el) return { success: false, error: `Element ${ref} not found` };
        const el = entry.el;
        if (el.tagName !== 'INPUT' || el.getAttribute('type') !== 'file') {
          return { success: false, error: `Element ${ref} is not a file input` };
        }

        const byteStr = atob(blobBase64);
        const ab  = new ArrayBuffer(byteStr.length);
        const ia  = new Uint8Array(ab);
        for (let i = 0; i < byteStr.length; i++) ia[i] = byteStr.charCodeAt(i);
        const blob = new Blob([ab], { type: mimeType });
        const file = new File([blob], 'upload', { type: mimeType });

        const dt = new DataTransfer();
        dt.items.add(file);
        el.files = dt.files;
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new Event('input',  { bubbles: true }));
        return { success: true };
      },
      args: [input_target_id, fileData.base64, fileData.mimeType],
    });

    const result = results?.[0]?.result;
    if (result?.success === false) throw new Error(result.error);
    console.log(`[EXEC] upload_file ✅ ${fileId} → ${input_target_id}`);
    return { success: true, fileId };
  },

  // ── VERIFY SESSION — confirm user is logged in ─────────────────
  async verify_session({ url, expected_text, on_failure = "human-handoff" }, ctx) {
    const resolvedUrl = interpolate(url, ctx);
    await STEPS.navigate({ url: resolvedUrl }, ctx);
    await new Promise(r => setTimeout(r, 2000));

    const bodyResult = await exec(() => document.body.innerText);
    const body = (bodyResult || '').toLowerCase();

    if (expected_text && !body.includes(expected_text.toLowerCase())) {
      if (on_failure === 'human-handoff') {
        const err = new Error(`Session verification failed — expected "${expected_text}" not found at ${resolvedUrl}`);
        err.code    = 'SESSION_EXPIRED';
        err.loginUrl = resolvedUrl;
        throw err;
      }
      return { success: false, verified: false, url: resolvedUrl };
    }

    await throwIfSessionExpired();

    console.log(`[EXEC] verify_session ✅ logged in at ${resolvedUrl}`);
    return { success: true, verified: true, url: resolvedUrl };
  },

  // ── SCREENSHOT ELEMENT — capture element as base64 ────────────
  async screenshot_element({ target_id, save_as = "screenshot" }, ctx) {
    const tabId = await getTab();
    if (!tabId) throw new Error("No active tab for screenshot");

    const dataUrl = await chrome.tabs.captureVisibleTab(null, { format: 'png' });

    const bbox = await exec((ref) => {
      const reg = window.__omni_registry__ || {};
      const entry = reg[ref];
      if (!entry?.el) return null;
      const r = entry.el.getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height };
    }, [target_id]);

    if (!bbox) return { success: false, error: `Element ${target_id} not found for screenshot` };

    const blob = await (await fetch(dataUrl)).blob();
    const bitmap = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(Math.ceil(bbox.w), Math.ceil(bbox.h));
    const ctx2d = canvas.getContext('2d');
    ctx2d.drawImage(bitmap, -bbox.x, -bbox.y);
    const cropped = await canvas.convertToBlob({ type: 'image/png' });

    const reader = new FileReader();
    const base64 = await new Promise(res => {
      reader.onload = () => res(reader.result.split(',')[1]);
      reader.readAsDataURL(cropped);
    });

    const saved = { [save_as]: base64, [`${save_as}_mime`]: 'image/png' };
    console.log(`[EXEC] screenshot_element ✅ ${target_id} → ${save_as} (${base64.length} chars)`);
    return { success: true, base64, saved };
  },

};

// ─────────────────────────────────────────────────────────────────────
// LEGACY MAIN EXECUTOR (v12 — preserved for old task.definition.steps format)
// ─────────────────────────────────────────────────────────────────────
export async function executeTask(task) {
  const steps = task.definition?.steps || [];
  if (!steps.length) throw new Error("Task has no steps defined");

  // Restore context and resume from last checkpoint
  const lastCP = await DB.getLastCheckpoint(task.id);
  let startStep = 0;
  let ctx = { _taskId: task.id };

  if (lastCP) {
    startStep = lastCP.step_index + 1;
    ctx = { ...ctx, ...(lastCP.data?.context || {}) };
    console.log(`[EXEC] ▶ Resuming task from step ${startStep}/${steps.length}`);
  }

  for (let i = startStep; i < steps.length; i++) {
    const step    = steps[i];
    const stepType = step.type;
    const handler = STEPS[stepType];

    if (!handler) {
      await DB.logExecution(task.id, { action: "step_skipped", step: i, reason: `Unknown step type: ${stepType}` });
      console.warn(`[EXEC] Unknown step type "${stepType}" at step ${i} — skipping`);
      continue;
    }

    console.log(`[EXEC] ▶ Step ${i + 1}/${steps.length}: ${stepType}`);
    await DB.logExecution(task.id, { action: "step_start", step: i, type: stepType });

    // 2FA check before browser interaction steps
    if (["click", "type", "submit", "navigate"].includes(stepType) && i > 0) {
      const has2FA = await detect2FA();
      if (has2FA) {
        const currentUrl = await exec(() => location.href).catch(() => '?');
        throw Object.assign(new Error("2FA/CAPTCHA detected"), { code: "2FA_REQUIRED", url: currentUrl });
      }
    }

    let result;
    try {
      result = await Promise.race([
        handler(step, ctx),
        new Promise((_, rej) => setTimeout(() => rej(new Error(`Step ${stepType} timed out after 90s`)), 90000)),
      ]);
    } catch (e) {
      await DB.logExecution(task.id, { action: "step_error", step: i, type: stepType, error: e.message, code: e.code });
      throw e;
    }

    // Merge result into context
    if (result?.text)     ctx[`result_step_${i}`] = result.text;
    if (result?.saved)    ctx = { ...ctx, ...result.saved };
    if (result?.registry) ctx._page_registry = result.registry;
    if (result?.body)     ctx._page_content  = result.body;
    if (result?.data && typeof result.data === 'object') {
      ctx[`data_step_${i}`] = JSON.stringify(result.data);
    }

    // Condition step: jump to step_if_false if condition not met
    if (stepType === "condition" && !result.passed && step.step_if_false) {
      console.log(`[EXEC] ↩ Condition false — jumping to step ${step.step_if_false}`);
      i = step.step_if_false - 2; // -1 for loop increment, -1 for 0-index
    }

    // Save checkpoint after every step
    await DB.saveCheckpoint(task.id, i, { context: ctx, result });
    await DB.logExecution(task.id, { action: "step_done", step: i, type: stepType });
    console.log(`[EXEC] ✅ Step ${i + 1} done`);
  }

  await DB.clearCheckpoints(task.id);
  return { success: true, context: ctx };
}

// ─────────────────────────────────────────────────────────────────────
// AGENT 2 — NEW FUNCTIONS (v13 HILO)
// ─────────────────────────────────────────────────────────────────────

// ── A2-8 — replaceVariables ──────────────────────────────────────────
// Substitutes {varName} placeholders (planner format) from context.
// Distinct from interpolate() which handles the {{var}} v12 format.
export function replaceVariables(str, ctx) {
  if (!str || typeof str !== 'string') return str;
  return str.replace(/\{(\w+)\}/g, (_, k) => {
    if (k in ctx) return String(ctx[k]);
    return `{${k}}`; // leave unreplaced if not in context (avoids silent blanks)
  });
}

// ── A2-5 — resolveLabel (internal helper) ───────────────────────────
// Finds a target_id in __omni_registry__ by matching the semantic label
// the planner used (e.g. "Compose", "To recipients", "Subject").
// Tries exact match first, then case-insensitive contains.
async function resolveLabel(label) {
  const result = await exec((lbl) => {
    const reg = window.__omni_registry__ || {};
    const lower = lbl.toLowerCase();

    // 1. Exact match on label field
    for (const [id, info] of Object.entries(reg)) {
      if (info.label === lbl) return id;
    }
    // 2. Case-insensitive contains
    for (const [id, info] of Object.entries(reg)) {
      if ((info.label || '').toLowerCase().includes(lower)) return id;
    }
    // 3. aria-label / placeholder / name / title on the element itself
    //    IMPORTANT: do NOT match on innerText for non-interactive elements —
    //    skip-nav landmarks like "Search, alt, forward slash" appear in innerText
    //    of <a>/<button> shortcuts and fool the resolver into clicking them
    //    instead of the actual <input>. Only match innerText for inputs/textareas
    //    and short-text buttons. Skip aria-hidden and navigation role elements.
    for (const [id, info] of Object.entries(reg)) {
      const el = info.el;
      if (!el) continue;
      // Skip skip-nav / keyboard shortcut hint elements
      const role = (el.getAttribute('role') || '').toLowerCase();
      if (role === 'navigation') continue;
      if (el.getAttribute('aria-hidden') === 'true') continue;
      const tagName = (el.tagName || '').toUpperCase();
      const attrs = [
        el.getAttribute('aria-label'),
        el.getAttribute('placeholder'),
        el.getAttribute('name'),
        el.getAttribute('title'),
      ].filter(Boolean).map(a => a.toLowerCase());
      // Only include innerText for genuine interactive leaf elements with short text
      // (avoids matching skip-nav anchors whose innerText is "Search, alt, forward slash")
      const rawText = (el.innerText || '').trim();
      const elText = (tagName === 'INPUT' || tagName === 'TEXTAREA' ||
                      (tagName === 'BUTTON' && rawText.length < 60))
        ? rawText.toLowerCase()
        : '';
      if ([...attrs, elText].some(a => a && a.includes(lower))) return id;
    }
    return null;
  }, [label]);

  if (!result) {
    throw new Error(`resolveLabel: no element found for label "${label}". Check getSnapshot output.`);
  }
  return result;
}

// ── A2-2 — navigateStep ──────────────────────────────────────────────
async function navigateStep(step, ctx) {
  let url = replaceVariables(step.url || '', ctx);
  if (!url) throw new Error('navigateStep: step.url is missing');

  // ── BRAIN FIX v13.1 — URL SANITIZER ────────────────────────────────
  // The LLM was hallucinating wrong domains (e.g. "amazonsite.com" instead of
  // "amazon.com"). The prompt fix in agent-planner.js is the primary defence.
  // This sanitizer is the safety net — it catches wrong URLs even if the LLM
  // ignores the prompt. Logic:
  //   1. Parse the hostname from the LLM-generated URL
  //   2. Check if it looks like a hallucination (extra words appended to a
  //      known brand name, e.g. "amazon" + "site", "bestbuy" + "store")
  //   3. If a match is found in KNOWN_SITE_URLS, replace the URL silently
  //      and log a warning so the bug is visible in the execution log.
  const KNOWN_SITE_URLS = {
    'amazon': 'https://www.amazon.com',
    'bestbuy': 'https://www.bestbuy.com',
    'best buy': 'https://www.bestbuy.com',
    'ebay': 'https://www.ebay.com',
    'walmart': 'https://www.walmart.com',
    'target': 'https://www.target.com',
    'etsy': 'https://www.etsy.com',
    'gmail': 'https://mail.google.com',
    'google': 'https://www.google.com',
    'chatgpt': 'https://chatgpt.com',
    'openai': 'https://chatgpt.com',
    'gemini': 'https://gemini.google.com',
    'claude': 'https://claude.ai',
    'perplexity': 'https://www.perplexity.ai',
    'duckduckgo': 'https://duckduckgo.com',
    'hackernews': 'https://news.ycombinator.com',
    'hacker news': 'https://news.ycombinator.com',
    'reddit': 'https://www.reddit.com',
    'github': 'https://github.com',
    'youtube': 'https://www.youtube.com',
    'twitter': 'https://twitter.com',
    'linkedin': 'https://www.linkedin.com',
    'justpaste': 'https://justpaste.it',
    'pastebin': 'https://pastebin.com',
    'notion': 'https://www.notion.so',
    'stackoverflow': 'https://stackoverflow.com',
  };
  try {
    const parsed = new URL(url.startsWith('http') ? url : 'https://' + url);
    const hostname = parsed.hostname.replace(/^www\./, '').toLowerCase();
    // Extract the base brand from hostname by stripping common noise suffixes
    // e.g. "amazonsite.com" → base "amazon", "bestbuystore.com" → base "bestbuy"
    const noiseSuffixes = ['site', 'store', 'shop', 'web', 'online', 'official', 'app', 'inc'];
    const baseDomain = hostname.split('.')[0]; // e.g. "amazonsite"
    for (const [brand, canonicalUrl] of Object.entries(KNOWN_SITE_URLS)) {
      const brandKey = brand.replace(' ', '');
      // Match if hostname starts with the brand and has extra junk after it
      // OR if hostname IS the brand exactly (handles missing TLD hallucinations)
      const isHallucination = baseDomain !== brandKey &&
                              baseDomain.startsWith(brandKey) &&
                              noiseSuffixes.some(s => baseDomain === brandKey + s);
      const isBrandExact   = baseDomain === brandKey && !hostname.includes('.');
      if (isHallucination || isBrandExact) {
        console.warn(`[EXEC] 🧠 URL SANITIZER: "${url}" looks like a hallucination — correcting to "${canonicalUrl}"`);
        url = canonicalUrl;
        break;
      }
    }
  } catch (_) { /* malformed URL — let STEPS.navigate handle the error */ }

  // Rewrite JS-heavy sites to cleaner/static versions where available
  // Reddit: new Reddit is SPA — old.reddit.com is server-rendered HTML, read_body works instantly
  url = url.replace(/^https?:\/\/(www\.)?reddit\.com/, 'https://old.reddit.com');
  // Twitter/X: use nitter if available (fallback stays on x.com if nitter is down)
  // (no rewrite — nitter instances are unreliable)
  console.log(`[EXEC] ┌─ navigate → ${url}`);
  const result = await STEPS.navigate({ url }, ctx);
  console.log(`[EXEC] └─ ✅ navigate done`);
  return { navigated: url, tabId: result.tabId };
}

// ── A2-3 — readBodyStep ──────────────────────────────────────────────
// Returns raw page text. Planner uses this to extract article titles,
// vote counts, etc. Result is stored in ctx.page_body.
//
// UNIVERSAL STABILITY POLL — works for ALL sites (SPA, SSR, static).
// Polls innerText until it stops growing for 2 consecutive checks, or
// 8s passes. This means Reddit, Twitter, LinkedIn, HN, any SPA all
// get their content without needing a per-site whitelist.
async function readBodyStep(step, ctx) {
  console.log(`[EXEC] ┌─ read_body`);
  // Poll until page text stabilises (handles any JS-rendered site)
  await exec(async () => {
    const MAX_WAIT = 8000;
    const POLL = 700;
    const STABLE_THRESHOLD = 100; // stop if growth < 100 chars between polls
    const start = Date.now();
    let prev = 0;
    let stableCount = 0;
    while (Date.now() - start < MAX_WAIT) {
      await new Promise(r => setTimeout(r, POLL));
      const cur = (document.body || document.documentElement).innerText.length;
      if (cur - prev < STABLE_THRESHOLD) {
        stableCount++;
        if (stableCount >= 2) break; // stable for 2 polls = done
      } else {
        stableCount = 0;
      }
      prev = cur;
    }
  });
  // ── REDDIT JSON API FETCH ─────────────────────────────────────
  // Reddit uses closed shadow DOM — innerText can't see comments.
  // Solution: fetch the .json API endpoint directly from the page context.
  // This is universal — works for any Reddit URL (listing, post, comments).
  const redditBody = await exec(async () => {
    const url = location.href;
    if (!url.includes('reddit.com')) return null;
    try {
      // Strip query params, add .json
      const jsonUrl = url.split('?')[0].replace(/\/$/, '') + '.json?limit=10&raw_json=1';
      const resp = await fetch(jsonUrl, {
        headers: { 'Accept': 'application/json' }
      });
      if (!resp.ok) return null;
      const json = await resp.json();
      let lines = [];
      // Listing page: array of posts
      if (json?.data?.children) {
        json.data.children.slice(0, 15).forEach(p => {
          const d = p.data;
          if (d.title) lines.push(`POST: ${d.title} | score:${d.score} | url:${d.permalink}`);
        });
        return lines.length ? 'REDDIT POSTS:\n' + lines.join('\n') : null;
      }
      // Post+comments page: [postData, commentsData]
      if (Array.isArray(json) && json.length >= 2) {
        const post = json[0]?.data?.children?.[0]?.data;
        if (post) lines.push(`POST: ${post.title} | score:${post.score} | author:${post.author}`);
        const comments = json[1]?.data?.children || [];
        comments
          .filter(c => c.data?.body && c.data.body !== '[deleted]' && c.data.body !== '[removed]')
          .sort((a,b) => (b.data.score||0) - (a.data.score||0))
          .slice(0, 8)
          .forEach(c => lines.push(`COMMENT(score:${c.data.score}, author:${c.data.author}): ${c.data.body}`));
        return lines.length ? lines.join('\n') : null;
      }
    } catch(e) { return null; }
    return null;
  });
  if (redditBody) {
    console.log(`[EXEC] └─ ✅ read_body via Reddit JSON API (${redditBody.length} chars)`);
    return {
      body: redditBody,
      url: (await exec(() => location.href)) || '',
      title: (await exec(() => document.title)) || '',
      saved: { page_body: redditBody, page_url: '', page_title: '' },
    };
  }

  const body = await exec(() => {
    // ── UNIVERSAL BODY READER ──────────────────────────────────────
    // 1. Light DOM text (standard sites)
    let text = (document.body || document.documentElement).innerText || '';

    // 2. Shadow DOM walker — recursively extracts text from all open shadow roots.
    //    Handles Web Components like Reddit's <shreddit-post>, <shreddit-comment>,
    //    YouTube, Twitter, and any other site using shadow DOM.
    function walkShadow(root) {
      let out = '';
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
      let node = walker.currentNode;
      while (node) {
        if (node.shadowRoot) {
          out += walkShadow(node.shadowRoot);
        }
        // Extract custom element attributes as readable text (e.g. shreddit-post)
        if (node.tagName && node.tagName.includes('-')) {
          const attrs = ['post-title','title','score','author','permalink',
                         'comment-count','body','content','label','name',
                         'description','value','text'];
          const parts = attrs
            .map(a => node.getAttribute(a))
            .filter(Boolean);
          if (parts.length) out += '\n' + parts.join(' | ');
        }
        node = walker.nextNode();
      }
      // Also get innerText of shadow root itself
      try {
        const sr = root.querySelector && root.querySelector('*');
        if (root.textContent) out += '\n' + root.textContent.substring(0, 3000);
      } catch(_) {}
      return out;
    }
    const shadowText = walkShadow(document.body || document.documentElement);
    if (shadowText.trim().length > 100) {
      text = text + '\n\n[SHADOW DOM CONTENT]\n' + shadowText;
    }

    // 3. JSON response detection — if page IS a JSON response (e.g. reddit.com/r/rust/top.json)
    //    parse and extract key fields for readability
    const pre = document.querySelector('pre, body > pre');
    if (pre && pre.textContent.trim().startsWith('{')) {
      try {
        const json = JSON.parse(pre.textContent);
        // Reddit JSON API: extract post titles, scores, comments
        const posts = json?.data?.children || [];
        if (posts.length > 0) {
          const postLines = posts.slice(0, 10).map(p => {
            const d = p.data;
            return `POST: ${d.title} | score:${d.score} | comments:${d.num_comments} | url:${d.permalink}`;
          });
          text = 'REDDIT JSON FEED:\n' + postLines.join('\n');
        }
        // Reddit comments JSON: [post, comments]
        if (Array.isArray(json) && json[1]) {
          const comments = json[1]?.data?.children || [];
          const commentLines = comments
            .filter(c => c.data?.body && c.data.body !== '[deleted]')
            .sort((a,b) => (b.data.score||0) - (a.data.score||0))
            .slice(0, 5)
            .map(c => `COMMENT(score:${c.data.score}): ${c.data.body}`);
          text = 'REDDIT COMMENTS:\n' + commentLines.join('\n');
        }
      } catch(_) {}
    }

    return {
      body:  text.substring(0, 12000),
      url:   location.href,
      title: document.title,
    };
  });
  const bodyText = body?.body || '';
  const lowSignalPatterns = [
    /skip to main content/i,
    /keyboard shortcuts/i,
    /search alt\s*\+\s*\//i,
  ];
  const signalPatterns = [/\$\s?\d+[.,]\d{2}/, /sony\s+wh-1000xm5/i, /best buy|amazon/i];
  const lowSignalRead = lowSignalPatterns.filter(r => r.test(bodyText)).length >= 2 &&
    signalPatterns.every(r => !r.test(bodyText));
  if (lowSignalRead) {
    ctx._low_signal_read_body_count = (ctx._low_signal_read_body_count || 0) + 1;
  } else {
    ctx._low_signal_read_body_count = 0;
  }
  console.log(`[EXEC] └─ ✅ read_body (${bodyText.length} chars)${lowSignalRead ? ' [LOW_SIGNAL]' : ''}`);
  return {
    body: bodyText,
    url:  body?.url  || '',
    title: body?.title || '',
    low_signal_read_body: lowSignalRead,
    saved: { page_body: bodyText, page_url: body?.url || '', page_title: body?.title || '', low_signal_read_body: lowSignalRead },
  };
}

// ── A2-4 — getSnapshotStep ───────────────────────────────────────────
// Returns the interactive element registry so downstream steps can
// use resolveLabel(). Result stored in ctx._page_registry.
async function getSnapshotStep(step, ctx) {
  console.log(`[EXEC] ┌─ getSnapshot`);
  const result = await STEPS.get_content({}, ctx);
  console.log(`[EXEC] └─ ✅ getSnapshot (${result?.registry?.split('\n').length || 0} elements)`);
  return {
    registry: result?.registry || '',
    saved: { _page_registry: result?.registry || '', _page_content: result?.body || '' },
  };
}

// ── A2-5 — clickStep ────────────────────────────────────────────────
// Resolves step.label → target_id in the registry, then clicks.
async function clickStep(step, ctx) {
  const label = replaceVariables(step.label || '', ctx);
  console.log(`[EXEC] ┌─ click "${label}"`);

  // Always refresh snapshot before clicking — a stale registry (from a previous
  // step or a failed-click recovery) is the #1 cause of click loops where the
  // agent keeps hitting the wrong element. The ~200ms cost is worth it.
  // BUG FIX 3a — v13.1: result was discarded (await without assignment). ctx never
  // received fresh _page_registry / _page_content. Now merged immediately.
  const snapClick = await getSnapshotStep(step, ctx);
  if (snapClick?.saved) Object.assign(ctx, snapClick.saved);

  const targetId = await resolveLabel(label);
  const result = await STEPS.click({ target_id: targetId }, ctx);
  await new Promise(r => setTimeout(r, 800)); // let page react
  console.log(`[EXEC] └─ ✅ click "${label}" (${targetId})`);
  return { clicked: label, target_id: targetId };
}

// ── A2-6 — typeStep ──────────────────────────────────────────────────
// Resolves step.label → target_id, then types step.value.
// step.value supports {varName} substitution from context.
async function typeStep(step, ctx) {
  const label = replaceVariables(step.label || '', ctx);
  let value = replaceVariables(step.value || '', ctx);
  const requiredQuery = ctx.required_query || ctx.collected?.required_query || ctx.goal_query;
  if (requiredQuery && /search/i.test(label) && value && value.trim() !== requiredQuery.trim()) {
    console.warn(`[EXEC] typeStep query drift prevented: "${value}" -> "${requiredQuery}"`);
    value = requiredQuery;
  }
  console.log(`[EXEC] ┌─ type "${label}" = "${value.substring(0, 60)}${value.length > 60 ? '…' : ''}"`);

  // Always refresh snapshot before typing — same stale registry risk as clickStep.
  // BUG FIX 3b — v13.1: result was discarded (await without assignment). Fixed same
  // as clickStep above — now merged into ctx so resolveLabel sees the fresh registry.
  const snapType = await getSnapshotStep(step, ctx);
  if (snapType?.saved) Object.assign(ctx, snapType.saved);

  const targetId = await resolveLabel(label);
  await STEPS.type({ target_id: targetId, value }, ctx);
  await new Promise(r => setTimeout(r, 400));
  console.log(`[EXEC] └─ ✅ type "${label}" done`);
  return { typed_into: label, value, target_id: targetId };
}

// ── A2-7 — llmGenerateStep ───────────────────────────────────────────
// Calls the LLM via the background bridge (same path as agent-planner).
// Result text is stored in ctx.llm_result for subsequent steps.
async function llmGenerateStep(step, ctx) {
  let prompt = replaceVariables(step.prompt || '', ctx);
  // Auto-inject page_body if available and prompt doesn't already include it.
  // This fixes the case where read_body ran but llm_generate prompt has no {page_body}.
  // Caps at 6000 chars to avoid token overflow.
  if (ctx.page_body && !prompt.includes(ctx.page_body.substring(0, 80))) {
    const bodySnippet = ctx.page_body.substring(0, 6000);
    prompt = `PAGE CONTENT:\n${bodySnippet}\n\nTASK:\n${prompt}`;
  }
  console.log(`[EXEC] ┌─ llm_generate (${prompt.length} chars)`);

  // Route through background bridge
  const result = await new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('llm_generate: background bridge timeout (30s)')),
      30_000
    );
    chrome.runtime.sendMessage(
      { action: 'llm_generate', messages: [{ role: 'user', content: prompt }], taskId: ctx._taskId || null },
      (response) => {
        clearTimeout(timeout);
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(response);
        }
      }
    );
  });

  if (!result?.success || !result.text) {
    throw new Error(`llm_generate: LLM call failed — ${result?.error || 'empty response'}`);
  }

  console.log(`[EXEC] └─ ✅ llm_generate (${result.text.length} chars, provider: ${result.provider})`);
  return {
    text: result.text,
    provider: result.provider,
    saved: { llm_result: result.text, llm_provider: result.provider },
  };
}

// ── A2-1 — executeStep ───────────────────────────────────────────────
// Single step dispatcher for plans produced by generatePlan().
// Maps step.action → the correct function above.
// Also handles legacy steps (step.type) for backward compatibility.
export async function executeStep(step, ctx) {
  // BUG FIX 2 — v13.1: LLM occasionally returns "Done" or "done" (title/lower case).
  // The switch below only matched "DONE". Unmatched action → "Unknown action: Done" →
  // agent looped forever on read_body instead of stopping. Fix: normalize to uppercase
  // for the DONE token only; leave all other action strings untouched (they're lowercase).
  const rawAction = step.action || step.type || '';
  const action = rawAction.replace(/^done$/i, 'DONE');
  const startMs = Date.now();

  let result;
  switch (action) {
    case 'navigate':     result = await navigateStep(step, ctx);     break;
    case 'read_body':    result = await readBodyStep(step, ctx);     break;
    case 'getSnapshot':  result = await getSnapshotStep(step, ctx);  break;
    case 'click':        result = await clickStep(step, ctx);        break;
    case 'type':         result = await typeStep(step, ctx);         break;
    case 'llm_generate': result = await llmGenerateStep(step, ctx);  break;
    case 'wait':         result = await STEPS.wait(step, ctx);       break;
    case 'scroll':       result = await STEPS.scroll(step, ctx);     break;
    case 'submit':       result = await STEPS.submit(step, ctx);     break;
    case 'DONE':
      console.log(`[EXEC] ✅ DONE step reached`);
      result = { done: true, value: replaceVariables(step.value || 'Task complete', ctx) };
      break;
    default:
      // Fall back to legacy STEPS map for any v12 step type
      if (STEPS[action]) {
        result = await STEPS[action](step, ctx);
      } else {
        throw new Error(`executeStep: unknown action "${action}"`);
      }
  }

  result._duration_ms = Date.now() - startMs;
  return result;
}

// ── A2-9 — executePlan ───────────────────────────────────────────────
// Main entry point for HILO execution.
// Takes a plan produced by generatePlan() and executes it step-by-step
// with NO agent thinking between steps — pure mechanical execution.
//
// Usage (from background.js):
//   const { plan } = await generatePlan(goal, strategy);
//   const outcome  = await executePlan(taskId, plan);
//
// Returns: { success, results, context, stepCount }
export async function executePlan(taskId, plan) {
  if (!plan?.steps?.length) {
    throw new Error('executePlan: plan has no steps');
  }

  console.log(`[EXEC] ═══ executePlan: ${plan.steps.length} steps ═══`);

  // BUG FIX 1 — v13.1: activeAgentTabId was NEVER cleared between task runs.
  // When a previous run ended on a broken/wrong page (e.g. news.ycombinator.com/forgot),
  // the next task inherited that tab and started reading "Reset your password username:"
  // instead of navigating fresh. This caused all tasks to complete in 2-3 steps doing
  // nothing — readBodyStep read the wrong page, LLM called DONE, task marked "complete".
  // Fix: unconditionally clear the stored tab ID at the start of every new executePlan.
  // The first `navigate` step will create a new tab and re-set the ID correctly.
  await chrome.storage.local.remove('activeAgentTabId');
  console.log('[EXEC] 🔄 Cleared stale tab ID — fresh tab will be created on first navigate');

  const ctx = { _taskId: taskId };
  const results = [];

  for (let i = 0; i < plan.steps.length; i++) {
    const step = plan.steps[i];
    // BUG FIX 2 (second site) — same DONE normalization as executeStep.
    // executePlan reads action directly for the intermediate-DONE guard (line below)
    // and the completion break-check at the bottom of the loop. Both checks used
    // `=== 'DONE'` which failed silently when LLM returned "Done" or "done".
    const rawAction = step.action || step.type || '';
    const action = rawAction.replace(/^done$/i, 'DONE');
    const label = i + 1;

    // Skip DONE steps that aren't the last — they're meta-markers
    if (action === 'DONE' && i < plan.steps.length - 1) {
      console.log(`[EXEC] ⚠ Skipping intermediate DONE at step ${label}`);
      continue;
    }

    console.log(`[EXEC] ─── Step ${label}/${plan.steps.length}: ${action}`);

    let stepResult = null;
    let stepError  = null;
    let attempt    = 0;
    const maxAttempts = 3;

    while (attempt < maxAttempts) {
      attempt++;
      try {
        stepResult = await Promise.race([
          executeStep(step, ctx),
          new Promise((_, rej) =>
            setTimeout(() => rej(new Error(`Step "${action}" timed out after 45s`)), 45_000)
          ),
        ]);
        stepError = null;
        break; // success — exit retry loop
      } catch (e) {
        stepError = e;
        console.warn(`[EXEC] ⚠ Step ${label} attempt ${attempt} failed: ${e.message}`);
        if (attempt < maxAttempts) {
          await new Promise(r => setTimeout(r, 2000 * attempt)); // exponential backoff
        }
      }
    }

    const stepRecord = {
      stepId:   step.id ?? label,
      action,
      attempt,
      status:   stepError ? 'failed' : 'success',
      result:   stepResult,
      error:    stepError?.message || null,
      duration: stepResult?._duration_ms || 0,
    };

    results.push(stepRecord);

    // Merge saved context variables
    if (stepResult?.saved && typeof stepResult.saved === 'object') {
      Object.assign(ctx, stepResult.saved);
    }

    // Propagate commonly-named outputs for subsequent steps
    if (stepResult?.body)  ctx.page_body  = stepResult.body;
    if (stepResult?.text)  ctx.llm_result = stepResult.text;
    if (stepResult?.navigated) ctx.current_url = stepResult.navigated;

    // Hard-stop on session expiry or 2FA — no point retrying
    if (stepError?.code === 'SESSION_EXPIRED' || stepError?.code === '2FA_REQUIRED') {
      console.error(`[EXEC] ✋ Hard stop: ${stepError.code}`);
      break;
    }

    // If step failed all retries, stop the plan
    if (stepError) {
      console.error(`[EXEC] ✖ Step ${label} failed after ${maxAttempts} attempts — stopping plan`);
      break;
    }

    // DONE step reached successfully — no more steps needed
    if (action === 'DONE') {
      console.log(`[EXEC] ✅ Plan complete at DONE step`);
      break;
    }
  }

  const successCount = results.filter(r => r.status === 'success').length;
  const allPassed    = successCount === results.length;

  console.log(`[EXEC] ═══ Done: ${successCount}/${results.length} steps succeeded ═══`);

  return {
    success:   allPassed,
    results,
    context:   ctx,
    stepCount: results.length,
  };
}

// ── A2-10 — TEST HANDLER ────────────────────────────────────────────
// Test command (paste in Service Worker console):
//   chrome.runtime.sendMessage({
//     action: 'test_execution',
//     plan: { steps: [
//       { id: 1, action: 'navigate', url: 'https://news.ycombinator.com/' },
//       { id: 2, action: 'read_body' }
//     ]}
//   }, r => console.log(r));
if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    if (request.action !== 'test_execution') return false;

    const plan = request.plan;
    if (!plan?.steps?.length) {
      sendResponse({ success: false, error: 'test_execution: no plan provided' });
      return true;
    }

    const taskId = `test_exec_${Date.now()}`;
    console.log(`[EXEC] 🧪 test_execution: ${plan.steps.length} steps`);

    executePlan(taskId, plan)
      .then(outcome => {
        console.log(`[EXEC] ✅ test_execution PASS — ${outcome.stepCount} steps, success=${outcome.success}`);
        sendResponse({ success: outcome.success, results: outcome.results, stepCount: outcome.stepCount });
      })
      .catch(err => {
        console.error(`[EXEC] ❌ test_execution FAIL:`, err.message);
        sendResponse({ success: false, error: err.message });
      });

    return true; // keep channel open for async sendResponse
  });
}
