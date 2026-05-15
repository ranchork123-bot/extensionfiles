// src/blocker-handler.js — Hubtique OS v14.0
// ─────────────────────────────────────────────────────────────────────
// Extended blocker handling beyond what content.js autoDismissPopups()
// already covers. This module handles blockers that require background.js
// coordination (e.g. injecting scripts, sending keys, navigating away).
//
// content.js already handles:
//   ✅ Amazon geo popup (Dismiss button)
//   ✅ BestBuy zip code modal (v14.0 added)
//   ✅ Generic dismiss labels (Close, No thanks, OK, Got it, etc.)
//
// This module adds:
//   ✅ Age gates (click "I am 18+" or "Enter" — never provide real DOB)
//   ✅ Newsletter popups without standard labels
//   ✅ GDPR/cookie consent (Accept all — acceptable for automation)
//   ✅ Paywalls — detect and switch to archive.ph fallback
//   ✅ Login walls — detect and human-handoff
//   ✅ Rate limit / "slow down" pages — wait and retry
//   ✅ Site-down / 5xx — wait and retry
//
// Called by: workflow-engine.js handleBlockers(node, tabId)
// Called by: background.js as part of each node's pre-execution check
//
// Exports:
//   handleBlockers(node, tabId, extId)
//     → { handled: bool, action: string, waitMs: number, humanHandoff: bool }
// ─────────────────────────────────────────────────────────────────────

// ── BLOCKER DEFINITIONS ──────────────────────────────────────────────
// Each blocker entry:
//   detect   — function(url, pageText, visionDescription) → bool
//   handle   — async function(tabId, extId) → { handled, action, waitMs }
//   severity — 'dismiss' | 'wait' | 'fallback' | 'human'
const BLOCKERS = [

  // ── Cookie/GDPR consent banners ────────────────────────────────────
  {
    name:     'cookie_consent',
    severity: 'dismiss',
    detect(url, text, vision) {
      if (vision?.blockers?.some(b => /cookie|gdpr|consent/i.test(b))) return true;
      return /accept (all )?cook|agree to cook|we use cook|cookie policy|gdpr consent/i.test(text);
    },
    async handle(tabId, extId) {
      const clicked = await _injectAndClick(tabId, () => {
        const LABELS = [
          /^accept all$/i, /^accept cookies$/i, /^agree$/i,
          /^i agree$/i, /^ok$/i, /^got it$/i, /^allow all$/i,
          /^allow cookies$/i, /^continue$/i, /^accept$/i,
        ];
        const btns = Array.from(document.querySelectorAll(
          'button, [role="button"], input[type="button"], a[href="#"]'
        ));
        for (const btn of btns) {
          const txt = (btn.innerText || btn.getAttribute('aria-label') || '').trim();
          if (LABELS.some(r => r.test(txt))) {
            const r = btn.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) { btn.click(); return true; }
          }
        }
        return false;
      });
      return { handled: clicked, action: 'clicked_cookie_accept', waitMs: 500 };
    },
  },

  // ── Age gate ────────────────────────────────────────────────────────
  {
    name:     'age_gate',
    severity: 'dismiss',
    detect(url, text, vision) {
      if (vision?.current_page_type === 'age_gate') return true;
      return /confirm.*age|are you (18|21|over)|age verification|you must be/i.test(text);
    },
    async handle(tabId, extId) {
      const clicked = await _injectAndClick(tabId, () => {
        const LABELS = [
          /^i am (18|21)\+?$/i, /^enter$/i, /^yes,? i am/i,
          /^continue$/i, /^confirm age$/i, /^i('m| am) over/i,
        ];
        const btns = Array.from(document.querySelectorAll('button, [role="button"], a'));
        for (const btn of btns) {
          const txt = (btn.innerText || '').trim();
          if (LABELS.some(r => r.test(txt))) { btn.click(); return true; }
        }
        // Try DOB fields: set to a fixed adult date and submit
        const year = document.querySelector('select[name*="year"],input[name*="year"]');
        if (year) {
          year.value = '1990';
          year.dispatchEvent(new Event('change', { bubbles: true }));
          const submit = document.querySelector('button[type="submit"],input[type="submit"]');
          if (submit) { submit.click(); return true; }
        }
        return false;
      });
      return { handled: clicked, action: 'dismissed_age_gate', waitMs: 800 };
    },
  },

  // ── Newsletter / promo popup ─────────────────────────────────────────
  {
    name:     'newsletter_popup',
    severity: 'dismiss',
    detect(url, text, vision) {
      if (vision?.blockers?.some(b => /newsletter|subscribe|promo/i.test(b))) return true;
      return /subscribe.*newsletter|sign up for (deals|offers|news)|get \d+% off.*email/i.test(text);
    },
    async handle(tabId, extId) {
      // Try Escape first — works for most modal popups
      await _sendEscape(tabId);
      await _sleep(300);
      // Then try close buttons
      const clicked = await _injectAndClick(tabId, () => {
        const LABELS = [/^no thanks$/i, /^no,? thanks$/i, /^close$/i, /^not now$/i, /^skip$/i, /^×$/i, /^x$/i];
        const els = Array.from(document.querySelectorAll(
          'button, [role="button"], [aria-label="Close"], [aria-label="close"], [class*="close"], [class*="dismiss"]'
        ));
        for (const el of els) {
          const txt = (el.innerText || el.getAttribute('aria-label') || '').trim();
          if (!txt || LABELS.some(r => r.test(txt))) {
            const r = el.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) { el.click(); return true; }
          }
        }
        return false;
      });
      return { handled: true, action: 'dismissed_newsletter_popup', waitMs: 400 };
    },
  },

  // ── Paywall ──────────────────────────────────────────────────────────
  {
    name:     'paywall',
    severity: 'fallback',
    detect(url, text, vision) {
      return /subscribe to (read|continue|access)|this (article|story|content) is.*member|sign up to read|you('ve| have) read.*free (article|story)/i.test(text);
    },
    async handle(tabId, extId, currentUrl) {
      // Switch to archive.ph to bypass paywall
      const archiveUrl = `https://archive.ph/${currentUrl}`;
      console.log(`[BLOCKER v14] Paywall detected — trying archive.ph: ${archiveUrl}`);
      await _navigate(tabId, extId, archiveUrl);
      return { handled: true, action: `paywall_fallback:${archiveUrl}`, waitMs: 3000 };
    },
  },

  // ── Rate limit / "too many requests" ────────────────────────────────
  {
    name:     'rate_limit',
    severity: 'wait',
    detect(url, text, vision) {
      return /too many requests|rate limit|please wait|slow down|429/i.test(text) ||
             vision?.current_page_type === 'error' && /429|rate/i.test(vision.raw_description);
    },
    async handle(tabId, extId) {
      console.log(`[BLOCKER v14] Rate limit detected — waiting 15s then retrying`);
      await _sleep(15_000);
      return { handled: true, action: 'waited_rate_limit', waitMs: 0 };
    },
  },

  // ── Server error (5xx) ───────────────────────────────────────────────
  {
    name:     'server_error',
    severity: 'wait',
    detect(url, text, vision) {
      return /500 (internal server|error)|502 bad gateway|503 service unavailable|504 gateway/i.test(text);
    },
    async handle(tabId, extId) {
      console.log(`[BLOCKER v14] Server error — waiting 10s then retrying`);
      await _sleep(10_000);
      return { handled: true, action: 'waited_server_error', waitMs: 0 };
    },
  },

  // ── Login wall ───────────────────────────────────────────────────────
  // Detected last — only fires if other blockers didn't match.
  {
    name:     'login_wall',
    severity: 'human',
    detect(url, text, vision) {
      return vision?.current_page_type === 'login' ||
             /sign in to (continue|access|view)|please (log|sign) in|session expired/i.test(text);
    },
    async handle(tabId, extId) {
      console.log(`[BLOCKER v14] Login wall — human handoff required`);
      return { handled: false, action: 'login_wall', waitMs: 0, humanHandoff: true };
    },
  },

];

// ── handleBlockers ───────────────────────────────────────────────────
// Main export. Checks all blockers against current page state.
// node.blocker_handlers from the workflow are checked FIRST (specific),
// then the general BLOCKERS array (broad coverage).
//
// Returns:
//   { handled: bool, action: string, waitMs: number, humanHandoff: bool }
export async function handleBlockers(node, tabId, extId, visionDescription = null) {
  const url  = visionDescription?.current_url_visible || '';
  const text = await _getPageText(tabId, extId);

  // 1. Node-specific blocker handlers (from workflow definition)
  if (node?.blocker_handlers?.length) {
    for (const bh of node.blocker_handlers) {
      const ifSee = bh.if_see?.toLowerCase() || '';
      const isPresent =
        (visionDescription?.blockers || []).some(b => b.toLowerCase().includes(ifSee)) ||
        text.toLowerCase().includes(ifSee);

      if (isPresent) {
        console.log(`[BLOCKER v14] Node-specific blocker matched: "${bh.if_see}" → ${bh.do}`);
        if (/human.?handoff|captcha/i.test(bh.do)) {
          return { handled: false, action: bh.if_see, waitMs: 0, humanHandoff: true };
        }
        if (/escape/i.test(bh.do)) {
          await _sendEscape(tabId);
          return { handled: true, action: `escaped:${bh.if_see}`, waitMs: 500 };
        }
        // Otherwise, the node's execution step will handle it naturally
        return { handled: false, action: `node_handler_noted:${bh.if_see}`, waitMs: 0 };
      }
    }
  }

  // 2. General blocker sweep
  for (const blocker of BLOCKERS) {
    if (blocker.detect(url, text, visionDescription)) {
      console.log(`[BLOCKER v14] General blocker matched: ${blocker.name} (${blocker.severity})`);
      const result = await blocker.handle(tabId, extId, url);
      return result;
    }
  }

  return { handled: false, action: 'no_blocker', waitMs: 0 };
}

// ── Internal helpers ─────────────────────────────────────────────────

async function _injectAndClick(tabId, fn) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func:   fn,
    });
    return results?.[0]?.result === true;
  } catch (e) {
    console.warn(`[BLOCKER v14] injectAndClick failed: ${e.message}`);
    return false;
  }
}

async function _sendEscape(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func:   () => {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
        document.dispatchEvent(new KeyboardEvent('keyup',   { key: 'Escape', keyCode: 27, bubbles: true }));
      },
    });
  } catch (e) {
    console.warn(`[BLOCKER v14] sendEscape failed: ${e.message}`);
  }
}

async function _navigate(tabId, extId, url) {
  try {
    await chrome.tabs.update(tabId, { url });
  } catch (e) {
    console.warn(`[BLOCKER v14] navigate failed: ${e.message}`);
  }
}

async function _getPageText(tabId, extId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func:   () => (document.body?.innerText || '').toLowerCase().substring(0, 3000),
    });
    return results?.[0]?.result || '';
  } catch (_) {
    return '';
  }
}

function _sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
