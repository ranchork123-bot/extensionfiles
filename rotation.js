// src/rotation.js — Hubtique OS v13.3-FIXED
// ─────────────────────────────────────────────────────────────────────
// v13.3-FIXED CHANGES:
//  ✅ FIX-R7  — Cerebras model: was "llama-3.3-70b" (DEPRECATED → HTTP 404)
//               now "llama3.1-8b" (current working free-tier model)
//  ✅ FIX-R8  — Pollinations endpoint: was "https://text.pollinations.ai/openai"
//               now "https://text.pollinations.ai/v1/chat/completions"
//  ✅ FIX-R9  — Pollinations model: was "openai" (invalid), now "openai-large"
//  ✅ FIX-R10 — consecutiveFails limit raised 3→5 so one bad provider
//               doesn't abort rotation before all others get a chance
//  ✅ FIX-R11 — DB calls wrapped in 2s timeout — DB hang no longer causes
//               all providers to score 0 ("No API keys configured")
//  ✅ FIX-R12 — fetch() wrapped in 12s AbortSignal — no more infinite hangs
//  ✅ FIX-R13 — DB.getTask() wrapped in .catch(() => null) — corrupt task
//               record no longer crashes the entire callAI
// ─────────────────────────────────────────────────────────────────────

import * as DB from "./db.js";

const FETCH_TIMEOUT_MS = 12_000;
const DB_TIMEOUT_MS    =  2_000;

// ── Free provider configs ─────────────────────────────────────────
export const PROVIDERS = {
  groq:        { name: "Groq",         daily: 14400, endpoint: "https://api.groq.com/openai/v1/chat/completions",                         model: "llama-3.3-70b-versatile" },
  cerebras:    { name: "Cerebras",     daily: 10000, endpoint: "https://api.cerebras.ai/v1/chat/completions",                             model: "llama3.1-8b" },            // FIX-R7
  sambanova:   { name: "SambaNova",    daily: 5000,  endpoint: "https://api.sambanova.ai/v1/chat/completions",                            model: "Meta-Llama-3.3-70B-Instruct" },
  openrouter:  { name: "OpenRouter",   daily: 5400,  endpoint: "https://openrouter.ai/api/v1/chat/completions",                           model: "meta-llama/llama-3.3-70b-instruct:free" },
  google:      { name: "Google AI",    daily: 1500,  endpoint: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", model: "gemini-2.0-flash" },
  pollinations:{ name: "Pollinations", daily: 99999, endpoint: "https://text.pollinations.ai/v1/chat/completions",                        model: "openai-large", apiKeyRequired: false }, // FIX-R8+R9
};

// ── DB helper with timeout (FIX-R11) ─────────────────────────────
async function getProviderStateSafe(id) {
  const defaultState = { status: "online", consecutive_failures: 0, cooldown_until: null, current_usage: 0 };
  try {
    return await Promise.race([
      DB.getProviderState(id),
      new Promise((_, reject) => setTimeout(() => reject(new Error("DB timeout")), DB_TIMEOUT_MS)),
    ]) || defaultState;
  } catch (_) {
    console.warn(`[ROTATION] DB timeout for ${id} — using default state`);
    return defaultState;
  }
}

// ── Scoring ───────────────────────────────────────────────────────
export async function scoreProvider(id) {
  const cfg = PROVIDERS[id];
  if (!cfg) return 0;
  if (cfg.apiKeyRequired !== false) {
    const keyData = await chrome.storage.local.get(`apiKey_${id}`);
    if (!keyData[`apiKey_${id}`]) return 0;
  }
  const state = await getProviderStateSafe(id);
  if (state.cooldown_until && state.cooldown_until > Date.now()) return 0;
  if (state.status === "auth_failed") return 0;
  const remaining = Math.max(0, cfg.daily - (state.current_usage || 0));
  if (remaining === 0) return 0;
  return remaining / cfg.daily;
}

// ── Main callAI with rotation ─────────────────────────────────────
export async function callAI(messages, taskId = null) {
  // FIX-R13: .catch(() => null) prevents corrupt task crashing callAI
  const rotation = taskId
    ? ((await DB.getTask(taskId).catch(() => null))?.provider_rotation || Object.keys(PROVIDERS))
    : Object.keys(PROVIDERS);

  let lastError        = null;
  let triedCount       = 0;
  let consecutiveFails = 0;

  for (const id of rotation) {
    // FIX-R10: 5 consecutive failures before aborting (was 3)
    if (consecutiveFails >= 5) {
      console.warn(`[ROTATION] ⚠️ 5 consecutive provider failures — aborting rotation`);
      break;
    }

    const score = await scoreProvider(id);
    if (score === 0) continue;

    const cfg     = PROVIDERS[id];
    const keyData = await chrome.storage.local.get(`apiKey_${id}`);
    const apiKey  = cfg.apiKeyRequired === false ? "noop" : keyData[`apiKey_${id}`];
    if (!apiKey && cfg.apiKeyRequired !== false) continue;

    triedCount++;

    // FIX-R12: 12s fetch timeout
    const controller   = new AbortController();
    const fetchTimeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
      const resp = await fetch(cfg.endpoint, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          ...(cfg.apiKeyRequired !== false && { "Authorization": `Bearer ${apiKey}` }),
        },
        body: JSON.stringify({ model: cfg.model, messages, max_tokens: 2000 }),
      });
      clearTimeout(fetchTimeout);

      if (resp.status === 429) { await markRateLimited(id); consecutiveFails++; continue; }
      if (resp.status === 401 || resp.status === 402 || resp.status === 403) { await markFailed(id); consecutiveFails++; continue; }
      if (!resp.ok) { lastError = `${id}: HTTP ${resp.status}`; consecutiveFails++; continue; }

      const data = await resp.json();
      const text = data.choices?.[0]?.message?.content || data.choices?.[0]?.text || "";
      if (!text) { lastError = `${id}: empty response`; consecutiveFails++; continue; }

      // v14.0: Validate JSON if response looks like structured data (agent decisions are always JSON).
      // If the model returns malformed JSON, try the next provider rather than crashing the caller.
      const trimmed = text.trim();
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try {
          JSON.parse(trimmed.replace(/```(?:json)?|```/g, '').trim());
        } catch (_) {
          lastError = `${id}: malformed JSON in response`;
          consecutiveFails++;
          console.warn(`[ROTATION] ⚠️ ${id}: malformed JSON — trying next provider`);
          continue;
        }
      }

      consecutiveFails = 0;
      const state = await getProviderStateSafe(id);
      await DB.updateProviderState(id, {
        status: "online", current_usage: (state.current_usage || 0) + 1,
        last_used: Date.now(), cooldown_until: null, consecutive_failures: 0,
      }).catch(() => {});

      console.log(`[ROTATION] ✅ ${id} succeeded`);
      return { text, provider: id };

    } catch (e) {
      clearTimeout(fetchTimeout);
      const msg = e.name === "AbortError" ? `${id}: fetch timeout (${FETCH_TIMEOUT_MS / 1000}s)` : `${id}: ${e.message}`;
      lastError = msg;
      consecutiveFails++;
      console.warn(`[ROTATION] ⚠️ ${msg}`);
    }
  }

  if (triedCount === 0) {
    throw Object.assign(
      new Error("No API keys configured — agent cannot call LLM. Go to API Vault and add at least one provider key."),
      { code: "NO_KEYS" }
    );
  }
  throw Object.assign(
    new Error(`All ${triedCount} providers failed. Last: ${lastError}`),
    { code: "ALL_FAILED" }
  );
}

// ── State helpers ─────────────────────────────────────────────────
async function markRateLimited(id) {
  await DB.updateProviderState(id, { status: "rate_limited", cooldown_until: Date.now() + 5 * 60 * 1000, error_code: 429 }).catch(() => {});
  console.warn(`[ROTATION] ⏸ ${id} rate-limited (5-min cooldown)`);
}
async function markFailed(id) {
  await DB.updateProviderState(id, { status: "auth_failed", error_code: 401 }).catch(() => {});
  console.error(`[ROTATION] ❌ ${id} auth failed`);
}
export async function markOnline(id) {
  await DB.updateProviderState(id, { status: "online", cooldown_until: null, error_code: null, consecutive_failures: 0 }).catch(() => {});
}
export async function resetDailyQuotas() {
  for (const id of Object.keys(PROVIDERS)) {
    await DB.updateProviderState(id, { current_usage: 0, status: "online", cooldown_until: null, consecutive_failures: 0 }).catch(() => {});
  }
  console.log("[ROTATION] 🔄 Daily quotas reset");
}
export async function initProviders() {
  for (const [id, cfg] of Object.entries(PROVIDERS)) {
    const state = await getProviderStateSafe(id);
    if (!state.daily_limit) {
      await DB.updateProviderState(id, { status: "unknown", daily_limit: cfg.daily, current_usage: 0, cooldown_until: null, consecutive_failures: 0 }).catch(() => {});
    }
  }
}
export async function saveApiKey(providerId, key) {
  await chrome.storage.local.set({ [`apiKey_${providerId}`]: key });
  await markOnline(providerId);
}
export async function getProviderStats() {
  const stats = [];
  for (const [id, cfg] of Object.entries(PROVIDERS)) {
    const state   = await getProviderStateSafe(id);
    const keyData = await chrome.storage.local.get(`apiKey_${id}`);
    const hasKey  = cfg.apiKeyRequired === false || !!keyData[`apiKey_${id}`];
    const remaining = Math.max(0, cfg.daily - (state.current_usage || 0));
    stats.push({
      id, name: cfg.name, hasKey,
      status:        hasKey ? (state.status || "online") : "no_key",
      used:          state.current_usage || 0,
      daily:         cfg.daily,
      remaining,
      pct:           Math.round((remaining / cfg.daily) * 100),
      onCooldown:    !!(state.cooldown_until && state.cooldown_until > Date.now()),
      cooldownUntil: state.cooldown_until,
    });
  }
  return stats;
}
export async function getBestProvider(rotation = Object.keys(PROVIDERS)) {
  let best = null, bestScore = -1;
  for (const id of rotation) {
    const score = await scoreProvider(id);
    if (score > bestScore) { bestScore = score; best = id; }
  }
  return bestScore > 0 ? best : null;
}
