// src/task-understanding.js — Hubtique OS v14.0
// ─────────────────────────────────────────────────────────────────────
// Phase 1 of the 5-phase architecture: DEEP TASK UNDERSTANDING.
// Pure LLM, no browser. Produces a TaskUnderstanding JSON object that
// drives all subsequent phases (workflow creation, execution, recovery).
//
// Called by: background.js run_agent handler (Step 4 rewrite)
// Exports:   understandTask(rawTask) → TaskUnderstanding
//            UNDERSTANDING_PROMPT (template string)
// ─────────────────────────────────────────────────────────────────────

// ── UNDERSTANDING PROMPT ─────────────────────────────────────────────
// Deep analysis of the raw task. No planning yet — only understanding.
// Output drives WORKFLOW_PROMPT in workflow-engine.js Phase 2.
export const UNDERSTANDING_PROMPT = `You are a task analyst for a browser automation system.
Read this task carefully. Produce a complete understanding. Do NOT plan steps yet.

TASK: {TASK}

CANONICAL SITE URLS — use these exactly, never guess or construct your own:
{URL_REFERENCE}

Analyze every aspect of the task before producing output:
- What sites are involved and in what order?
- What data must be collected from each site?
- What data collected earlier feeds into later steps?
- What blockers are typical for each site?
- What is the exact final output this task must produce?

Output ONLY valid JSON — no markdown, no prose, no code fences.
Your entire response must be parseable by JSON.parse():
{
  "task_raw": "exact task text as given",
  "goal": "one sentence — what success looks like for a human checking the result",
  "intent_type": "research|compare|generate|publish|communicate|purchase|fill_form|extract|mixed",
  "sites_involved": [
    {
      "name": "site name",
      "url": "https://exact-url-from-canonical-list.com",
      "purpose": "why we visit this site",
      "what_to_do": "specific action on this site",
      "what_to_collect": "exact data field to extract, or null if none",
      "page_behavior": "how this site works — search layout, where data appears, JS-heavy etc",
      "anti_bot_risk": "none|low|medium|high",
      "expected_blockers": ["list of blockers like cookie banner, zip modal, captcha"],
      "blocker_strategies": {
        "cookie banner": "click Accept or Continue",
        "zip modal": "press Escape",
        "captcha": "human-handoff immediately"
      },
      "visit_order": 1
    }
  ],
  "data_flow": {
    "field_name": "collected at SiteA, required at SiteB for X purpose"
  },
  "final_output": "exact description of what DONE must contain",
  "output_format": "URL|text|price|list|report|email_sent|form_submitted",
  "failure_modes": [
    {
      "scenario": "what could go wrong",
      "recovery": "how to recover without human help"
    }
  ],
  "estimated_nodes": 20,
  "estimated_time_minutes": 5,
  "confidence": 85
}`;

// ── KNOWN SITE URLS (duplicated here for self-contained module) ───────
// Must stay in sync with agent-planner.js KNOWN_SITE_URLS.
const KNOWN_SITE_URLS = {
  'amazon':        'https://www.amazon.com',
  'bestbuy':       'https://www.bestbuy.com',
  'best buy':      'https://www.bestbuy.com',
  'ebay':          'https://www.ebay.com',
  'walmart':       'https://www.walmart.com',
  'target':        'https://www.target.com',
  'etsy':          'https://www.etsy.com',
  'aliexpress':    'https://www.aliexpress.com',
  'gmail':         'https://mail.google.com',
  'google':        'https://www.google.com',
  'google docs':   'https://docs.google.com',
  'google drive':  'https://drive.google.com',
  'google sheets': 'https://sheets.google.com',
  'chatgpt':       'https://chatgpt.com',
  'openai':        'https://chatgpt.com',
  'gemini':        'https://gemini.google.com',
  'claude':        'https://claude.ai',
  'claude.ai':     'https://claude.ai',
  'perplexity':    'https://www.perplexity.ai',
  'duckduckgo ai': 'https://duckduckgo.com/?q=DuckDuckGo+AI+Chat&ia=chat',
  'duckduckgo':    'https://duckduckgo.com',
  'hacker news':   'https://news.ycombinator.com',
  'hackernews':    'https://news.ycombinator.com',
  'hn':            'https://news.ycombinator.com',
  'reddit':        'https://www.reddit.com',
  'github':        'https://github.com',
  'stackoverflow': 'https://stackoverflow.com',
  'youtube':       'https://www.youtube.com',
  'twitter':       'https://twitter.com',
  'x.com':         'https://x.com',
  'linkedin':      'https://www.linkedin.com',
  'justpaste':     'https://justpaste.it',
  'justpaste.it':  'https://justpaste.it',
  'pastebin':      'https://pastebin.com',
  'notion':        'https://www.notion.so',
};

function buildUrlReference() {
  return Object.entries(KNOWN_SITE_URLS)
    .map(([name, url]) => `  "${name}" → ${url}`)
    .join('\n');
}

// ── understandTask ───────────────────────────────────────────────────
// Main export. Calls LLM with the deep understanding prompt.
// Returns a TaskUnderstanding object saved to chrome.storage.local.
//
// Usage (from background.js run_agent handler):
//   const understanding = await understandTask(goal);
//   // → { task_raw, goal, intent_type, sites_involved, data_flow,
//   //     final_output, output_format, failure_modes,
//   //     estimated_nodes, estimated_time_minutes, confidence }
export async function understandTask(rawTask) {
  console.log(`[UNDERSTAND v14] 🧠 Phase 1: Deep task understanding...`);
  console.log(`[UNDERSTAND v14] Task: ${rawTask.substring(0, 120)}`);

  const prompt = UNDERSTANDING_PROMPT
    .replace('{TASK}', rawTask)
    .replace('{URL_REFERENCE}', buildUrlReference());

  const systemPrompt =
    'You are a browser automation task analyst. ' +
    'Output ONLY valid JSON parseable by JSON.parse(). ' +
    'No markdown fences, no prose, no explanation before or after the JSON.';

  // Route through background bridge (background.js injects __hubtique_ext_id__)
  const result = await _callLLM(
    [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: prompt },
    ],
    1500
  );

  if (!result.success) {
    throw new Error(`understandTask: LLM call failed — ${result.error}`);
  }

  let understanding;
  try {
    understanding = _parseJSON(result.text);
  } catch (e) {
    throw new Error(
      `understandTask: Failed to parse understanding JSON.\n` +
      `Parse error: ${e.message}\n` +
      `LLM response (first 400 chars): ${result.text.substring(0, 400)}`
    );
  }

  // Validate minimal required fields
  if (!understanding.goal) throw new Error('understandTask: missing "goal" in response');
  if (!Array.isArray(understanding.sites_involved)) {
    throw new Error('understandTask: missing "sites_involved" array in response');
  }

  // Persist to storage so workflow-engine.js and SW restarts can read it
  await chrome.storage.local.set({
    [`understanding_${Date.now()}`]: understanding,
    last_understanding: understanding,
  });

  console.log(`[UNDERSTAND v14] ✅ Understanding complete:`);
  console.log(`  Goal: ${understanding.goal}`);
  console.log(`  Sites: ${understanding.sites_involved.map(s => s.name).join(', ')}`);
  console.log(`  Estimated nodes: ${understanding.estimated_nodes}`);
  console.log(`  Confidence: ${understanding.confidence}%`);

  return understanding;
}

// ── Internal helpers ─────────────────────────────────────────────────

// Call LLM via background bridge (primary) or Pollinations fallback.
// Mirrors generateTextWithLLM() in agent-planner.js but lives here
// so task-understanding.js is self-contained.
async function _callLLM(messages, maxTokens = 1000) {
  // Primary: extension background bridge
  const extId = typeof window !== 'undefined' && window.__hubtique_ext_id__;
  if (extId && typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
    try {
      const result = await new Promise((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error('Extension bridge timeout (15s)')),
          15_000
        );
        chrome.runtime.sendMessage(
          extId,
          { action: 'llm_generate', messages, taskId: null },
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
      if (result?.success && result.text) {
        console.log(`[UNDERSTAND v14] LLM via background (${result.provider})`);
        return { success: true, text: result.text, provider: result.provider };
      }
      console.warn(`[UNDERSTAND v14] Background bridge failed: ${result?.error}`);
    } catch (e) {
      console.warn(`[UNDERSTAND v14] Bridge error: ${e.message}`);
    }
  }

  // If called directly from background.js (service worker context),
  // chrome.runtime.sendMessage to self is not available — use callAI directly.
  // background.js passes callAI as a global when importing this module.
  if (typeof callAI === 'function') {
    try {
      const result = await callAI(messages);
      return { success: true, text: result.text, provider: result.provider };
    } catch (e) {
      console.warn(`[UNDERSTAND v14] callAI error: ${e.message}`);
    }
  }

  // Fallback: Pollinations (no key required)
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      if (attempt > 1) await new Promise(r => setTimeout(r, 2000 * attempt));
      const resp = await fetch('https://text.pollinations.ai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'openai-large', max_tokens: maxTokens, messages }),
      });
      if (resp.ok) {
        const data = await resp.json();
        const text = data?.choices?.[0]?.message?.content?.trim();
        if (text) return { success: true, text, provider: 'pollinations' };
      }
    } catch (_) {}
  }

  return { success: false, error: 'All LLM providers failed for task understanding' };
}

// Robust JSON extractor — handles markdown fences and prose wrappers.
function _parseJSON(text) {
  if (!text || typeof text !== 'string') throw new Error('empty input');
  try { return JSON.parse(text.trim()); } catch (_) {}
  const jsonFence = text.match(/```json\s*([\s\S]*?)```/);
  if (jsonFence) { try { return JSON.parse(jsonFence[1].trim()); } catch (_) {} }
  const plainFence = text.match(/```\s*([\s\S]*?)```/);
  if (plainFence) { try { return JSON.parse(plainFence[1].trim()); } catch (_) {} }
  const objMatch = text.match(/\{[\s\S]*\}/);
  if (objMatch) { try { return JSON.parse(objMatch[0]); } catch (_) {} }
  throw new Error(`No valid JSON found. First 300 chars: ${text.substring(0, 300)}`);
}
