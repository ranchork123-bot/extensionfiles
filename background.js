// background.js — Hubtique OS v13.1 — COMPLEX TASK ENGINE
// ─────────────────────────────────────────────────────────────────────
// v13.1 ADDITIONS (Agent 7 — Polling Fix):
//  ✅ A7-1 — get_task_status handler: polls background state from frontend
//            (replaces hanging Promise with polling in CometBrowser Phase 3)
//            CometBrowser calls this every 2s to get task.status
// v13.0 ADDITIONS (Agents 3, 4, 6):
//  ✅ A4-1 — humanActivityState object + chrome.runtime.onMessage listener
//            for 'human_activity' messages forwarded by content.js
//  ✅ A4-2 — isHumanUsingBrowser(): queries active-tab content script,
//            falls back to in-memory state if content script unavailable
//  ✅ A4-3 — waitForHumanToStop(): polls isHumanUsingBrowser every 500ms
//  ✅ A3-1 — reportStepCompletion(taskId, step, outcome): persists to
//            IndexedDB via saveTaskStep() + broadcasts 'step_completed'
//            to all open Lovable/localhost frontend tabs
//  ✅ A3-2 — generateReasoning(action, result): human-readable "why" string
//  ✅ A3-3 — sendToFrontendTabs(message): broadcasts to *.lovable.app + localhost
//  ✅ A3-4 — reportTaskCompletion(taskId, status): sends 'task_completed'
//  ✅ A6-1 — detectLoop(executionLog, currentStep, threshold=3): returns true
//            when the same action appears 3+ times in the last 10 entries
//  ✅ A6-2 — reportLoopDetected(taskId, step, log): broadcasts 'loop_detected'
//            to frontend + marks task paused_loop_detected in DB
//  ✅ A6-3 — executePlanWithFullStack(taskId, plan, executeStepFn, context):
//            human-activity-aware execution wrapper with per-step reporting
//            and automatic loop detection/abort
//  ✅ MSG  — check_human_activity handler: returns live isActive + timing data
//  ✅ MSG  — get_step_results handler: returns all steps for a task from DB
//  ✅ MSG  — test_loop_detection handler: smoke-tests detectLoop() is wired up
// ─────────────────────────────────────────────────────────────────────
//  ✅ FIX — load_file handler: returns HubtiqueFS blob as base64+mimeType
//           (required by task-executor.js upload_file step)
//  ✅ FIX — save_file handler: saves base64 payload into HubtiqueFS
//  ✅ FIX — select handler: selects dropdown option by label (resolveRef aware)
//  ✅ FIX — smart_find_act: added data_value strategy for NIC/govt portals
//           (matches input[type="submit"][value*="query"] — no aria-labels)
//  ✅ FIX — smart_find_act type subAction: was using el.textContent = val
//           (Bug 3 re-introduced here). Now uses execCommand('insertText')
//  ✅ FIX — mark_seen / get_seen_items handlers for recurring monitoring tasks
//  ✅ FIX — ping version updated to 12.0
// ─────────────────────────────────────────────────────────────────────
// CARRIED FROM v11.0 (unchanged, working well):
//  ✅ FIX 1  — setStorage/getStorage handlers for CometBrowser session persistence
//  ✅ FIX 2  — switchTab handler for multi-tab stack (go_back_tab support)
//  ✅ FIX 3  — navigate supports new_tab:true → pushes current tab to stack
//  ✅ FIX 4  — getContent/read_body: runs __hubtique_detectAuthError__ first
//  ✅ FIX 5  — submit: waits 2s after dispatch, auth-checks, returns SESSION_EXPIRED
//  ✅ FIX 6  — Loop guard MAX_STEPS raised to 200
//  ✅ FIX 7  — verify_page handler: confirms expected content + auth ok
//  ✅ FIX 8  — All auth errors bubble SESSION_EXPIRED code consistently
//  ✅ FIX 9  — getOrCreateTab: verifies tab still exists before reusing
//  ✅ FIX 10 — llm_generate action handler: direct AI text generation
//             without needing a browser tab (fixes "All LLM providers exhausted")
//  ✅ FIX 11 — Extension ID injected into Lovable/localhost tabs on load
//             so agent-planner.js can route callAI back through background
//  ✅ FIX 12 — rotation.js Pollinations fallback always fires as last resort
// ─────────────────────────────────────────────────────────────────────

import * as DB from "./src/db.js";
import { saveTaskStep, getTaskSteps, updateObjectStore } from "./src/db.js";
import { initProviders, saveApiKey, getProviderStats, callAI } from "./src/rotation.js";
import { setupAlarms, onAlarm, pollCycle, recoverStuckTasks } from "./src/scheduler.js";
import { flushPendingNotifications, postToUI } from "./src/notifier.js";
import { generatePlan } from "./src/agent-planner.js";
import { executeStep }  from "./src/task-executor.js";
// v14.0 — 5-phase architecture
import { understandTask }                                      from "./src/task-understanding.js";
import { createWorkflow, executeWorkflow, resumeWorkflow }     from "./src/workflow-engine.js";

// ─────────────────────────────────────────────────────────────────────
// STARTUP
// ─────────────────────────────────────────────────────────────────────
let _spawnStartupDone = false;

async function startup() {
  if (_spawnStartupDone) return;
  _spawnStartupDone = true;
  const { startup_complete } = await chrome.storage.local.get("startup_complete");
  if (startup_complete) {
    console.log("[BG v14.0] Service worker respawned");
    await DB.initDatabase();
    await initProviders();
    await setupAlarms();
    // v14.0: Resume any workflow that was running when SW was killed
    try {
      const { active_workflow } = await chrome.storage.local.get("active_workflow");
      if (active_workflow?.workflow_id && active_workflow?.status === 'running') {
        console.log(`[BG v14.0] 🔄 Resuming interrupted workflow: ${active_workflow.workflow_id}`);
        resumeWorkflow(active_workflow.workflow_id).catch(e =>
          console.error(`[BG v14.0] Resume failed: ${e.message}`)
        );
      }
    } catch (e) {
      console.warn(`[BG v14.0] Workflow resume check failed: ${e.message}`);
    }
    return;
  }
  console.log("[BG v14.0] Hubtique OS v14.0 starting…");
  await chrome.storage.local.set({ startup_complete: true });
  await DB.initDatabase();
  await initProviders();
  await recoverStuckTasks();
  await setupAlarms();
  await pollCycle();
  console.log("[BG v14.0] ✅ Ready");
}

chrome.runtime.onStartup.addListener(startup);
chrome.runtime.onInstalled.addListener(startup);
chrome.alarms.onAlarm.addListener(onAlarm);
startup().catch(e => console.error("[BG v13.1] Startup error:", e));

// ─────────────────────────────────────────────────────────────────────
// SERVICE WORKER KEEP-ALIVE (v13.2-FIXED)
// Chrome kills MV3 service workers after ~30s of inactivity.
// During a long agent run (navigate → AI call → execute = up to 60s per
// step), the SW dies mid-task and the next message gets
// "Receiving end does not exist".
//
// Fix: use chrome.alarms to fire every 25s and touch chrome.storage
// so Chrome sees the SW as active. The alarm fires even when the SW
// would otherwise sleep, keeping it alive for the duration of a task.
// ─────────────────────────────────────────────────────────────────────
chrome.alarms.create("keepAlive", { periodInMinutes: 0.4 }); // every 24s

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === "keepAlive") {
    // Touch storage — enough to keep SW awake
    chrome.storage.local.set({ _keepAlive: Date.now() });
  }
});

// ─────────────────────────────────────────────────────────────────────
// FILE MEMORY (IndexedDB)
// ─────────────────────────────────────────────────────────────────────
const FILE_STORE = "hubtique_files";

async function openFileDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("HubtiqueFS", 1);
    req.onupgradeneeded = e => e.target.result.createObjectStore(FILE_STORE);
    req.onsuccess = e => resolve(e.target.result);
    req.onerror = () => reject(req.error);
  });
}
async function saveFile(fileId, blob) {
  const db = await openFileDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(FILE_STORE, "readwrite");
    tx.objectStore(FILE_STORE).put(blob, fileId);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}
async function loadFile(fileId) {
  const db = await openFileDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(FILE_STORE, "readonly");
    const req = tx.objectStore(FILE_STORE).get(fileId);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

const pendingDownloads = new Map();
chrome.downloads.onCreated.addListener(item => {
  const fileId = `file_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  pendingDownloads.set(item.id, { fileId });
  chrome.storage.local.set({ lastDownloadFileId: fileId, lastDownloadId: item.id });
});
chrome.downloads.onChanged.addListener(async delta => {
  if (delta.state?.current === "complete") {
    const info = pendingDownloads.get(delta.id);
    if (info) {
      try {
        const items = await chrome.downloads.search({ id: delta.id });
        if (items[0]?.url) {
          const blob = await (await fetch(items[0].url)).blob();
          await saveFile(info.fileId, blob);
          await chrome.storage.local.set({
            [`fileReady_${info.fileId}`]: true,
            [`fileMime_${info.fileId}`]: blob.type,
          });
        }
      } catch (e) { console.warn("[BG v12.0] Download capture failed:", e); }
      pendingDownloads.delete(delta.id);
    }
  }
});

// ─────────────────────────────────────────────────────────────────────
// ACTIVE TAB HELPERS
// ─────────────────────────────────────────────────────────────────────
async function getActiveTab() {
  const d = await chrome.storage.local.get("activeAgentTabId");
  return d.activeAgentTabId || null;
}
async function setActiveTab(id) {
  await chrome.storage.local.set({ activeAgentTabId: id });
}

// ─────────────────────────────────────────────────────────────────────
// FIX 9 — GET OR CREATE ACTIVE TAB (verifies tab still alive)
// v13.2-FIXED: added requireExisting flag so read-only actions (getContent,
// screenshot, read_body) never create a new about:blank tab when none exists.
// Creating about:blank when no URL is known caused 45s content-script timeouts
// on steps 1-14 (content.js is not injected into about:blank).
// navigate() still passes requireExisting=false so it can create tabs freely.
// ─────────────────────────────────────────────────────────────────────
async function getOrCreateTab(url, requireExisting = false) {
  let tabId = await getActiveTab();
  if (tabId) {
    try {
      await chrome.tabs.get(tabId);
      return { tabId, created: false };
    } catch (_) {
      tabId = null;
    }
  }
  // FIX-B1: read-only actions return null rather than creating a useless tab
  if (requireExisting || !url) {
    return { tabId: null, created: false };
  }
  const newTab = await chrome.tabs.create({ url });
  await setActiveTab(newTab.id);
  return { tabId: newTab.id, created: true };
}

// ─────────────────────────────────────────────────────────────────────
// SNAPSHOT STORE
// ─────────────────────────────────────────────────────────────────────
let _lastSnapshotIndex = [];
let _lastSnapshotUrl   = "";

// ─────────────────────────────────────────────────────────────────────
// FIX 6 — LOOP GUARD (MAX_STEPS raised to 200)
// ─────────────────────────────────────────────────────────────────────
const _loopGuard = {
  lastActionKey: "",
  repeatCount:   0,
  stepCount:     0,
  recentActions: [],      // Bug 2 fix: sliding window of last 12 actionKeys
  MAX_STEPS:     80,      // v14.0: complex multi-site tasks need 40-80 steps (was 30)
  MAX_REPEATS:   3,
  MAX_CIRCULAR:  3,       // Bug 2 fix: same URL 3x in 12-step window = circular loop

  check(actionKey) {
    this.stepCount++;

    // Hard step budget
    if (this.stepCount > this.MAX_STEPS) {
      console.warn(`[BG v12.0] ⚠️ Hard step budget (${this.MAX_STEPS}) hit — stopping`);
      return { abort: true, reason: `hit_max_steps:${this.MAX_STEPS}` };
    }

    // Sliding window — keep last 12 actions
    this.recentActions.push(actionKey);
    if (this.recentActions.length > 12) this.recentActions.shift();

    // Consecutive repeat check — catches same action back-to-back
    if (actionKey === this.lastActionKey) {
      this.repeatCount++;
      if (this.repeatCount >= this.MAX_REPEATS) {
        console.warn(`[BG v12.0] ⚠️ Consecutive loop: "${actionKey}" x${this.repeatCount}`);
        return { abort: true, reason: `loop_detected:${actionKey}` };
      }
    } else {
      this.lastActionKey = actionKey;
      this.repeatCount   = 0;
    }

    // Bug 2 fix: circular navigate — catches A->B->A->B oscillation
    if (actionKey.startsWith("navigate:")) {
      const occurrences = this.recentActions.filter(a => a === actionKey).length;
      if (occurrences >= this.MAX_CIRCULAR) {
        console.warn(`[BG v12.0] ⚠️ Circular navigate: "${actionKey}" x${occurrences} in last ${this.recentActions.length} steps`);
        return { abort: true, reason: `circular_navigate:${actionKey}` };
      }
    }

    return { abort: false };
  },

  reset() {
    this.lastActionKey = "";
    this.repeatCount   = 0;
    this.stepCount     = 0;
    this.recentActions = [];
  },
};

// ─────────────────────────────────────────────────────────────────────
// v13 — HUMAN ACTIVITY MONITOR (Agent 4)
// ─────────────────────────────────────────────────────────────────────

// In-memory state updated by content.js human_activity messages.
const humanActivityState = {
  isActive:         false,
  lastActivityTime: Date.now(),
  lastPosition:     null,
};

// Dedicated message listener for human_activity reports from content.js.
// Lives outside handleMessage() so it fires even if the main handler
// returns early on an unrelated action.
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action !== "human_activity") return; // let other listeners handle the rest

  humanActivityState.lastActivityTime = request.timestamp || Date.now();
  humanActivityState.isActive         = true;
  humanActivityState.lastPosition     = request.position || null;

  console.log(`[ACTIVITY] ${request.type}${request.position ? ` at (${request.position.x}, ${request.position.y})` : ""}`);

  // Reset isActive flag after 5 s of silence
  setTimeout(() => {
    const elapsed = Date.now() - humanActivityState.lastActivityTime;
    if (elapsed >= 5000) humanActivityState.isActive = false;
  }, 5100);

  sendResponse({ received: true });
  return true;
});

// Query the active tab's content script to check if the human is active.
// Falls back to the in-memory state if the content script doesn't respond
// (e.g. tab is still loading, or it's an internal chrome:// page).
async function isHumanUsingBrowser() {
  // Fast path: in-memory state already says inactive
  if (!humanActivityState.isActive &&
      (Date.now() - humanActivityState.lastActivityTime) >= 5000) {
    return false;
  }

  // Ask the active tab's content script for a fresh reading
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs || !tabs[0]) return resolve(humanActivityState.isActive);
      chrome.tabs.sendMessage(
        tabs[0].id,
        { action: "check_human_activity" },
        (response) => {
          if (chrome.runtime.lastError || !response) {
            // Content script not available — fall back to in-memory state
            return resolve(humanActivityState.isActive);
          }
          // Sync in-memory state from the freshest data the content script has
          if (response.lastActivityTime > humanActivityState.lastActivityTime) {
            humanActivityState.lastActivityTime = response.lastActivityTime;
          }
          resolve(response.isActive);
        }
      );
    });
  });
}

// Poll until the human stops, then resolve.
// Yields every 500 ms to keep the service worker alive.
async function waitForHumanToStop() {
  console.log("[WAIT] Human is active — waiting before next agent step…");
  while (await isHumanUsingBrowser()) {
    await new Promise(r => setTimeout(r, 500));
  }
  console.log("[WAIT] Human stopped, resuming task");
}

// ─────────────────────────────────────────────────────────────────────
// v13 — STEP REPORTING (Agent 3)
// ─────────────────────────────────────────────────────────────────────

// Lovable frontend URL pattern — tabs matching this receive step_completed
// / task_completed / loop_detected messages so the dashboard can update
// in real-time without polling.
const FRONTEND_URL_PATTERNS = ["*://*.lovable.app/*", "http://localhost:*/*"];

// Broadcast a message to all open frontend (Lovable/localhost) tabs.
async function sendToFrontendTabs(message) {
  try {
    const tabs = await chrome.tabs.query({ url: FRONTEND_URL_PATTERNS });
    let sent = 0;
    for (const tab of tabs) {
      try {
        await chrome.tabs.sendMessage(tab.id, message);
        sent++;
      } catch (_) {
        // Tab may have navigated away — non-fatal
      }
    }
    console.log(`[REPORTER] Sent to ${sent} frontend tab(s):`, message.action);
  } catch (e) {
    console.warn("[REPORTER] sendToFrontendTabs error:", e.message);
  }
}

// Build a human-readable "why" string from an action name + raw result.
function generateReasoning(action, result) {
  if (!result) return `Executed: ${action}`;
  const r = typeof result === "string" ? result : JSON.stringify(result);

  switch (action) {
    case "navigate":
      return `Navigated to ${r.replace(/.*"(https?[^"]+)".*/s, "$1").substring(0, 80)}`;
    case "read_body":
      return `Read page body (${(r.length || 0)} chars)`;
    case "click":
      return `Clicked: ${r.substring(0, 60)}`;
    case "type":
      return `Typed into field (${r.length || 0} chars)`;
    case "llm_generate":
      return `Generated ${r.length || 0} chars of text`;
    case "extract":
      return `Extracted: ${r.substring(0, 80)}`;
    case "submit":
      return "Submitted form";
    case "scroll":
      return `Scrolled page`;
    case "wait":
      return `Waited as requested`;
    default:
      return `${action}: ${r.substring(0, 80)}`;
  }
}

// Persist a step report to IndexedDB and broadcast it to open frontend tabs.
// outcome = { status, result, found, duration, error, attempt }
async function reportStepCompletion(taskId, step, outcome) {
  const report = {
    taskId,
    stepId:    step.id,
    action:    step.action,
    status:    outcome.status,            // "success" | "failed"
    found:     outcome.found || outcome.result || null,
    reasoning: generateReasoning(step.action, outcome.result),
    duration:  outcome.duration || 0,
    error:     outcome.error || null,
    attempt:   outcome.attempt || 1,
    timestamp: Date.now(),
  };

  // Persist to IndexedDB
  try {
    await saveTaskStep(taskId, report);
  } catch (e) {
    console.warn("[REPORTER] saveTaskStep failed:", e.message);
  }

  // Broadcast to dashboard
  await sendToFrontendTabs({ action: "step_completed", report });

  console.log(`[REPORTER] Step ${step.id}: ${outcome.status} | ${step.action} | ${outcome.duration || 0}ms`);
}

// Broadcast task-level completion (success / failed / loop_aborted).
async function reportTaskCompletion(taskId, status, extra = {}) {
  const report = { taskId, status, timestamp: Date.now(), ...extra };
  await sendToFrontendTabs({ action: "task_completed", report });
  console.log(`[REPORTER] Task ${taskId} → ${status}`);
}

// ─────────────────────────────────────────────────────────────────────
// v13 — LOOP DETECTION (Agent 6)
// ─────────────────────────────────────────────────────────────────────

// Returns true if the EXACT SAME action+url+label combo appears ≥ threshold times
// in the last 10 entries of executionLog.
// v14.0 fix: was checking action type only — read_body appearing 3× on different
// sites (multi-site task) falsely triggered loop abort. Now checks full fingerprint.
function detectLoop(executionLog, currentStep, threshold = 3) {
  if (!executionLog || executionLog.length === 0) return false;
  const recent = executionLog.slice(-10);
  // Build a fingerprint: action + url (if navigate) + label (if click/type)
  const fingerprint = [
    currentStep.action,
    currentStep.url   || '',
    currentStep.label || '',
  ].join('|');
  const sameActions = recent.filter(r => {
    const rf = [r.action, r.url || '', r.label || ''].join('|');
    return rf === fingerprint;
  });
  if (sameActions.length >= threshold) {
    console.warn(
      `[LOOP] Detected: fingerprint "${fingerprint}" appears ` +
      `${sameActions.length}x in the last ${recent.length} steps`
    );
    return true;
  }
  return false;
}

// Persist loop-detected event to DB and broadcast to frontend.
async function reportLoopDetected(taskId, step, executionLog) {
  console.error(`[LOOP] Infinite loop on task ${taskId}, step ${step.id} (${step.action})`);

  // Snapshot the last 5 actions for the frontend to display
  const recentActions = (executionLog || []).slice(-5).map(r => r.action);

  await sendToFrontendTabs({
    action: "loop_detected",
    taskId,
    step,
    recentActions,
  });

  try {
    await DB.updateTask(taskId, {
      status:     "paused_loop_detected",
      last_error: `Loop detected: "${step.action}" repeated 3+ times`,
    });
  } catch (e) {
    console.warn("[LOOP] Could not update task status in DB:", e.message);
  }
}

// ─────────────────────────────────────────────────────────────────────
// v13 — FULL STACK EXECUTOR (Agent 4 + 3 + 6 combined)
// executeTaskWithFullStack wraps the per-step execution cycle with:
//   1. Human activity check → pause if needed
//   2. Step execute (passed in as executeStepFn callback)
//   3. Report step completion to frontend
//   4. Loop detection → abort if triggered
//
// Parameters:
//   taskId          — string
//   plan            — { steps: Array<{ id, action, params }> }
//   executeStepFn   — async (step, context) => { status, result, found, duration, error }
//   context         — shared mutable object passed through to executeStepFn
// ─────────────────────────────────────────────────────────────────────
async function executePlanWithFullStack(taskId, plan, executeStepFn, context = {}) {
  const results = [];

  for (const step of (plan.steps || [])) {
    // ── 1. Yield to human if browser is in use ──────────────────
    if (await isHumanUsingBrowser()) {
      console.log(`[EXEC] Human active before step ${step.id} — waiting…`);
      await waitForHumanToStop();
    }

    // ── 2. Execute the step (with retry up to 3×) ───────────────
    let outcome = { status: "failed", error: "Not executed" };
    for (let attempt = 1; attempt <= 3; attempt++) {
      const start = Date.now();
      try {
        const raw = await executeStepFn(step, context);
        // Merge saved context variables into shared context so subsequent
        // steps (e.g. llm_generate) can access page_body from read_body.
        if (raw?.saved && typeof raw.saved === 'object') {
          Object.assign(context, raw.saved);
        }
        if (raw?.body)      context.page_body   = raw.body;
        if (raw?.text)      context.llm_result  = raw.text;
        if (raw?.navigated) context.current_url = raw.navigated;
        outcome = {
          status:   "success",
          result:   raw?.result ?? raw,
          found:    raw?.found  ?? null,
          duration: Date.now() - start,
          attempt,
        };
        break; // success — stop retrying
      } catch (e) {
        outcome = {
          status:   "failed",
          error:    e.message,
          duration: Date.now() - start,
          attempt,
        };
        if (attempt < 3) {
          await new Promise(r => setTimeout(r, 1500 * attempt));
        }
      }
    }

    results.push({ step: step.id, action: step.action, ...outcome });

    // ── 3. Report to frontend ───────────────────────────────────
    await reportStepCompletion(taskId, step, outcome);

    // ── 4. Loop detection ───────────────────────────────────────
    if (detectLoop(results, step)) {
      await reportLoopDetected(taskId, step, results);
      await reportTaskCompletion(taskId, "loop_aborted");
      return { success: false, abortedByLoop: true, results };
    }

    // Stop processing if the step itself fatally failed after all retries
    if (outcome.status === "failed" && step.required !== false) {
      console.error(`[EXEC] Required step ${step.id} (${step.action}) failed — aborting plan`);
      break;
    }
  }

  const allOk = results.every(r => r.status === "success");
  await reportTaskCompletion(taskId, allOk ? "completed" : "failed");
  return { success: allOk, results };
}

// ─────────────────────────────────────────────────────────────────────
// EXECUTE IN TAB HELPER
// ─────────────────────────────────────────────────────────────────────
async function execInTab(tabId, fn, args = []) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: fn,
    args,
  });
  return results?.[0]?.result;
}

// ─────────────────────────────────────────────────────────────────────
// WAIT FOR PAGE SETTLE (ChatGPT-aware)
// ─────────────────────────────────────────────────────────────────────
const CHATGPT_HOSTS = ["chatgpt.com", "chat.openai.com"];

const JS_HEAVY_HOSTS = ["reddit.com","twitter.com","x.com","linkedin.com","notion.so"];
async function waitForPageSettle(tabId, url = "", extraMs = 1000) {
  const isChatGPT = CHATGPT_HOSTS.some(h => (url || "").includes(h));
  const isJSHeavy = JS_HEAVY_HOSTS.some(h => (url||"").includes(h));
  const settle = isChatGPT ? extraMs + 5000 : isJSHeavy ? extraMs + 3500 : extraMs;

  await new Promise(resolve => {
    const timeout = setTimeout(resolve, 12000);
    function listener(tId, info) {
      if (tId === tabId && info.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener);
        clearTimeout(timeout);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then(tab => {
      if (tab.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener);
        clearTimeout(timeout);
        resolve();
      }
    }).catch(() => {});
  });
  await new Promise(r => setTimeout(r, settle));
}

// ─────────────────────────────────────────────────────────────────────
// FIX 4 — AUTH CHECK HELPER
// Runs __hubtique_detectAuthError__ in tab, returns result
// ─────────────────────────────────────────────────────────────────────
async function checkTabAuth(tabId) {
  try {
    const result = await execInTab(tabId, () => {
      if (typeof window.__hubtique_detectAuthError__ !== "function") return null;
      return window.__hubtique_detectAuthError__();
    });
    return result; // { isAuthError, details } or null
  } catch (_) {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────
// MESSAGE ROUTER
// ─────────────────────────────────────────────────────────────────────
async function handleMessage(request, sendResponse) {
  const { action } = request;

  // ── Health check ─────────────────────────────────────────────────
  if (action === "ping") {
    sendResponse({ success: true, status: "Active", version: "13.0" });
    return;
  }

  // ── AI call ──────────────────────────────────────────────────────
  if (action === "callAI") {
    try {
      const { text, provider } = await callAI(request.messages, request.taskId || null);
      sendResponse({ success: true, text, provider });
    } catch (e) {
      console.error("[BG v12.0] callAI error:", e.message);
      sendResponse({ success: false, error: e.message, code: e.code || "AI_ERROR" });
    }
    return;
  }

  // ── Loop guard ───────────────────────────────────────────────────
  if (action === "resetLoopGuard") {
    _loopGuard.reset();
    sendResponse({ success: true });
    return;
  }

  if (action === "checkLoopGuard") {
    const result = _loopGuard.check(request.actionKey || "");
    sendResponse({ success: true, ...result });
    return;
  }

  // ── FIX 1: Generic key-value storage for CometBrowser session ────
  if (action === "setStorage") {
    try {
      if (request.value === null || request.value === undefined) {
        await chrome.storage.local.remove(request.key);
      } else {
        await chrome.storage.local.set({ [request.key]: request.value });
      }
      sendResponse({ success: true });
    } catch (e) {
      sendResponse({ success: false, error: e.message });
    }
    return;
  }

  if (action === "getStorage") {
    try {
      const data = await chrome.storage.local.get(request.key);
      sendResponse({ success: true, data: { value: data[request.key] ?? null } });
    } catch (e) {
      sendResponse({ success: false, error: e.message });
    }
    return;
  }

  // ── FIX 2: Switch to a specific tab (multi-tab stack support) ────
  if (action === "switchTab") {
    try {
      await chrome.tabs.update(request.tabId, { active: true });
      await setActiveTab(request.tabId);
      sendResponse({ success: true, tabId: request.tabId });
    } catch (e) {
      sendResponse({ success: false, error: e.message });
    }
    return;
  }

  // ── Task Queue ───────────────────────────────────────────────────
  if (action === "createTask") {
    try {
      const taskId = await DB.createTask(request.definition);
      _loopGuard.reset();
      await pollCycle();
      sendResponse({ success: true, taskId });
    } catch (e) { sendResponse({ success: false, error: e.message }); }
    return;
  }

  if (action === "getQueue") {
    try {
      const allTasks = await DB.getAllTasks();
      sendResponse({
        success: true,
        tasks: allTasks,
        data: {
          running: allTasks.filter(t => t.status === "running"),
          queued:  allTasks.filter(t => t.status === "queued"),
          done:    allTasks.filter(t => t.status === "completed"),
        }
      });
    } catch (e) { sendResponse({ success: false, error: e.message }); }
    return;
  }

  if (action === "getTask") {
    try {
      const task = await DB.getTask(request.taskId);
      sendResponse({ success: true, task });
    } catch (e) { sendResponse({ success: false, error: e.message }); }
    return;
  }

  if (action === "pauseTask") {
    await DB.updateTask(request.taskId, { status: "paused_waiting", next_retry_time: null, paused_manually: true });
    sendResponse({ success: true });
    return;
  }

  if (action === "resumeTask") {
    await DB.updateTask(request.taskId, { status: "queued", next_retry_time: Date.now(), paused_manually: false });
    await pollCycle();
    sendResponse({ success: true });
    return;
  }

  if (action === "cancelTask") {
    await DB.updateTask(request.taskId, { status: "failed", last_error: "Cancelled by user" });
    await DB.clearCheckpoints(request.taskId);
    sendResponse({ success: true });
    return;
  }

  if (action === "getExecutionLog") {
    const log = await DB.getExecutionLog(request.taskId);
    sendResponse({ success: true, log });
    return;
  }

  // ── Provider / Key Management ────────────────────────────────────
  if (action === "saveApiKey") {
    try {
      // v13 FIX: Lovable UI may send display name instead of provider ID
      const providerId = request.providerId || request.provider || request.name || "";
      await saveApiKey(providerId, request.apiKey);
      
      const waiting = await DB.getTasksByStatus("paused_waiting");
      for (const task of waiting) {
        if (!task.paused_manually) {
          await DB.updateTask(task.id, { status: "queued", next_retry_time: Date.now() });
        }
      }
      await pollCycle();
      sendResponse({ success: true, message: `API key saved successfully.` });
    } catch (e) {
      console.error("[BG v13] saveApiKey error:", e.message);
      sendResponse({ success: false, error: e.message });
    }
    return;
  }

  if (action === "getProviderStats") {
    const stats = await getProviderStats();
    sendResponse({ success: true, stats });
    return;
  }

  if (action === "getApiKey") {
    const storageKey = `apiKey_${request.providerId}`;
    const data = await chrome.storage.local.get(storageKey);
    sendResponse({ success: true, data: { apiKey: data[storageKey] || null } });
    return;
  }

  // ── Notifications ────────────────────────────────────────────────
  if (action === "getNotifications") {
    const notifs = await DB.getUnshownNotifications();
    sendResponse({ success: true, notifications: notifs });
    return;
  }

  if (action === "dismissNotification") {
    await DB.dismissNotification(request.notificationId);
    sendResponse({ success: true });
    return;
  }

  // ═══════════════════════════════════════════════════════════════════
  // BROWSER AUTOMATION ACTIONS
  // ═══════════════════════════════════════════════════════════════════

  // ── NAVIGATE — FIX 3: new_tab:true support ───────────────────────
  if (action === "navigate") {
    _lastSnapshotIndex = [];
    _lastSnapshotUrl   = "";

    let tabId = await getActiveTab();

    // FIX 3: if new_tab requested, create a new tab and push current to storage
    // (Tab stack management happens in CometBrowser via pushTab/popTab)
    if (request.new_tab && tabId) {
      try {
        const newTab = await chrome.tabs.create({ url: request.url });
        await setActiveTab(newTab.id);
        await waitForPageSettle(newTab.id, request.url, 1200);
        _lastSnapshotUrl   = request.url;
        _lastSnapshotIndex = []; // FIX: clear stale elements after navigation
        sendResponse({ success: true, tabId: newTab.id, prevTabId: tabId });
      } catch (e) {
        sendResponse({ success: false, error: e.message });
      }
      return;
    }

    const beforeTab = tabId ? await chrome.tabs.get(tabId).catch(() => null) : null;
    const beforeUrl = beforeTab?.url || "";
    const targetUrl = request.url || "";
    const targetHost = (() => { try { return new URL(targetUrl).hostname.replace(/^www\./, ""); } catch { return ""; } })();

    try {
      if (tabId) {
        await chrome.tabs.update(tabId, { url: request.url });
      } else {
        const newTab = await chrome.tabs.create({ url: request.url });
        tabId = newTab.id;
        await setActiveTab(tabId);
      }
      await waitForPageSettle(tabId, request.url, 1200);
      const afterTab = await chrome.tabs.get(tabId).catch(() => null);
      const afterUrl = afterTab?.url || "";
      const afterHost = (() => { try { return new URL(afterUrl).hostname.replace(/^www\./, ""); } catch { return ""; } })();
      const hostChanged = targetHost ? afterHost.includes(targetHost) : (afterUrl !== beforeUrl);
      if (!hostChanged) {
        sendResponse({
          success: false,
          error: "NAVIGATE_NOT_EFFECTIVE",
          before_url: beforeUrl,
          target_url: targetUrl,
          after_url: afterUrl,
          expected: targetUrl,
          actual: afterUrl,
          failure_reason: "HOST_NOT_CHANGED_AS_EXPECTED",
        });
        return;
      }
      _lastSnapshotUrl   = afterUrl;
      _lastSnapshotIndex = []; // FIX: clear stale elements after navigation
      sendResponse({ success: true, tabId, navigatedUrl: afterUrl, before_url: beforeUrl, target_url: targetUrl, after_url: afterUrl, success_reason: "NAVIGATION_CONFIRMED" });
    } catch (e) {
      try {
        const t = await chrome.tabs.create({ url: request.url });
        await setActiveTab(t.id);
        await waitForPageSettle(t.id, request.url, 1200);
        _lastSnapshotUrl   = request.url;
        _lastSnapshotIndex = []; // FIX: clear stale elements after navigation
        sendResponse({ success: true, tabId: t.id, navigatedUrl: request.url });
      } catch (e2) {
        sendResponse({ success: false, error: e2.message });
      }
    }
    return;
  }

  // ── GET CONTENT — FIX 4: auth check before returning ─────────────
  if (action === "getContent") {
    // FIX-B2: requireExisting=true — if no agent tab exists yet, return
    // empty context immediately instead of creating about:blank and hanging 45s.
    const { tabId } = await getOrCreateTab(null, true);
    if (!tabId) {
      sendResponse({
        success: true,
        data: { tree: "", body: "", url: "about:blank", title: "", index: [] }
      });
      return;
    }

    // FIX 4: auth check first
    const authCheck = await checkTabAuth(tabId);
    if (authCheck?.isAuthError) {
      console.warn("[BG v12.0] getContent: auth error detected", authCheck.details);
      sendResponse({
        success: false,
        error: "Session expired — on login page, not content page",
        code: "SESSION_EXPIRED",
        details: authCheck.details,
      });
      return;
    }

    // FIX-STALE: clear stale snapshot so click/type always use fresh elements
    _lastSnapshotIndex = [];

    const result = await execInTab(tabId, async () => {
      if (typeof window.__omni_snapshot__ !== "function") {
        return {
          snapshot: "", index: [],
          body: document.body?.innerText?.substring(0, 12000) || "",
          url: location.href, title: document.title,
        };
      }
      // __omni_snapshot__ is async (auto-dismisses popups then settles)
      return await window.__omni_snapshot__();
    });

    if (result) {
      _lastSnapshotIndex = result.index || [];
      _lastSnapshotUrl   = result.url;
    }

    sendResponse({
      success: true,
      data: {
        tree:  result?.snapshot || "",
        body:  result?.body    || "",
        url:   result?.url     || "",
        title: result?.title   || "",
        index: result?.index   || [],
      }
    });
    return;
  }

  // ── READ BODY — FIX 4: auth check before returning ───────────────
  if (action === "read_body") {
    const { tabId } = await getOrCreateTab(null, true);
    if (!tabId) { sendResponse({ success: false, error: "No active tab — navigate first before read_body" }); return; }

    // FIX 4: auth check first
    const authCheck = await checkTabAuth(tabId);
    if (authCheck?.isAuthError) {
      console.warn("[BG v12.0] read_body: auth error detected");
      sendResponse({
        success: false,
        error: "Session expired during read_body",
        code: "SESSION_EXPIRED",
        details: authCheck.details,
      });
      return;
    }

    const result = await execInTab(tabId, () => ({
      success: true,
      text:  document.body?.innerText || "",
      html:  document.body?.innerHTML?.substring(0, 50000) || "",
      url:   location.href,
      title: document.title,
    }));

    sendResponse({
      success: true,
      text:  result?.text  || "",
      html:  result?.html  || "",
      url:   result?.url   || "",
      title: result?.title || "",
    });
    return;
  }

  // ── GET SNAPSHOT ─────────────────────────────────────────────────
  if (action === "getSnapshot") {
    const { tabId } = await getOrCreateTab();
    if (!tabId) { sendResponse({ success: false, error: "No active tab" }); return; }

    const result = await execInTab(tabId, async () => {
      if (typeof window.__omni_snapshot__ === "function") return await window.__omni_snapshot__();
      return { snapshot: "", index: [], body: "", url: location.href, title: document.title };
    });

    _lastSnapshotIndex = result?.index || [];
    sendResponse({
      success: true,
      snapshot: result?.snapshot || "",
      index:    result?.index    || [],
      url:      result?.url      || "",
      body:     result?.body     || "",
    });
    return;
  }

  async function getFreshSnapshotForAction(tabId) {
    const snap = await execInTab(tabId, async () => {
      if (typeof window.__omni_snapshot__ === "function") return await window.__omni_snapshot__();
      return { snapshot: "", index: [], body: "", url: location.href, title: document.title };
    });
    _lastSnapshotIndex = snap?.index || [];
    _lastSnapshotUrl   = snap?.url || _lastSnapshotUrl;
    return _lastSnapshotIndex;
  }

  // ── FIX 7: VERIFY PAGE ───────────────────────────────────────────
  // Checks auth + optionally verifies expected keywords present
  if (action === "verify_page") {
    const { tabId } = await getOrCreateTab();
    if (!tabId) { sendResponse({ success: false, error: "No active tab" }); return; }

    const authCheck = await checkTabAuth(tabId);
    if (authCheck?.isAuthError) {
      sendResponse({
        success: false,
        error: "Not authenticated — on login page",
        code: "SESSION_EXPIRED",
      });
      return;
    }

    const keywords = request.expected_content_keywords || [];
    if (keywords.length > 0) {
      const bodyResult = await execInTab(tabId, (kws) => {
        const body = (document.body.innerText || "").toLowerCase();
        return kws.some(kw => body.includes(kw.toLowerCase()));
      }, [keywords]);

      if (!bodyResult) {
        sendResponse({
          success: false,
          error: `Page content doesn't match expected keywords: ${keywords.join(", ")}`,
          code: "PAGE_MISMATCH",
        });
        return;
      }
    }

    sendResponse({ success: true, verified: true });
    return;
  }

  // ── CLICK ────────────────────────────────────────────────────────
  if (action === "click") {
    const { tabId } = await getOrCreateTab();
    if (!tabId) { sendResponse({ success: false, error: "No active tab" }); return; }

    const freshIndex = await getFreshSnapshotForAction(tabId);
    const targetRef = resolveRef(request.label || request.target_id, freshIndex);

    const result = await execInTab(tabId,
      (ref, snapshotIndex) => {
        if (typeof window.__omni_act__ !== "function") {
          const label = ref.replace(/^@e\d+$/, "").toLowerCase();
          const els = Array.from(document.querySelectorAll(
            'button,a[href],[role="button"],[role="link"],[role="menuitem"]'
          ));
          const el = els.find(e =>
            (e.innerText || e.getAttribute("aria-label") || e.getAttribute("title") || "")
              .toLowerCase().includes(label)
          );
          if (!el) return { success: false, error: `Element not found: "${ref}"` };
          el.scrollIntoView({ behavior: "smooth", block: "center" });
          el.click();
          return { success: true, method: "fallback_text_match" };
        }
        return window.__omni_act__("click", ref, null, snapshotIndex, request.label || request.target_id || "");
      },
      [targetRef, freshIndex]
    );

    sendResponse(result || { success: false, error: "Script failed" });
    return;
  }

  // ── TYPE ─────────────────────────────────────────────────────────
  if (action === "type") {
    const { tabId } = await getOrCreateTab();
    if (!tabId) { sendResponse({ success: false, error: "No active tab" }); return; }

    const freshIndex = await getFreshSnapshotForAction(tabId);
    const targetRef = resolveRef(request.label || request.target_id, freshIndex);

    const result = await execInTab(tabId,
      async (ref, value, snapshotIndex) => {
        if (typeof window.__omni_act__ !== "function") {
          const inputs = Array.from(document.querySelectorAll('input:not([type="hidden"]),textarea,[contenteditable="true"]'));
          const el = inputs[0];
          if (!el) return { success: false, error: "No input found (fallback)" };
          el.focus();
          if (el.isContentEditable) el.textContent = value;
          else el.value = value;
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          return { success: true, typed: value.length, method: "fallback" };
        }
        return window.__omni_act__("type", ref, value, snapshotIndex, request.label || request.target_id || "");
      },
      [targetRef, request.value || "", freshIndex]
    );

    sendResponse(result || { success: false, error: "Script failed" });
    return;
  }

  // ── SUBMIT — FIX 5: wait + auth check after submit ───────────────
  if (action === "submit") {
    const { tabId } = await getOrCreateTab();
    if (!tabId) { sendResponse({ success: false, error: "No active tab" }); return; }

    const freshIndex = await getFreshSnapshotForAction(tabId);
    const targetRef = resolveRef(request.label || request.target_id, freshIndex);

    const beforeSubmitTab = await chrome.tabs.get(tabId).catch(() => null);
    const beforeSubmitUrl = beforeSubmitTab?.url || "";
    const dispatchResult = await execInTab(tabId,
      (ref, snapshotIndex) => {
        if (typeof window.__omni_act__ === "function") {
          const r = window.__omni_act__("submit", ref, null, snapshotIndex, request.label || request.target_id || "");
          if (r && r.success) return r;
        }
        // Fallback: active element Enter
        const el = document.activeElement || document.querySelector("input,textarea");
        if (el) {
          el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", keyCode: 13, bubbles: true, cancelable: true }));
          el.dispatchEvent(new KeyboardEvent("keyup",   { key: "Enter", keyCode: 13, bubbles: true }));
          if (el.form) el.form.requestSubmit?.();
        }
        return { success: true, method: "fallback_active_element" };
      },
      [targetRef, freshIndex]
    );

    if (!dispatchResult?.success) {
      sendResponse(dispatchResult || { success: false, error: "Submit dispatch failed" });
      return;
    }

    // FIX 5: wait 2s for page to settle after submit
    await new Promise(r => setTimeout(r, 2000));

    const afterSubmitTab = await chrome.tabs.get(tabId).catch(() => null);
    const afterSubmitUrl = afterSubmitTab?.url || "";
    if (beforeSubmitUrl && afterSubmitUrl && beforeSubmitUrl === afterSubmitUrl) {
      sendResponse({
        success: false,
        code: "SEARCH_SUBMIT_NOT_EFFECTIVE",
        error: "Submit action completed but URL did not change",
        before_url: beforeSubmitUrl,
        after_url: afterSubmitUrl,
      });
      return;
    }

    // FIX 5: auth check after submit
    const authCheck = await checkTabAuth(tabId);
    if (authCheck?.isAuthError) {
      console.warn("[BG v12.0] submit: redirected to login page");
      sendResponse({
        success: false,
        error: "Session expired or authentication required after submit",
        code: "SESSION_EXPIRED",
        details: authCheck.details,
      });
      return;
    }

    sendResponse({ success: true });
    return;
  }

  // ── EXTRACT ──────────────────────────────────────────────────────
  if (action === "extract") {
    const { tabId } = await getOrCreateTab();
    if (!tabId) { sendResponse({ success: false, error: "No active tab" }); return; }

    const targetRef = resolveRef(request.target_id || request.label, _lastSnapshotIndex);

    const result = await execInTab(tabId,
      (ref, snapshotIndex) => {
        if (typeof window.__omni_snapshot__ === "function") window.__omni_snapshot__();
        if (typeof window.__omni_act__ === "function") {
          return window.__omni_act__("extract", ref, null, snapshotIndex);
        }
        return { success: false, error: "Content script not loaded" };
      },
      [targetRef, _lastSnapshotIndex]
    );

    sendResponse(result || { success: false, error: "Script failed" });
    return;
  }

  // ── SCROLL ───────────────────────────────────────────────────────
  if (action === "scroll") {
    const { tabId } = await getOrCreateTab();
    if (!tabId) { sendResponse({ success: false, error: "No active tab" }); return; }
    await execInTab(tabId,
      (dir, amt) => {
        window.scrollBy({ top: dir === "up" ? -amt : amt, behavior: "smooth" });
        return { success: true };
      },
      [request.direction || "down", request.amount || 400]
    );
    sendResponse({ success: true });
    return;
  }

  // ── WAIT ─────────────────────────────────────────────────────────
  if (action === "wait") {
    const ms = Math.min(request.seconds || 2, 60) * 1000;
    await new Promise(r => setTimeout(r, ms));
    sendResponse({ success: true, waited: request.seconds || 2 });
    return;
  }

  // ── WAIT_FOR ─────────────────────────────────────────────────────
  if (action === "wait_for") {
    const { tabId } = await getOrCreateTab();
    if (!tabId) { sendResponse({ success: false, error: "No active tab" }); return; }
    const timeout = request.timeout_ms || 10000;
    const start   = Date.now();
    const poll = async () => {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        args: [request.selector || request.text],
        func: sel => {
          if (document.querySelector(sel)) return true;
          return (document.body.innerText || "").includes(sel);
        },
      });
      if (results?.[0]?.result) {
        sendResponse({ success: true, found: true });
      } else if (Date.now() - start < timeout) {
        setTimeout(poll, 500);
      } else {
        sendResponse({ success: false, error: `Not found after ${timeout}ms: ${request.selector || request.text}` });
      }
    };
    poll();
    return;
  }

  // ── SCREENSHOT ───────────────────────────────────────────────────
  // FIX-B4: captureVisibleTab() captures the currently-focused tab, which
  // may be a human's tab. We switch to the agent tab, capture, then optionally
  // restore — but since we want the agent to work in its own tab anyway, we
  // just ensure the agent tab is focused before capturing.
  if (action === "screenshot") {
    try {
      const { tabId } = await getOrCreateTab(null, true);
      if (!tabId) { sendResponse({ success: false, error: "No active tab" }); return; }
      // Focus the agent tab so captureVisibleTab captures the right window
      await chrome.tabs.update(tabId, { active: true }).catch(() => {});
      const imageData = await chrome.tabs.captureVisibleTab(null, { format: "jpeg", quality: 75 });
      sendResponse({ success: true, data: { imageData } });
    } catch (e) {
      sendResponse({ success: false, error: e.message });
    }
    return;
  }

  // ── UPLOAD ───────────────────────────────────────────────────────
  if (action === "upload") {
    const { tabId } = await getOrCreateTab();
    const blob = await loadFile(request.file_id).catch(() => null);
    if (!blob) { sendResponse({ success: false, error: `File ${request.file_id} not found` }); return; }
    const uint8     = Array.from(new Uint8Array(await blob.arrayBuffer()));
    const targetRef = resolveRef(request.target_id, _lastSnapshotIndex);

    const result = await execInTab(tabId,
      (ref, snapshotIndex, bytes, mime, name) => {
        const item = (snapshotIndex || []).find(i => i.ref === ref);
        if (!item) return { success: false, error: `No file input: ${ref}` };
        const el = document.evaluate(item.xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
        if (!el || el.type !== "file") return { success: false, error: `Not a file input: ${ref}` };
        const file = new File([new Uint8Array(bytes)], name, { type: mime });
        const dt   = new DataTransfer();
        dt.items.add(file);
        el.files = dt.files;
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return { success: true, fileName: name };
      },
      [targetRef, _lastSnapshotIndex, uint8, blob.type, request.file_name || `file_${Date.now()}`]
    );
    sendResponse(result || { success: false });
    return;
  }

  // ── LOAD_FILE — v12.0 ─────────────────────────────────────────────
  // Returns a file from HubtiqueFS as base64 + mimeType so that
  // task-executor.js upload_file step can inject it into a page via
  // scripting.executeScript (which cannot transfer Blob objects directly).
  if (action === "load_file") {
    try {
      const blob = await loadFile(request.fileId);
      if (!blob) {
        sendResponse({ success: false, error: `File not found: ${request.fileId}` });
        return;
      }
      // Read mimeType from storage (set by download capture listener)
      const mimeData = await chrome.storage.local.get(`fileMime_${request.fileId}`);
      const mimeType = mimeData[`fileMime_${request.fileId}`] || blob.type || "application/octet-stream";

      // Convert blob → base64 string for transport across scripting boundary
      const arrayBuffer = await blob.arrayBuffer();
      const uint8       = new Uint8Array(arrayBuffer);
      let binary = "";
      const chunkSize = 8192;
      for (let i = 0; i < uint8.length; i += chunkSize) {
        binary += String.fromCharCode(...uint8.subarray(i, i + chunkSize));
      }
      const base64 = btoa(binary);

      sendResponse({ success: true, base64, mimeType, fileId: request.fileId });
    } catch (e) {
      console.error("[BG v12.0] load_file error:", e.message);
      sendResponse({ success: false, error: e.message });
    }
    return;
  }

  // ── SAVE_FILE — v12.0 ─────────────────────────────────────────────
  // Saves a base64 payload into HubtiqueFS and returns a fileId.
  // Used by tasks that generate files (e.g. video pipeline) and need
  // to store them before the upload_file step runs.
  if (action === "save_file") {
    try {
      const { base64, mimeType = "application/octet-stream", filename = "upload" } = request;
      if (!base64) {
        sendResponse({ success: false, error: "save_file: no base64 data provided" });
        return;
      }
      // Decode base64 → Blob
      const byteStr = atob(base64);
      const ab   = new ArrayBuffer(byteStr.length);
      const ia   = new Uint8Array(ab);
      for (let i = 0; i < byteStr.length; i++) ia[i] = byteStr.charCodeAt(i);
      const blob = new Blob([ab], { type: mimeType });

      const fileId = `file_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      await saveFile(fileId, blob);
      await chrome.storage.local.set({
        [`fileReady_${fileId}`]: true,
        [`fileMime_${fileId}`]:  mimeType,
        [`fileName_${fileId}`]:  filename,
      });

      console.log(`[BG v12.0] save_file ✅ ${filename} (${mimeType}) → ${fileId}`);
      sendResponse({ success: true, fileId });
    } catch (e) {
      console.error("[BG v12.0] save_file error:", e.message);
      sendResponse({ success: false, error: e.message });
    }
    return;
  }

  if (action === "list_files") {
    const db  = await openFileDb();
    const tx  = db.transaction(FILE_STORE, "readonly");
    const req = tx.objectStore(FILE_STORE).getAllKeys();
    req.onsuccess = () => sendResponse({ success: true, files: req.result });
    req.onerror   = () => sendResponse({ success: false, files: [] });
    return;
  }

  // ── SELECT — v12.0 — choose dropdown option by label ─────────────
  // Resolves label → ref via resolveRef, then sets select.value and
  // fires change event. Supports React selects via dispatchEvent.
  if (action === "select") {
    const { tabId } = await getOrCreateTab();
    if (!tabId) { sendResponse({ success: false, error: "No active tab" }); return; }

    const targetRef = resolveRef(request.label || request.target_id, _lastSnapshotIndex);
    const option    = request.option || "";

    const result = await execInTab(tabId,
      (ref, snapshotIndex, opt) => {
        const item = (snapshotIndex || []).find(i => i.ref === ref);
        let el = null;

        if (item?.xpath) {
          try {
            el = document.evaluate(item.xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
          } catch (_) {}
        }

        // Fallback: find any <select> whose label matches
        if (!el) {
          el = Array.from(document.querySelectorAll("select")).find(s => {
            const lbl = (
              s.getAttribute("aria-label") || s.getAttribute("name") ||
              s.getAttribute("id") || s.getAttribute("title") || ""
            ).toLowerCase();
            return lbl.includes((item?.label || ref).toLowerCase());
          });
        }

        if (!el || el.tagName !== "SELECT") {
          return { success: false, error: `No <select> found for "${ref}"` };
        }

        // Find option by text or value
        const optEl = Array.from(el.options).find(o =>
          o.text.toLowerCase().includes(opt.toLowerCase()) ||
          o.value.toLowerCase() === opt.toLowerCase()
        );

        if (!optEl) {
          const available = Array.from(el.options).map(o => o.text).join(", ");
          return { success: false, error: `Option "${opt}" not found. Available: ${available}` };
        }

        el.value = optEl.value;
        el.dispatchEvent(new Event("change",  { bubbles: true }));
        el.dispatchEvent(new Event("input",   { bubbles: true }));
        return { success: true, selected: optEl.text };
      },
      [targetRef, _lastSnapshotIndex, option]
    );

    sendResponse(result || { success: false, error: "select: script failed" });
    return;
  }

  // ── TYPE_SUBMIT — v11.0 — type value then press Enter ────────────
  // Used by CometBrowser ChatGPT fallback path and any step that needs
  // to type into a field AND submit in a single atomic action.
  if (action === "type_submit") {
    const { tabId } = await getOrCreateTab();
    if (!tabId) { sendResponse({ success: false, error: "No active tab" }); return; }

    const targetRef = resolveRef(request.label || request.target_id, _lastSnapshotIndex);
    const value     = request.value || "";

    // Step 1: type the value
    const typeResult = await execInTab(tabId,
      async (ref, val, snapshotIndex) => {
        if (typeof window.__omni_act__ !== "function") {
          // Fallback: find first visible input
          const inputs = Array.from(document.querySelectorAll(
            'input:not([type="hidden"]),textarea,[contenteditable="true"]'
          ));
          const el = inputs[0];
          if (!el) return { success: false, error: "No input found" };
          el.focus();
          if (el.isContentEditable) el.textContent = val;
          else el.value = val;
          el.dispatchEvent(new Event("input",  { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          return { success: true, typed: val.length, method: "fallback" };
        }
        return window.__omni_act__("type", ref, val, snapshotIndex);
      },
      [targetRef, value, _lastSnapshotIndex]
    );

    if (!typeResult?.success) {
      sendResponse(typeResult || { success: false, error: "type_submit: type step failed" });
      return;
    }

    // Step 2: wait a beat, then press Enter
    await new Promise(r => setTimeout(r, 400));

    const submitResult = await execInTab(tabId,
      (ref, snapshotIndex) => {
        // Try targeted element first
        if (typeof window.__omni_act__ === "function") {
          const r = window.__omni_act__("submit", ref, null, snapshotIndex);
          if (r?.success) return r;
        }
        // Fallback: fire Enter on active element
        const el = document.activeElement || document.querySelector("input,textarea,[contenteditable]");
        if (el) {
          el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", keyCode: 13, bubbles: true, cancelable: true }));
          el.dispatchEvent(new KeyboardEvent("keyup",   { key: "Enter", keyCode: 13, bubbles: true }));
          if (el.form) el.form.requestSubmit?.();
        }
        return { success: true, method: "enter_on_active" };
      },
      [targetRef, _lastSnapshotIndex]
    );

    // Wait for SPA to respond before auth-check
    await new Promise(r => setTimeout(r, 2000));

    const authCheck = await checkTabAuth(tabId);
    if (authCheck?.isAuthError) {
      sendResponse({ success: false, error: "Session expired after type_submit", code: "SESSION_EXPIRED" });
      return;
    }

    sendResponse(submitResult?.success ? { success: true, typed: value.length } : { success: false, error: "type_submit: Enter dispatch failed" });
    return;
  }

  // ── SMART_FIND_ACT — v11.0 — fuzzy element finder with 4 strategies ─
  // Called by CometBrowser P2-3 when a click/type/submit fails to find
  // the target element by exact label.
  // request.type: "fuzzy_label" | "aria_label" | "data_testid" | "role_keyword"
  // request.action: "click" | "type" | "submit"
  // request.query: the search string
  // request.role: (for role_keyword) "button" | "textbox" | "link"
  // request.value: (for type) text to type
  if (action === "smart_find_act") {
    const { tabId } = await getOrCreateTab();
    if (!tabId) { sendResponse({ success: false, error: "No active tab" }); return; }

    const { type: strategy, query, role, value: typeValue, action: subAction } = request;

    const result = await execInTab(tabId,
      (strategy, query, role, subAction, typeValue) => {
        // ── Find the element using the chosen strategy ──────────────
        let el = null;
        const q = (query || "").toLowerCase().trim();

        if (strategy === "fuzzy_label") {
          // Scan all interactive elements for partial label match
          const candidates = Array.from(document.querySelectorAll(
            'button,a,input,textarea,[role="button"],[role="link"],[role="textbox"],[contenteditable]'
          ));
          const getElLabel = e => (
            e.getAttribute("aria-label") || e.innerText || e.value ||
            e.getAttribute("placeholder") || e.getAttribute("title") || ""
          ).toLowerCase();
          el = candidates.find(e => getElLabel(e).includes(q)) || null;
        }

        if (strategy === "aria_label") {
          el = document.querySelector(`[aria-label="${query}"]`) ||
               document.querySelector(`[aria-label*="${query}"]`) || null;
        }

        if (strategy === "data_testid") {
          el = document.querySelector(`[data-testid="${query}"]`) ||
               document.querySelector(`[data-testid*="${query}"]`) ||
               document.querySelector(`[data-cy="${query}"]`) || null;
        }

        if (strategy === "role_keyword") {
          const ariaRole = role === "button" ? "button" : role === "textbox" ? "textbox" : "link";
          const pool = Array.from(document.querySelectorAll(
            `[role="${ariaRole}"],${ariaRole === "textbox" ? "input,textarea" : ariaRole}`
          ));
          el = pool.find(e =>
            (e.innerText || e.getAttribute("aria-label") || e.getAttribute("placeholder") || "")
              .toLowerCase().includes(q)
          ) || null;
        }

        // ── v12.0: data_value strategy — for govt portals (NIC, GST) ──
        // Matches input[type="submit"][value*="query"] and button[value*="query"]
        // These elements have no aria-label or innerText — only a value attribute.
        if (strategy === "data_value") {
          el = document.querySelector(`input[type="submit"][value*="${query}"]`) ||
               document.querySelector(`input[type="button"][value*="${query}"]`) ||
               document.querySelector(`button[value*="${query}"]`) ||
               document.querySelector(`[name*="${query}"]`) ||
               // Case-insensitive fallback via iteration
               Array.from(document.querySelectorAll(
                 'input[type="submit"],input[type="button"],button'
               )).find(e => (e.value || e.innerText || "").toLowerCase().includes(q)) || null;
        }

        if (!el) return { success: false, error: `smart_find [${strategy}]: no element for "${query}"` };

        // ── Perform the sub-action ──────────────────────────────────
        el.scrollIntoView({ behavior: "smooth", block: "center" });

        if (subAction === "click") {
          el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
          el.click();
          el.dispatchEvent(new MouseEvent("mouseup",   { bubbles: true }));
          return { success: true, strategy, found: el.outerHTML.substring(0, 80) };
        }

        if (subAction === "type" && typeValue !== undefined) {
          el.focus();
          // v12.0 BUG 3 FIX: was using el.textContent = typeValue which destroys
          // child DOM nodes on contenteditable elements (Gmail, Facebook, etc.)
          // Now uses execCommand('insertText') which is the correct browser API.
          if (el.isContentEditable) {
            document.execCommand("selectAll", false, null);
            document.execCommand("delete",     false, null);
            const ok = document.execCommand("insertText", false, typeValue);
            if (!ok) el.textContent = typeValue; // sandboxed-iframe fallback
          } else {
            // React-compatible native value setter
            const nativeSetter = Object.getOwnPropertyDescriptor(
              el.tagName === "INPUT"
                ? HTMLInputElement.prototype
                : HTMLTextAreaElement.prototype,
              "value"
            )?.set;
            if (nativeSetter) nativeSetter.call(el, typeValue);
            else el.value = typeValue;
          }
          el.dispatchEvent(new Event("input",  { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          return { success: true, strategy, typed: typeValue.length };
        }

        if (subAction === "submit") {
          el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", keyCode: 13, bubbles: true }));
          if (el.form) el.form.requestSubmit?.();
          return { success: true, strategy };
        }

        return { success: false, error: `smart_find: unknown subAction "${subAction}"` };
      },
      [strategy, query, role, subAction, typeValue]
    );

    console.log(`[BG v12.0] smart_find_act [${strategy}] "${query}" → ${result?.success ? "✅" : "❌"}`);
    sendResponse(result || { success: false, error: "smart_find_act: script failed" });
    return;
  }

  // ── LLM GENERATE — direct text generation, no browser tab needed ─
  // Used by agent-planner.js when it needs to generate email content,
  // summarize text, or produce any AI-generated text without navigating
  // to a chat UI. Routes through the full provider rotation in rotation.js.
  if (action === "llm_generate") {
    try {
      const messages = request.messages || [
        { role: "user", content: request.prompt || "" },
      ];
      const { text, provider } = await callAI(messages, request.taskId || null);
      sendResponse({ success: true, text, provider });
    } catch (e) {
      console.error("[BG v12.0] llm_generate error:", e.message);
      sendResponse({ success: false, error: e.message, code: e.code || "LLM_ERROR" });
    }
    return;
  }

  // ── MARK_SEEN / GET_SEEN_ITEMS — v12.0 — recurring task dedup ────
  // mark_seen: records an item ID as processed so filter_unseen skips it
  // get_seen_items: returns all seen IDs for a store (for UI display)
  if (action === "mark_seen") {
    try {
      await DB.markItemSeen(request.storeName, String(request.itemId));
      sendResponse({ success: true });
    } catch (e) {
      sendResponse({ success: false, error: e.message });
    }
    return;
  }

  if (action === "get_seen_items") {
    try {
      const seenSet = await DB.getSeenItems(request.storeName);
      sendResponse({ success: true, items: [...seenSet] });
    } catch (e) {
      sendResponse({ success: false, error: e.message });
    }
    return;
  }

  // ── v13: Human activity query ────────────────────────────────────
  // CometBrowser and other callers can ask background whether a human
  // is currently using the browser without needing a content-script ref.
  if (action === "check_human_activity") {
    try {
      const active = await isHumanUsingBrowser();
      sendResponse({
        success:          true,
        isActive:         active,
        lastActivityTime: humanActivityState.lastActivityTime,
        lastPosition:     humanActivityState.lastPosition,
        timeSinceActivity: Date.now() - humanActivityState.lastActivityTime,
      });
    } catch (e) {
      sendResponse({ success: false, error: e.message });
    }
    return;
  }

  // ── v13: Fetch all step reports for a task ───────────────────────
  // Used by TaskStepDisplay.jsx on first mount to load existing steps,
  // and by the integration test suite.
  if (action === "get_step_results") {
    try {
      const steps = await getTaskSteps(request.taskId);
      sendResponse({ success: true, steps });
    } catch (e) {
      sendResponse({ success: false, error: e.message });
    }
    return;
  }

  // ── v13.1: Get task status — polling endpoint ───────────────────
  // CometBrowser Phase 3 polling loop calls this every 2s to check
  // whether a task is completed, running, failed, or paused.
  // Required because chrome.runtime.sendMessage doesn't reach web pages.
  if (action === "get_task_status") {
    try {
      const task = await DB.getTask(request.taskId);
      if (!task) {
        sendResponse({ success: false, error: "Task not found" });
      } else {
        sendResponse({ success: true, data: task });
      }
    } catch (e) {
      sendResponse({ success: false, error: e.message });
    }
    return;
  }

  // ── v13: Loop detection smoke-test ───────────────────────────────
  // Returns immediately with the detectLoop function signature so the
  // integration test can verify the feature is wired up without needing
  // a real execution log.
  if (action === "test_loop_detection") {
    const mockLog = [
      { action: "navigate" }, { action: "navigate" }, { action: "navigate" },
    ];
    const mockStep = { id: "test", action: "navigate" };
    const loopFound = detectLoop(mockLog, mockStep, 3);
    sendResponse({ success: true, loopFound, threshold: 3 });
    return;
  }

  // ── RUN AGENT — v14.0 5-phase execution path ────────────────────────
  // Phase 1: understandTask  — deep LLM analysis, no browser (~30s)
  // Phase 2: createWorkflow  — LLM produces WorkflowGraph JSON (~60s)
  // Phase 3+4: executeWorkflow — vision-first node loop with smart recovery
  if (action === "run_agent") {
    const { goal, taskId: reqTaskId } = request;
    if (!goal) {
      sendResponse({ success: false, error: "run_agent: no goal provided" });
      return;
    }

    const taskId = reqTaskId || `task_${Date.now()}`;

    // Respond immediately so frontend knows task has started
    sendResponse({ success: true, taskId, status: "understanding" });

    (async () => {
      try {
        console.log(`[BG v14.0] run_agent: goal = "${goal.substring(0, 120)}"`);
        await sendToFrontendTabs({ action: "task_status", taskId, status: "understanding" });

        // Reset loop guard + clear stale tab
        _loopGuard.reset();
        await chrome.storage.local.remove("activeAgentTabId");

        // ── Phase 1: Deep Task Understanding ──────────────────────
        await sendToFrontendTabs({ action: "task_status", taskId, status: "understanding", message: "Analyzing task..." });
        const understanding = await understandTask(goal);
        await sendToFrontendTabs({ action: "task_understood", taskId, understanding });

        // ── Phase 2: Workflow Creation ─────────────────────────────
        await sendToFrontendTabs({ action: "task_status", taskId, status: "planning", message: "Building workflow..." });
        const workflow = await createWorkflow(understanding);
        await sendToFrontendTabs({ action: "task_planned", taskId, workflow });

        // ── Phase 3+4: Vision Loop Execution ──────────────────────
        await sendToFrontendTabs({ action: "task_status", taskId, status: "running", message: "Executing..." });
        const outcome = await executeWorkflow(workflow.workflow_id);

        console.log(`[BG v14.0] run_agent done:`, { taskId, success: outcome.success });
        await reportTaskCompletion(taskId, outcome.success ? "completed" : "failed", {
          result:         outcome.result,
          collected_data: outcome.collected_data,
          error:          outcome.error,
        });

      } catch (e) {
        console.error(`[BG v14.0] run_agent fatal: ${e.message}`);
        await reportTaskCompletion(taskId, "failed", { error: e.message });
      }
    })();

    return; // already called sendResponse above
  }

  // ── VISION — FIX-B5: was returning "Unknown action: vision" ─────
  // The LLM sometimes emits action:"vision" from EXECUTION_PROMPT.
  // Rather than crashing the step, take a screenshot and return the
  // image data so the agent can continue. If no tab exists yet,
  // return a clear error message instead of hanging.
  if (action === "vision") {
    try {
      const { tabId } = await getOrCreateTab(null, true);
      if (!tabId) {
        sendResponse({ success: false, error: "vision: no active tab — navigate first" });
        return;
      }
      await chrome.tabs.update(tabId, { active: true }).catch(() => {});
      const imageData = await chrome.tabs.captureVisibleTab(null, { format: "jpeg", quality: 60 });
      sendResponse({ success: true, imageData, text: "Screenshot captured for vision step" });
    } catch (e) {
      sendResponse({ success: false, error: `vision failed: ${e.message}` });
    }
    return;
  }

  // ── HUMAN HANDOFF — FIX-1 v14.1 ────────────────────────────────────
  // The LLM emits action:"human-handoff" when it hits a login wall,
  // CAPTCHA, or unclear state. Previously this fell through to the
  // catch-all "Unknown action" response → CometBrowser treated it as
  // a failed step and kept looping for 30 steps.
  //
  // Now: return success:true so CometBrowser's human-handoff interceptor
  // (which runs BEFORE sendExtCmd is called) sees a clean exit.
  // The interceptor in CometBrowser.tsx already breaks the loop and
  // shows the toast — this handler is a belt-and-suspenders fallback
  // in case the message ever reaches background.js directly.
  if (action === "human-handoff") {
    const reason = request.reason || "Agent requested human assistance";

    // Broadcast to any open Lovable/localhost dashboard tabs
    sendToFrontendTabs({
      action:    "human_handoff_requested",
      reason,
      timestamp: Date.now(),
    }).catch(() => {});

    // Fire a Chrome notification so the user sees it even if the tab is hidden
    try {
      chrome.notifications.create(`handoff_${Date.now()}`, {
        type:    "basic",
        iconUrl: "icon.png",
        title:   "🙋 HubtiqueOS — Human Input Needed",
        message: reason.substring(0, 200),
      });
    } catch (_) {
      // notifications permission may not be granted — non-fatal
    }

    console.log(`[BG v14.1] human-handoff: ${reason}`);
    sendResponse({ success: true, humanHandoff: true, reason });
    return;
  }

  sendResponse({ success: false, error: `Unknown action: ${action}` });
}

// ─────────────────────────────────────────────────────────────────────
// SEMANTIC REF RESOLVER (unchanged from v9, working well)
// ─────────────────────────────────────────────────────────────────────
function resolveRef(labelOrRef, snapshotIndex) {
  if (!labelOrRef) return "@e1";
  // Accept composite refs emitted by some planner paths, e.g.
  // "@e2 [button] Search" or "@e1 [input] Search Amazon".
  const embeddedRef = String(labelOrRef).match(/@e\d+/);
  if (embeddedRef) return embeddedRef[0];
  if (/^@e\d+$/.test(labelOrRef)) return labelOrRef;

  const staleMatch = labelOrRef.match(/^(INPUT|BUTTON|LINK|SELECT|FILE)_(\d+)$/);
  if (staleMatch) {
    const roleMap = { INPUT: "input", BUTTON: "button", LINK: "button", SELECT: "select", FILE: "input" };
    const role    = roleMap[staleMatch[1]];
    const pos     = parseInt(staleMatch[2], 10);
    const matches = (snapshotIndex || []).filter(i => i.role === role);
    if (matches[pos]) {
      console.log(`[BG v12.0] Stale ID ${labelOrRef} → ${matches[pos].ref} ("${matches[pos].label}")`);
      return matches[pos].ref;
    }
    console.warn(`[BG v12.0] Stale ID ${labelOrRef}: no match at position ${pos}`);
  }

  const needle = labelOrRef.toLowerCase().trim();
  const index  = snapshotIndex || [];

  for (const item of index) {
    if (item.label.toLowerCase().trim() === needle) {
      console.log(`[BG v12.0] Exact label "${labelOrRef}" → ${item.ref}`);
      return item.ref;
    }
  }

  for (const item of index) {
    if (item.label.toLowerCase().startsWith(needle) || needle.startsWith(item.label.toLowerCase())) {
      console.log(`[BG v12.0] Prefix label "${labelOrRef}" → ${item.ref} ("${item.label}")`);
      return item.ref;
    }
  }

  let best = null, bestScore = 0;
  for (const item of index) {
    const itemLabel = item.label.toLowerCase();
    if (itemLabel.includes(needle) || needle.includes(itemLabel)) {
      const score = Math.min(needle.length, itemLabel.length) /
                    Math.max(needle.length, itemLabel.length);
      if (score > bestScore) { bestScore = score; best = item; }
    }
  }

  if (best && bestScore >= 0.35) {
    console.log(`[BG v12.0] Fuzzy label "${labelOrRef}" → ${best.ref} ("${best.label}", score=${bestScore.toFixed(2)})`);
    return best.ref;
  }

  console.warn(`[BG v12.0] ❌ Could not resolve "${labelOrRef}". Available (${index.length}):`);
  index.slice(0, 20).forEach(i => console.warn(`  ${i.ref} [${i.role}] "${i.label}"`));

  return labelOrRef;
}

chrome.runtime.onMessageExternal.addListener((request, sender, sendResponse) => {
  handleMessage(request, sendResponse);
  return true;
});
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  handleMessage(request, sendResponse);
  return true;
});

// ── Inject extension ID into connected Lovable / localhost tabs ───
// agent-planner.js reads window.__hubtique_ext_id__ to route callAI
// requests back through the background service worker.
async function injectExtIdIntoConnectedTabs() {
  try {
    const tabs = await chrome.tabs.query({ url: ["*://*.lovable.app/*", "http://localhost:*/*"] });
    const extId = chrome.runtime.id;
    for (const tab of tabs) {
      chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: (id) => { window.__hubtique_ext_id__ = id; },
        args: [extId],
      }).catch(() => {});
    }
  } catch (_) {}
}

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete") return;
  const url = tab.url || "";
  if (!url.includes("lovable.app") && !url.includes("localhost")) return;
  const extId = chrome.runtime.id;
  chrome.scripting.executeScript({
    target: { tabId },
    func: (id) => { window.__hubtique_ext_id__ = id; },
    args: [extId],
  }).catch(() => {});
});

// Run on startup for tabs already open
injectExtIdIntoConnectedTabs();
