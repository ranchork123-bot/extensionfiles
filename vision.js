// src/vision.js — Hubtique OS v14.0
// ─────────────────────────────────────────────────────────────────────
// Wraps the existing captureVisibleTab infrastructure (already in
// background.js line 1739) and adds a vision-capable LLM call to
// describe what the screenshot shows in structured terms.
//
// The captureVisibleTab handler lives in the service worker (background.js)
// because only SW context can call chrome.tabs.captureVisibleTab.
// vision.js runs in the web app / CometBrowser context and sends a
// "vision" message to background.js to get the screenshot, then calls
// the vision LLM to interpret it.
//
// Called by: workflow-engine.js before each node execution
// Called by: CometBrowser.tsx before each LLM decision (Step 5)
//
// Exports:
//   captureAndDescribe(extId?)  → VisionDescription object
//   VisionDescription shape:
//     { current_site, current_url, current_page_type, blockers,
//       target_content_visible, key_elements, raw_description }
// ─────────────────────────────────────────────────────────────────────

// ── VISION PROMPT ────────────────────────────────────────────────────
// Sent to a vision-capable LLM with the screenshot attached.
// Returns structured JSON so the execution loop can make decisions
// without free-text parsing.
const VISION_PROMPT = `You are analyzing a browser screenshot for an automation agent.
Describe what you see in structured JSON so the agent knows exactly what state the browser is in.

Output ONLY valid JSON — no markdown, no prose:
{
  "current_site": "Amazon|BestBuy|Gmail|DuckDuckGo|JustPaste|Unknown|etc",
  "current_url_visible": "URL shown in address bar if readable, else null",
  "current_page_type": "homepage|search_results|product_page|form|login|captcha|error|modal_blocking|loading|other",
  "page_loaded": true,
  "blockers": [
    "cookie banner",
    "zip code modal",
    "login wall",
    "captcha",
    "age gate",
    "newsletter popup"
  ],
  "blocker_is_blocking": false,
  "target_content_visible": "describe what relevant content is visible (prices, articles, form fields, etc) or 'nothing relevant'",
  "key_interactive_elements": [
    "search box labeled X",
    "button labeled Y",
    "link to Z"
  ],
  "agent_should": "one sentence — what the agent should do next given this screen state",
  "raw_description": "2-3 sentence plain English description of the full page"
}`;

// Vision-capable models to try in order.
// Google Gemini 2.0 Flash supports vision natively and is already in rotation.js.
// OpenRouter's gpt-4o also supports vision.
const VISION_PROVIDERS = [
  {
    id:       'google',
    endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    model:    'gemini-2.0-flash',
    keyName:  'apiKey_google',
  },
  {
    id:       'openrouter',
    endpoint: 'https://openrouter.ai/api/v1/chat/completions',
    model:    'openai/gpt-4o',
    keyName:  'apiKey_openrouter',
  },
];

// ── captureAndDescribe ───────────────────────────────────────────────
// Main export. Captures a screenshot via background.js, then calls a
// vision LLM to describe it.
//
// Returns a VisionDescription object, or a safe fallback if vision
// is unavailable (no vision-capable key, no active tab, etc.).
// The caller should always get a usable object — never throws.
//
// Usage:
//   const vision = await captureAndDescribe(extId);
//   prompt = buildDynamicExecutionPrompt(node, workflow, vision.raw_description);
export async function captureAndDescribe(extId) {
  const fallback = _blindFallback();

  // Step 1: Get screenshot from background.js
  let imageData;
  try {
    imageData = await _captureScreenshot(extId);
  } catch (e) {
    console.warn(`[VISION v14] Screenshot failed: ${e.message} — running blind`);
    return fallback;
  }

  if (!imageData) {
    console.warn(`[VISION v14] No screenshot returned — running blind`);
    return fallback;
  }

  // Step 2: Call vision LLM with screenshot
  try {
    const description = await _callVisionLLM(imageData);
    console.log(`[VISION v14] ✅ Page described: ${description.current_site} / ${description.current_page_type}`);
    if (description.blockers?.length) {
      console.log(`[VISION v14] ⚠️ Blockers detected: ${description.blockers.join(', ')}`);
    }
    return description;
  } catch (e) {
    console.warn(`[VISION v14] Vision LLM failed: ${e.message} — running blind`);
    return fallback;
  }
}

// ── _captureScreenshot ───────────────────────────────────────────────
// Sends "vision" action to background.js service worker.
// background.js line 1731 handles this and calls captureVisibleTab.
async function _captureScreenshot(extId) {
  const id = extId || (typeof window !== 'undefined' && window.__hubtique_ext_id__);

  if (!id || typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) {
    throw new Error('Extension bridge not available for screenshot');
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('Screenshot timeout (10s)')),
      10_000
    );
    chrome.runtime.sendMessage(
      id,
      { action: 'vision' },
      (response) => {
        clearTimeout(timeout);
        if (chrome.runtime.lastError) {
          return reject(new Error(chrome.runtime.lastError.message));
        }
        if (!response?.success) {
          return reject(new Error(response?.error || 'vision action failed'));
        }
        resolve(response.imageData); // base64 JPEG data URL
      }
    );
  });
}

// ── _callVisionLLM ───────────────────────────────────────────────────
// Tries VISION_PROVIDERS in order. Sends the screenshot as a base64
// image message alongside the VISION_PROMPT.
async function _callVisionLLM(imageData) {
  const messages = [
    {
      role: 'user',
      content: [
        {
          type: 'image_url',
          image_url: {
            url:    imageData, // already a data:image/jpeg;base64,... URL
            detail: 'low',     // low detail = faster + cheaper, sufficient for UI state
          },
        },
        {
          type: 'text',
          text: VISION_PROMPT,
        },
      ],
    },
  ];

  for (const provider of VISION_PROVIDERS) {
    try {
      const keyData = await chrome.storage.local.get(provider.keyName);
      const apiKey  = keyData[provider.keyName];
      if (!apiKey) {
        console.log(`[VISION v14] ${provider.id}: no key, skipping`);
        continue;
      }

      const controller = new AbortController();
      const timeout    = setTimeout(() => controller.abort(), 15_000);

      const resp = await fetch(provider.endpoint, {
        method:  'POST',
        signal:  controller.signal,
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model:      provider.model,
          max_tokens: 600,
          messages,
        }),
      });
      clearTimeout(timeout);

      if (!resp.ok) {
        console.warn(`[VISION v14] ${provider.id}: HTTP ${resp.status}`);
        continue;
      }

      const data = await resp.json();
      const text = data.choices?.[0]?.message?.content?.trim();
      if (!text) continue;

      // Parse structured response
      return _parseVisionResponse(text);

    } catch (e) {
      if (e.name === 'AbortError') {
        console.warn(`[VISION v14] ${provider.id}: timeout`);
      } else {
        console.warn(`[VISION v14] ${provider.id}: ${e.message}`);
      }
    }
  }

  throw new Error('All vision providers failed or have no keys');
}

// ── _parseVisionResponse ─────────────────────────────────────────────
function _parseVisionResponse(text) {
  try { return JSON.parse(text.trim()); } catch (_) {}
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) { try { return JSON.parse(fence[1].trim()); } catch (_) {} }
  const obj = text.match(/\{[\s\S]*\}/);
  if (obj) { try { return JSON.parse(obj[0]); } catch (_) {} }
  // If JSON parse fails entirely, return a partial object with raw text
  return _blindFallback(text);
}

// ── _blindFallback ───────────────────────────────────────────────────
// Safe object returned when vision is unavailable.
// Execution continues — agent just won't have visual context.
function _blindFallback(rawText = '') {
  return {
    current_site:              'Unknown',
    current_url_visible:       null,
    current_page_type:         'unknown',
    page_loaded:               true,
    blockers:                  [],
    blocker_is_blocking:       false,
    target_content_visible:    'Vision unavailable — no screenshot or vision LLM',
    key_interactive_elements:  [],
    agent_should:              'Proceed with planned action — no visual context available',
    raw_description:           rawText || 'Vision system unavailable. Agent is running without visual feedback.',
    _vision_available:         false,
  };
}
