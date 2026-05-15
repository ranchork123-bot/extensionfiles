// agent-planner.js — Hubtique OS v13.1 — PLANNING & MEMORY BRAIN
// ─────────────────────────────────────────────────────────────────────
// FIXES vs v13.0:
//  ✅ FIX-TYPEFOCUS-v13.1 — EXECUTION_PROMPT rule 10 added:
//             Agent must click/focus any input field BEFORE calling type.
//             Root cause of "type lands nowhere" bug — text was typed
//             without focus so it went to the void. Correct sequence is
//             always: click(field) → type(field, value) → click(submit).
//             Prompt-only fix — no content.js or executor changes needed.
// ─────────────────────────────────────────────────────────────────────
// FIXES vs v8/v9:
//  ✅ FIX 1 — MEMORY OBJECT injected into every LLM prompt
//             Agent cannot loop because it always sees what it collected
//  ✅ FIX 2 — Direct LLM API call for text generation tasks
//             NEVER navigate to ChatGPT UI — call Groq/OpenRouter directly
//  ✅ FIX 3 — PLANNING PROMPT capped at MAX 7 steps; research phase removed
//             for pure action tasks; outputs DAG (deps) not just linear list
//  ✅ FIX 4 — LOOP GUARD constants exported and shared with background.js
//  ✅ FIX 5 — COMPLETION CHECKER tightened — partial count check, not just bool
//  ✅ FIX 6 — SITE CONFIGS extended: Gmail compose field labels updated
//             to match current 2024/2025 Gmail DOM labels
//  ✅ FIX 7 — isReadOnlySite covers more patterns including subdomains
// ─────────────────────────────────────────────────────────────────────
// AGENT 1 CHANGES (v13 HILO upgrade):
//  ✅ A1-1 — parseJSON()           robust extraction from LLM response (handles markdown fences)
//  ✅ A1-2 — validatePlan()        schema check before any execution starts
//  ✅ A1-3 — generatePlan()        single entry point: LLM → parse → validate → return
//  ✅ A1-4 — PLANNING_PROMPT       steps now use "id" (not "n") for executor compatibility
//  ✅ A1-5 — test_planning handler registered for console testing
//  ✅ A1-6 — generateTextWithLLM() routes through background bridge (fixes localStorage bug)
//            v9 read API keys from localStorage — WRONG. Keys live in chrome.storage.local.
//            Fix: send to background.js via chrome.runtime.sendMessage, which has full
//            access to chrome.storage.local and the rotation.js provider pool.
// ─────────────────────────────────────────────────────────────────────

// ── FIX 4 — LOOP GUARD CONSTANTS ────────────────────────────────
export const LOOP_GUARD = {
  MAX_STEPS:   80,   // v14.0: complex multi-site tasks need 40-80 steps (was 25)
  MAX_REPEATS: 3,    // same action key → bail
  STEP_TIMEOUT_MS: 45_000,  // each step must finish within 45s
};

// ── FIX 7 — READ-ONLY SITES ─────────────────────────────────────
const READ_ONLY_PATTERNS = [
  /news\.ycombinator\.com/,
  /reddit\.com/,
  /wikipedia\.org/,
  /github\.com\/[^/]+\/[^/]+\/(blob|tree|wiki|releases)/,
  /medium\.com/,
  /dev\.to/,
  /arxiv\.org/,
  /lobste\.rs/,
  /bbc\.(co\.uk|com)/,
  /cnn\.com/,
  /techcrunch\.com/,
  /theguardian\.com/,
  /nytimes\.com/,
  /wired\.com/,
  /arstechnica\.com/,
];

export function isReadOnlySite(url) {
  try {
    return READ_ONLY_PATTERNS.some(p => p.test(url));
  } catch (_) { return false; }
}

// ─────────────────────────────────────────────────────────────────────
// A1-6 — generateTextWithLLM (FIXED — routes through background bridge)
// ─────────────────────────────────────────────────────────────────────
// ROOT CAUSE OF "All LLM providers exhausted" in v9:
//   Old code read API keys from localStorage, but the Vault UI saves them
//   to chrome.storage.local (extension storage). These NEVER share data —
//   localStorage was always empty, so every provider was silently skipped.
//
// FIX: Route through background.js via chrome.runtime.sendMessage.
//   Background has full access to chrome.storage.local and rotation.js
//   (all configured providers with quota tracking + cooldown logic).
//   Background already injects window.__hubtique_ext_id__ into Lovable/
//   localhost tabs (background.js FIX 11), so the bridge is always ready.
//
// FALLBACK: If extension bridge is unavailable (standalone/dev mode),
//   falls back to Pollinations (no key required) with 3 retries.
export async function generateTextWithLLM(prompt, systemPrompt = '', maxTokens = 512) {
  const messages = [
    ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
    { role: 'user', content: prompt },
  ];

  // ── PRIMARY PATH: route through extension background ─────────────
  const extId = window.__hubtique_ext_id__;
  if (extId && typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
    try {
      const result = await new Promise((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error('Extension bridge timeout (10s)')),
          10_000
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
        console.log(`[PLANNER v13] ✅ LLM via background (${result.provider})`);
        return { success: true, text: result.text, provider: result.provider };
      }

      console.warn(`[PLANNER v13] ⚠️ Background LLM failed: ${result?.error}`);
    } catch (e) {
      console.warn(`[PLANNER v13] ⚠️ Extension bridge error: ${e.message}`);
    }
  } else {
    console.warn('[PLANNER v13] ⚠️ No extension bridge — __hubtique_ext_id__ not set yet.');
  }

  // ── FALLBACK: Pollinations (no API key required, always available) ──
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      if (attempt > 1) {
        await new Promise(r => setTimeout(r, 2000 * attempt));
      }
      const resp = await fetch('https://text.pollinations.ai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'openai-large',
          max_tokens: maxTokens,
          messages,
        }),
      });
      if (resp.ok) {
        const data = await resp.json();
        const text = data?.choices?.[0]?.message?.content?.trim();
        if (text) {
          console.log(`[PLANNER v13] ✅ LLM via Pollinations fallback (attempt ${attempt})`);
          return { success: true, text, provider: 'pollinations' };
        }
      }
    } catch (_) {}
  }

  return {
    success: false,
    error: 'All LLM providers exhausted — check extension is installed and API keys are saved in the Vault',
  };
}

// ── FIX 6 — SITE CONFIGS (updated Gmail labels) ──────────────────
export const SITE_CONFIGS = {
  'google.com': {
    afterNavigate: 1500, afterType: 800, afterClick: 1200, botRisk: 'LOW',
  },
  'chatgpt.com': {
    chatInput: { role: 'input', hint: 'Message ChatGPT' },
    afterNavigate: 5000,
    afterType: 600,
    afterClick: 2500,
    responseWait: 20000,
    botRisk: 'MEDIUM',
    note: 'Prefer generateTextWithLLM() over navigating here',
  },
  'linkedin.com': {
    afterNavigate: 3000, afterType: 1500, afterClick: 2000, botRisk: 'HIGH',
  },
  'twitter.com': { afterNavigate: 2000, afterType: 700, afterClick: 1200, botRisk: 'MEDIUM' },
  'x.com':       { afterNavigate: 2000, afterType: 700, afterClick: 1200, botRisk: 'MEDIUM' },
  'gmail.com': {
    afterNavigate: 3000,
    composeButton: { role: 'button', hint: 'Compose' },
    toField:       { role: 'input',  hint: 'To recipients' },
    subjectField:  { role: 'input',  hint: 'Subject' },
    bodyField:     { role: 'input',  hint: 'Message Body' },
    sendButton:    { role: 'button', hint: 'Send ‪(Ctrl-Enter)‬' },
    afterType: 400, afterClick: 1000, botRisk: 'LOW',
  },
  'default': { afterNavigate: 1500, afterType: 500, afterClick: 800, botRisk: 'LOW' },
};

export function getSiteConfig(url) {
  try {
    const hostname = new URL(url).hostname.replace('www.', '');
    for (const [pattern, config] of Object.entries(SITE_CONFIGS)) {
      if (pattern === 'default') continue;
      if (hostname.includes(pattern)) return config;
    }
  } catch (_) {}
  return SITE_CONFIGS['default'];
}

export function getActionDelay(action, url) {
  const config = getSiteConfig(url || '');
  switch (action) {
    case 'navigate': return config.afterNavigate || 1500;
    case 'type':     return config.afterType     || 500;
    case 'click':    return config.afterClick    || 800;
    case 'submit':   return config.afterClick    || 800;
    default:         return 300;
  }
}

// ─────────────────────────────────────────────────────────────────────
// FIX 1 — MEMORY OBJECT SCHEMA (unchanged from v9)
// ─────────────────────────────────────────────────────────────────────
export function createMemoryObject(task) {
  return {
    task,
    phase: 'start',
    collected: {},
    actions_done: [],
    errors: [],
    current_url: '',
    step_count: 0,
    is_complete: false,
  };
}

export function serializeMemory(memory) {
  const collected = Object.entries(memory.collected || {})
    .map(([k, v]) => `  ${k}: ${String(v).substring(0, 400)}`)
    .join('\n');
  const done = (memory.actions_done || []).slice(-8).join(', ');
  const errors = (memory.errors || []).slice(-3).join(', ');
  return [
    `=== AGENT MEMORY (DO NOT REPEAT COMPLETED ITEMS) ===`,
    `Task: ${memory.task}`,
    `Phase: ${memory.phase}`,
    `Step: ${memory.step_count}`,
    `Current URL: ${memory.current_url || 'none'}`,
    `Is complete: ${memory.is_complete}`,
    collected ? `Collected:\n${collected}` : 'Collected: nothing yet',
    done    ? `Recently done: ${done}`    : '',
    errors  ? `Recent errors: ${errors}`  : '',
    `=== END MEMORY ===`,
  ].filter(Boolean).join('\n');
}

// ─────────────────────────────────────────────────────────────────────
// SYSTEM PROMPTS
// ─────────────────────────────────────────────────────────────────────

export const UNDERSTANDING_PROMPT = `You analyze a browser automation task to choose the correct execution strategy.

TASK: "{TASK}"

STRATEGIES:
- "read_only"           — just read page text, no clicking needed
- "navigate_and_read"   — navigate then read_body, no interaction
- "navigate_and_act"    — navigate, interact (click/type), complete action
- "multi_step"          — research FIRST (read_body), THEN act (e.g. read HN → send Gmail)
- "llm_generate_then_act" — use LLM API directly for text, then act (NO ChatGPT UI)

CRITICAL RULES:
- "send email about top HN article" = multi_step (read HN body → generate email via LLM API → open Gmail → send)
- "find trending on HN"             = read_only
- For LLM text generation: PREFER llm_generate_then_act (faster, no browser).
- If task explicitly names a browser AI (ChatGPT, Gemini, Claude.ai, Perplexity) → plan to navigate there.
- If llm_generate fails → agent should adapt and navigate to a free browser AI as fallback.
- If strategy needs LLM text: set needs_llm_generation: true.

Reply ONLY with this JSON (no markdown):
{
  "understood_goal": "exact final outcome",
  "final_deliverable": "what DONE step must contain",
  "strategy": "read_only|navigate_and_read|navigate_and_act|multi_step|llm_generate_then_act",
  "needs_llm_generation": false,
  "llm_generation_prompt": "if needs_llm_generation, the exact prompt to pass to generateTextWithLLM()",
  "steps_overview": ["step 1", "step 2"],
  "read_only_urls": ["url"],
  "interactive_urls": ["url"],
  "confidence": 90,
  "should_proceed": true,
  "reasoning": "why this strategy"
}`;

// ── KNOWN_SITE_URLS — canonical URL map ──────────────────────────────
// BRAIN FIX v13.1: The LLM was hallucinating domain names (e.g. "amazonsite.com"
// instead of "amazon.com"). Root cause: EXECUTION_PROMPT gave the LLM zero URL
// reference — it had to reconstruct domains from the task text and got them wrong.
//
// Fix: inject this map into BOTH prompts so the LLM always has a ground-truth
// reference regardless of how the site name appears in the task description.
// Also used by navigateStep URL sanitizer in task-executor.js as a safety net
// that corrects wrong URLs even if the LLM ignores the prompt rule.
export const KNOWN_SITE_URLS = {
  // Shopping
  'amazon':        'https://www.amazon.com',
  'bestbuy':       'https://www.bestbuy.com',
  'best buy':      'https://www.bestbuy.com',
  'ebay':          'https://www.ebay.com',
  'walmart':       'https://www.walmart.com',
  'target':        'https://www.target.com',
  'etsy':          'https://www.etsy.com',
  'aliexpress':    'https://www.aliexpress.com',
  // Email / Google
  'gmail':         'https://mail.google.com',
  'google':        'https://www.google.com',
  'google docs':   'https://docs.google.com',
  'google drive':  'https://drive.google.com',
  'google sheets': 'https://sheets.google.com',
  // AI tools
  'chatgpt':       'https://chatgpt.com',
  'openai':        'https://chatgpt.com',
  'gemini':        'https://gemini.google.com',
  'claude':        'https://claude.ai',
  'claude.ai':     'https://claude.ai',
  'perplexity':    'https://www.perplexity.ai',
  'duckduckgo ai': 'https://duckduckgo.com/?q=DuckDuckGo+AI+Chat&ia=chat',
  'duckduckgo':    'https://duckduckgo.com',
  // Tech / news
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
  // Paste / notes
  'justpaste':     'https://justpaste.it',
  'justpaste.it':  'https://justpaste.it',
  'pastebin':      'https://pastebin.com',
  'notion':        'https://www.notion.so',
};

// Helper: build a compact URL reference string for injection into prompts
function buildUrlReference() {
  return Object.entries(KNOWN_SITE_URLS)
    .map(([name, url]) => `  "${name}" → ${url}`)
    .join('\n');
}

// ── A1-4 — PLANNING PROMPT: steps now use "id" (not "n") ─────────────
// Changed "n" → "id" so executePlan() in task-executor.js can reference
// steps by step.id without any field-name translation.
export const PLANNING_PROMPT = `You are a browser automation planner. Create a MINIMAL precise plan.

TASK: {TASK}
STRATEGY: {STRATEGY}
GOAL: {GOAL}
DELIVERABLE: {DELIVERABLE}

CANONICAL SITE URLS — USE THESE EXACTLY, NEVER CONSTRUCT YOUR OWN:
{URL_REFERENCE}

HARD RULES — VIOLATING THESE CAUSES TASK FAILURE:
1. MAXIMUM 50 STEPS. Plan realistically — each site visit takes 4-8 steps minimum.
   Step budget per site type: read-only = 2-3 steps, interactive = 5-8 steps, AI tool = 4-6 steps.
   Multi-site tasks: plan ALL sites fully before writing steps — never truncate mid-task.
2. For READ-ONLY sites (HN, Wikipedia, Reddit, news):
   Step 1: navigate  Step 2: read_body  Step 3: DONE — that's it. 3 steps total.
3. For LLM text generation:
   - FIRST: try llm_generate action (fastest)
   - If task names a specific AI tool → navigate to it
   - If llm_generate fails → fallback to chatgpt.com, gemini.google.com, or claude.ai
4. For Gmail:
   navigate → getSnapshot → click("Compose") → type("To recipients", email) →
   type("Subject", subject) → type("Message Body", body) → click("Send ‪(Ctrl-Enter)‬") → DONE
5. NEVER plan a "research" phase for tasks that just need to ACT.
6. If two steps can use the same navigate, merge them.
7. Add dependencies: if step 3 needs data from step 1, note dep: [1].
8. URL RULE — CRITICAL: When task mentions a website (e.g. "Amazon.com", "Best Buy"),
   look it up in CANONICAL SITE URLS above. Copy the URL EXACTLY.
   NEVER append words like "site", "shop", "store", "web" to a domain.
   NEVER guess: "amazon.com" → https://www.amazon.com NOT https://www.amazonsite.com

Reply ONLY with valid JSON — no markdown, no prose, no code fences:
{
  "goal": "one sentence",
  "total_steps": 5,
  "steps": [
    {
      "id": 1,
      "action": "navigate|read_body|getSnapshot|type|click|wait|llm_generate|DONE",
      "url": "full URL if navigate",
      "label": "semantic label if type/click",
      "value": "text if type",
      "prompt": "LLM prompt if llm_generate",
      "seconds": 2,
      "dep": [],
      "reason": "why needed"
    }
  ],
  "confidence": 88
}`;

export const EXECUTION_PROMPT = `You are a browser automation agent. One action at a time. JSON only.

{MEMORY}

CANONICAL SITE URLS — USE THESE EXACTLY. NEVER GUESS OR CONSTRUCT A URL:
{URL_REFERENCE}

AVAILABLE ACTIONS:
- navigate          → {{"action":"navigate","url":"https://..."}}
- read_body         → {{"action":"read_body"}} — full page text (use for HN/Wiki/Reddit/news)
- getSnapshot       → {{"action":"getSnapshot"}} — get interactive elements
- click             → {{"action":"click","label":"exact label text"}}
- type              → {{"action":"type","label":"field label","value":"text to type"}}
- submit            → {{"action":"submit","label":"input label"}}
- scroll            → {{"action":"scroll","direction":"down","amount":400}}
- wait              → {{"action":"wait","seconds":3}}
- llm_generate      → {{"action":"llm_generate","prompt":"Generate an email about X"}} — calls LLM API directly
- vision            → {{"action":"vision","prompt":"What do you see?"}}
- human-handoff     → {{"action":"human-handoff","reason":"why"}}
- DONE              → {{"action":"DONE","value":"complete result with ALL data"}}

RULES — READ BEFORE EVERY STEP:
1. Output ONLY a single JSON object. No markdown, no prose.
2. Check MEMORY above. If data is already in collected{{}}, DO NOT navigate there again.
3. For read-only pages: read_body immediately after navigate. Never getSnapshot/click on them.
   IF read_body returns only navigation text (< 200 chars of real content, no post/article titles):
   → The site uses Web Components or shadow DOM. Try ONE of these in order:
     a) Append .json to the current URL and navigate there (works for Reddit, HN)
        Example: reddit.com/r/rust/top.json?t=day&limit=10
     b) Use getSnapshot to find post link elements and click the first real result
     c) Try a different URL format for the same content
4. For text/code generation: try llm_generate FIRST (fastest). If it fails or errors appear in memory → navigate to a browser-based AI instead:
   - Try chatgpt.com, then gemini.google.com, then claude.ai, then search Google for "free AI chat online"
   - Be adaptive: if one approach fails, reason about WHY and try something different
5. Use LABEL not target_id. Example: {{"action":"type","label":"To recipients","value":"x@y.com"}}
6. If same action has appeared in memory.actions_done → pick a DIFFERENT action. Never repeat a failed action.
7. DONE value = complete answer including all collected data. Not "task complete".
8. Add "thought": one sentence explaining your reasoning. Add "confidence": 0-100.
9. If confidence < 40 → human-handoff.
10. TYPING RULE — CRITICAL: Before typing into ANY input field, you MUST click it first to give it focus.
    Correct sequence: click(field label) → type(field label, value) → click(submit button)
    NEVER call type on a field you have not clicked first. Text typed without focus lands nowhere.
    Example for a search box: first {{"action":"click","label":"Search"}} then {{"action":"type","label":"Search","value":"your query"}}
11. ADAPTIVE INTELLIGENCE: You are like a human with a browser. If something is blocked, slow, or broken:
    - Search Google for an alternative approach
    - Try a different website that does the same thing
    - Use a different action sequence
    - NEVER loop the same failed action more than once
12. URL RULE — CRITICAL: When you need to navigate to a website, look it up in
    CANONICAL SITE URLS above and copy the URL exactly.
    NEVER construct URLs from site names — this causes hallucinations like "amazonsite.com".
    If the site is not in the list, use: https://www.{exact-domain-from-task-text}
    Example: task says "Amazon.com" → {{"action":"navigate","url":"https://www.amazon.com"}}
    Example: task says "BestBuy.com" → {{"action":"navigate","url":"https://www.bestbuy.com"}}

Current plan step: {PLAN_STEP}

What is the SINGLE best next action? Reply with JSON only.`;

export const COMPLETION_CHECK_PROMPT = `Check if a browser automation task was actually completed.

TASK: "{TASK}"
EXPECTED OUTPUT: "{DELIVERABLE}"
ACTUAL RESULT: "{RESULT}"
STEPS TAKEN: {STEPS}
MEMORY COLLECTED: {COLLECTED}

Rules for checking:
- If task was "send email": look for confirmation text in result or memory
- If task was "find article": look for actual article title in result
- If task was "get data": check if data appears in collected
- PARTIAL means something was done but the main goal wasn't finished
- FAILED means nothing useful was accomplished

Reply ONLY with JSON:
{{
  "is_complete": true,
  "verdict": "COMPLETE|PARTIAL|FAILED",
  "completion_pct": 95,
  "what_succeeded": ["list"],
  "what_failed": ["list"],
  "resume_instruction": "if PARTIAL/FAILED: exact next action to take"
}}`;

// ─────────────────────────────────────────────────────────────────────
// AGENT 1 — NEW FUNCTIONS (v13 HILO)
// ─────────────────────────────────────────────────────────────────────

// ── A1-1 — parseJSON ─────────────────────────────────────────────────
// Robustly extracts JSON from LLM response.
// Handles: raw JSON, ```json fences, ``` fences, JSON embedded in prose.
export function parseJSON(text) {
  if (!text || typeof text !== 'string') {
    throw new Error('parseJSON: empty or non-string input');
  }

  // 1. Try direct parse (cleanest case — LLM followed instructions)
  try {
    return JSON.parse(text.trim());
  } catch (_) {}

  // 2. Extract from ```json ... ``` code fence
  const jsonFence = text.match(/```json\s*([\s\S]*?)```/);
  if (jsonFence) {
    try { return JSON.parse(jsonFence[1].trim()); } catch (_) {}
  }

  // 3. Extract from ``` ... ``` code fence (no language tag)
  const plainFence = text.match(/```\s*([\s\S]*?)```/);
  if (plainFence) {
    try { return JSON.parse(plainFence[1].trim()); } catch (_) {}
  }

  // 4. Find first { ... } JSON object in the text (LLM added prose around it)
  const objMatch = text.match(/\{[\s\S]*\}/);
  if (objMatch) {
    try { return JSON.parse(objMatch[0]); } catch (_) {}
  }

  throw new Error(
    `parseJSON: No valid JSON found in LLM response.\n` +
    `First 300 chars: ${text.substring(0, 300)}`
  );
}

// ── A1-2 — validatePlan ──────────────────────────────────────────────
// Validates the JSON plan structure before any execution starts.
// Normalises step.id from step.n if needed (backward compat).
// Throws with a clear message so the caller can surface the error.
export function validatePlan(plan) {
  if (!plan || typeof plan !== 'object') {
    throw new Error('validatePlan: plan is not an object');
  }
  if (!Array.isArray(plan.steps)) {
    throw new Error('validatePlan: plan.steps is not an array');
  }
  if (plan.steps.length === 0) {
    throw new Error('validatePlan: plan has no steps');
  }
  if (plan.steps.length > 50) {
    throw new Error(`validatePlan: plan has ${plan.steps.length} steps — max is 50. Simplify.`);
  }

  const validActions = new Set([
    'navigate', 'read_body', 'getSnapshot', 'click', 'type',
    'submit', 'scroll', 'wait', 'llm_generate', 'vision',
    'human-handoff', 'DONE',
  ]);

  plan.steps.forEach((step, i) => {
    const pos = `Step ${i + 1}`;

    // Normalise: old prompt used "n", new uses "id" — support both
    if (!step.id && step.n) step.id = step.n;
    if (!step.id) step.id = i + 1;

    if (!step.action) {
      throw new Error(`validatePlan: ${pos} missing "action" field`);
    }
    if (!validActions.has(step.action)) {
      throw new Error(`validatePlan: ${pos} has unknown action "${step.action}"`);
    }
    if (step.action === 'navigate' && !step.url) {
      throw new Error(`validatePlan: ${pos} is "navigate" but missing "url"`);
    }
    if (step.action === 'llm_generate' && !step.prompt) {
      throw new Error(`validatePlan: ${pos} is "llm_generate" but missing "prompt"`);
    }
    if ((step.action === 'type' || step.action === 'click') && !step.label) {
      throw new Error(`validatePlan: ${pos} action "${step.action}" missing "label"`);
    }
  });

  return true;
}

// ── A1-3 — generatePlan ──────────────────────────────────────────────
// Main entry point for planning. Orchestrates:
//   1. Build prompt from PLANNING_PROMPT template
//   2. Call LLM via generateTextWithLLM()
//   3. Parse response with parseJSON()
//   4. Validate structure with validatePlan()
//   5. Return { plan, stepCount } — the shape executePlan() expects
//
// Usage (from background.js):
//   const { plan, stepCount } = await generatePlan(goal, strategy, { deliverable });
export async function generatePlan(goal, strategy = 'multi_step', context = {}) {
  console.log(`[PLANNER v13] 🧠 Generating JSON plan...`);
  console.log(`[PLANNER v13] Goal: ${goal}`);
  console.log(`[PLANNER v13] Strategy: ${strategy}`);

  const prompt = PLANNING_PROMPT
    .replace('{TASK}', goal)
    .replace('{STRATEGY}', strategy)
    .replace('{GOAL}', goal)
    .replace('{DELIVERABLE}', context.deliverable || 'Complete the task successfully')
    // BRAIN FIX v13.1: inject canonical URL map so planner never guesses domain names
    .replace('{URL_REFERENCE}', buildUrlReference());

  const systemPrompt =
    'You are a browser automation planner. ' +
    'Output ONLY valid JSON — no markdown fences, no prose, no explanation. ' +
    'Your entire response must be parseable by JSON.parse().';

  const llmResult = await generateTextWithLLM(prompt, systemPrompt, 800);

  if (!llmResult.success) {
    throw new Error(`generatePlan: LLM call failed — ${llmResult.error}`);
  }

  let plan;
  try {
    plan = parseJSON(llmResult.text);
  } catch (e) {
    throw new Error(
      `generatePlan: Failed to parse plan JSON.\n` +
      `Parse error: ${e.message}\n` +
      `LLM provider: ${llmResult.provider}`
    );
  }

  // Normalise: ensure all steps have numeric id (handles legacy "n" field)
  if (Array.isArray(plan.steps)) {
    plan.steps = plan.steps.map((s, i) => ({
      ...s,
      id: s.id ?? s.n ?? (i + 1),
    }));
  }

  // Validate — throws with clear message on failure
  validatePlan(plan);

  const stepSummary = plan.steps.map(s => `${s.id}:${s.action}`).join(' → ');
  console.log(`[PLANNER v13] ✅ Valid plan: ${plan.steps.length} steps`);
  console.log(`[PLANNER v13] Steps: ${stepSummary}`);

  return {
    plan,
    stepCount: plan.steps.length,
  };
}

// ─────────────────────────────────────────────────────────────────────
// REPORT FORMATTER (unchanged from v9)
// ─────────────────────────────────────────────────────────────────────
export function formatReport(task, result, history, memoryCollected) {
  const ok   = history.filter(h => h.status === 'success').length;
  const fail = history.filter(h => h.status === 'error').length;
  return {
    task,
    result:   result || 'No result captured',
    summary:  { steps_completed: ok, steps_failed: fail, data_collected: Object.keys(memoryCollected || {}).length },
    collected: memoryCollected,
    timestamp: new Date().toISOString(),
  };
}

// ─────────────────────────────────────────────────────────────────────
// BRAIN FIX v13.1 — buildExecutionPrompt
// ─────────────────────────────────────────────────────────────────────
// background.js imports EXECUTION_PROMPT as a raw template string and
// calls .replace() on it for {MEMORY} and {PLAN_STEP}. The new
// {URL_REFERENCE} placeholder was added for the brain-fix but background.js
// doesn't know about it yet. Two solutions:
//
// OPTION A (recommended): background.js switches to calling this function
//   instead of importing EXECUTION_PROMPT directly. One extra import, zero
//   other changes needed.
//
// OPTION B (backward-compat): background.js keeps doing what it does —
//   this function is called internally by the agent-planner for any
//   execution prompt it builds, and {URL_REFERENCE} gets filled in here.
//   If background.js still uses the raw string, the {URL_REFERENCE}
//   placeholder just appears literally in the prompt (harmless but suboptimal).
//   To fix: in background.js, change the import line:
//     import { EXECUTION_PROMPT } from './agent-planner.js'
//   to:
//     import { buildExecutionPrompt } from './agent-planner.js'
//   and change usage:
//     EXECUTION_PROMPT.replace('{MEMORY}', ...).replace('{PLAN_STEP}', ...)
//   to:
//     buildExecutionPrompt(memory, planStep)
//
// Usage:
//   const prompt = buildExecutionPrompt(serializedMemory, currentPlanStep);
export function buildExecutionPrompt(memory = '', planStep = 'Not set') {
  return EXECUTION_PROMPT
    .replace('{MEMORY}',       memory)
    .replace('{PLAN_STEP}',    planStep)
    .replace('{URL_REFERENCE}', buildUrlReference());
}

// ─────────────────────────────────────────────────────────────────────
// A1-5 — TEST HANDLER (for console testing)
// ─────────────────────────────────────────────────────────────────────
// Test command (paste in Service Worker console):
//   chrome.runtime.sendMessage({
//     action: 'test_planning',
//     goal: 'Send email about #1 HN article to test@example.com'
//   }, r => console.log(r));
if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    if (request.action !== 'test_planning') return false;

    const goal = request.goal || 'Send email about #1 HN article';
    console.log(`[PLANNER v13] 🧪 test_planning: "${goal}"`);

    generatePlan(goal, 'multi_step', { deliverable: 'Task completed' })
      .then(({ plan, stepCount }) => {
        console.log(`[PLANNER v13] ✅ test_planning PASS — ${stepCount} steps`);
        sendResponse({ success: true, plan, stepCount });
      })
      .catch(err => {
        console.error(`[PLANNER v13] ❌ test_planning FAIL:`, err.message);
        sendResponse({ success: false, error: err.message });
      });

    return true; // keep channel open for async sendResponse
  });
}
