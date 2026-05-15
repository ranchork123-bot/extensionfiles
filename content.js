// content.js — Hubtique OS v11.2-FIXED
// ─────────────────────────────────────────────────────────────────────
// v11.2-FIXED CHANGES:
//  ✅ FIX-ELLABEL-v14.3 — elLabel() in findBySemanticLabel() was reading
//              aria-label RAW without stripping keyboard shortcut hints.
//              getLabel() (used at snapshot build time) strips them, but
//              elLabel() didn't — so "Search Amazon" never matched
//              "Search Amazon (Alt+/)" in the fallback resolver.
//              Fix: same two strip regexes now applied in both functions.
//              Result: Search button click now resolves correctly when
//              the xpath/registry lookup fails after typing into the field.
//
// v11.1-FIXED CHANGES:
//  ✅ FIX-C1 — __omni_registry__ was NEVER populated.
//              task-executor.js does `window.__omni_registry__[tid]` expecting
//              `{ el, label, type }` but content.js only set __omni_snapshot__
//              which stores xpath strings, not live element references.
//              Fix: __omni_snapshot__ now also populates window.__omni_registry__
//              with { el, label, role } so click/type/submit in task-executor work.
//
// v11.0 FIXES (carried forward unchanged):
//  ✅ Bug 1 fix — type() Gmail To field: Tab keydown/keyup instead of blur+focus
//  ✅ Bug 3 fix — type() contenteditable: execCommand('insertText') instead of
//                 char-by-char el.textContent loop
//  ✅ P2-A      — Shadow DOM traversal in __omni_snapshot__
// ─────────────────────────────────────────────────────────────────────

(function () {
  'use strict';

  // ── FIX 2 — React synthetic event helper ─────────────────────────
  function setNativeValue(el, value) {
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, 'value'
    )?.set;
    const nativeTextareaSetter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype, 'value'
    )?.set;
    if (nativeInputValueSetter && el.tagName === 'INPUT') {
      nativeInputValueSetter.call(el, value);
    } else if (nativeTextareaSetter && el.tagName === 'TEXTAREA') {
      nativeTextareaSetter.call(el, value);
    } else if (el.isContentEditable) {
      el.textContent = value;
    } else {
      el.value = value;
    }
    el.dispatchEvent(new Event('input',  { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // ── FIX 8 — Semantic label extractor (data-testid fallback) ──────
  function getLabel(el) {
    let al = el.getAttribute('aria-label');
    if (al?.trim()) {
      // v14.0: Strip keyboard shortcut hints so "Search Amazon (Alt+/)" → "Search Amazon"
      // and the LLM doesn't try to click "alt, forward slash" as a key sequence.
      al = al.replace(/\s*[\(\[]\s*(?:Alt|Ctrl|Shift|Cmd|Meta|⌘|⌥)[^)\]]*[\)\]]/gi, '').trim();
      al = al.replace(/\s*,\s*(alt|ctrl|shift|forward slash|backspace|enter|escape)[^,]*/gi, '').trim();
      if (al) return al;
    }

    const alby = el.getAttribute('aria-labelledby');
    if (alby) {
      const ref = document.getElementById(alby);
      if (ref?.innerText?.trim()) return ref.innerText.trim();
    }

    const id = el.getAttribute('id');
    if (id) {
      const lbl = document.querySelector(`label[for="${CSS.escape(id)}"]`);
      if (lbl?.innerText?.trim()) return lbl.innerText.trim();
    }

    const wrap = el.closest('label');
    if (wrap) {
      const clone = wrap.cloneNode(true);
      clone.querySelectorAll('input,textarea,select').forEach(n => n.remove());
      const t = clone.innerText.trim();
      if (t) return t;
    }

    const ph = el.getAttribute('placeholder');
    if (ph?.trim()) return ph.trim();

    const nm = el.getAttribute('name');
    if (nm) return nm.replace(/[_-]/g, ' ').trim();

    const txt = (el.innerText || el.getAttribute('value') || '').replace(/\s+/g, ' ').trim();
    if (txt && txt.length < 80) return txt;

    const ti = el.getAttribute('title');
    if (ti?.trim()) return ti.trim();

    const testId = el.getAttribute('data-testid');
    if (testId) return testId.replace(/[-_]/g, ' ').trim();

    return el.getAttribute('type') || el.tagName.toLowerCase();
  }

  function isVisible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    const style = window.getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden' &&
           parseFloat(style.opacity) > 0;
  }

  // ── AUTO-DISMISS POPUPS / MODALS ─────────────────────────────────
  // Runs before every snapshot so overlays don't block element detection.
  // Covers: Amazon geo popup ("Dismiss"), cookie banners, generic overlays.
  // Only clicks buttons whose visible text matches a safe dismiss label —
  // never clicks "Accept all" for cookies or "Change Address" etc.
  function autoDismissPopups() {
    const DISMISS_LABELS = [
      /^dismiss$/i, /^no thanks$/i, /^close$/i, /^not now$/i,
      /^skip$/i,    /^maybe later$/i, /^got it$/i, /^ok$/i,
      /^continue$/i, /^accept$/i, /^i understand$/i,
    ];
    // Amazon-specific: the geo popup has a "Dismiss" button
    // Selector targets the dismiss button inside the popover, not "Change Address"
    const amazonDismiss = document.querySelector(
      '[data-action="a-popover-close"] button, ' +
      'button[data-action="a-popover-close"], ' +
      '#nav-global-location-popover-link ~ * button:first-of-type, ' +
      '.a-popover-wrapper button.a-button-close'
    );
    if (amazonDismiss && isVisible(amazonDismiss)) {
      try { amazonDismiss.click(); } catch (_) {}
      return; // one dismiss per snapshot call is enough
    }
    // v14.0: BestBuy zip code modal — dismiss by close button or Escape key
    const bestBuyZip = document.querySelector(
      '.zip-modal, [data-testid="zip-modal"], ' +
      '[class*="ZipModal"], [class*="zipModal"], ' +
      '[class*="zip-code-modal"], ' +
      'button[aria-label="Close"][class*="modal"], button[aria-label="close"][class*="modal"]'
    );
    if (bestBuyZip && isVisible(bestBuyZip)) {
      try { bestBuyZip.click(); return; } catch (_) {}
      // Fallback: Escape key dismisses most modals
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
      return;
    }
    // Generic: scan all visible buttons for safe dismiss labels
    const buttons = Array.from(document.querySelectorAll(
      'button, [role="button"], input[type="button"]'
    ));
    for (const btn of buttons) {
      if (!isVisible(btn)) continue;
      const txt = (
        btn.getAttribute('aria-label') ||
        btn.getAttribute('title') ||
        btn.innerText || ''
      ).trim();
      if (DISMISS_LABELS.some(r => r.test(txt))) {
        // Safety check: only dismiss if a modal/overlay is actually present
        const hasOverlay = !!document.querySelector(
          '.a-popover-wrapper, [role="dialog"], [role="alertdialog"], ' +
          '.modal, .overlay, [class*="modal"], [class*="overlay"], ' +
          '[class*="popup"], [class*="Popup"]'
        );
        if (hasOverlay) {
          try { btn.click(); } catch (_) {}
          return;
        }
      }
    }
  }

  // ── LIVE SNAPSHOT + REGISTRY (FIX-C1) ────────────────────────────
  // FIX-C1: Now populates BOTH:
  //   window.__omni_registry__  — { [ref]: { el, label, role, type } }
  //     used by task-executor.js STEPS.click/type/submit/extract
  //   window.__omni_snapshot__  — returns { snapshot, index, body, url, title }
  //     used by background.js getContent/getSnapshot handlers
  window.__omni_snapshot__ = async function () {
    // Dismiss any blocking popup before building the registry
    autoDismissPopups();
    // Give the DOM a moment to settle after any dismiss click
    await new Promise(r => setTimeout(r, 350));
    const items    = [];
    const registry = {};  // FIX-C1: live element map
    let idx = 0;

    // Skip-nav / keyboard shortcut hints that pollute the registry and
    // cause the LLM to click them instead of real interactive elements.
    const SKIP_NAV_RE = /^\s*(skip to|keyboard shortcuts?|alt\s*[\+\/]|shift\s*\+|ctrl\s*\+|→#|main content)/i;
    function isSkipNav(el, lbl) {
      if (el.getAttribute('aria-hidden') === 'true') return true;
      const href = el.getAttribute('href') || '';
      if (href.startsWith('#') && href.length > 1) return true; // anchor skip links
      if (SKIP_NAV_RE.test(lbl)) return true;
      return false;
    }

    function add(el, role, label, extra) {
      if (!isVisible(el)) return;
      if (isSkipNav(el, label)) return;
      const ref = `@e${++idx}`;
      items.push({
        ref,
        role,
        label: label.substring(0, 80).replace(/\n/g, ' ').trim(),
        extra: (extra || '').substring(0, 60),
        xpath: getXPath(el),
      });
      // FIX-C1: store live element reference so task-executor can act on it
      registry[ref] = {
        el,
        label: label.substring(0, 80).replace(/\n/g, ' ').trim(),
        role,
        type: el.getAttribute('type') || el.tagName.toLowerCase(),
      };
    }

    // Inputs
    document.querySelectorAll(
      'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]),' +
      'textarea,[contenteditable="true"],[contenteditable=""]'
    ).forEach(el => {
      const val = (el.value || el.innerText || '').trim().substring(0, 40);
      add(el, 'input', getLabel(el), val ? `value:"${val}"` : 'empty');
    });

    // Buttons / links / clickables
    document.querySelectorAll(
      'button:not([disabled]),a[href],[role="button"],[role="link"],' +
      '[role="menuitem"],[role="tab"],input[type="submit"],input[type="button"]'
    ).forEach(el => {
      const href = el.getAttribute('href');
      const extra = href && !href.startsWith('javascript') && href !== '#'
        ? `→${href.substring(0, 50)}` : '';
      add(el, 'button', getLabel(el), extra);
    });

    // Selects
    document.querySelectorAll('select').forEach(el => {
      const sel = el.options[el.selectedIndex]?.text || '';
      add(el, 'select', getLabel(el), sel ? `selected:"${sel}"` : '');
    });

    // P2-A: Shadow DOM traversal
    (function traverseShadowRoots(root) {
      root.querySelectorAll('*').forEach(el => {
        if (!el.shadowRoot) return;
        const sr = el.shadowRoot;
        sr.querySelectorAll(
          'input:not([type="hidden"]):not([type="submit"]),' +
          'textarea,[contenteditable="true"],[contenteditable=""]'
        ).forEach(inner => {
          const val = (inner.value || inner.innerText || '').trim().substring(0, 40);
          add(inner, 'input', getLabel(inner), val ? `value:"${val}"` : 'empty');
        });
        sr.querySelectorAll(
          'button:not([disabled]),a[href],[role="button"],[role="link"],' +
          '[role="menuitem"],[role="tab"],input[type="submit"],input[type="button"]'
        ).forEach(inner => {
          const href = inner.getAttribute('href');
          const extra = href && !href.startsWith('javascript') && href !== '#'
            ? `→${href.substring(0, 50)}` : '';
          add(inner, 'button', getLabel(inner), extra);
        });
        sr.querySelectorAll('select').forEach(inner => {
          const sel = inner.options[inner.selectedIndex]?.text || '';
          add(inner, 'select', getLabel(inner), sel ? `selected:"${sel}"` : '');
        });
        traverseShadowRoots(sr);
      });
    })(document);

    // FIX-C1: publish registry globally so task-executor STEPS can find elements
    window.__omni_registry__ = registry;

    const bodyText = document.body.innerText || '';

    return {
      snapshot: items.map(i =>
        `${i.ref} [${i.role}] ${i.label}${i.extra ? '  ' + i.extra : ''}`
      ).join('\n'),
      index:  items,
      body:   bodyText,
      url:    location.href,
      title:  document.title,
    };
  };

  // ── XPath generator ─────────────────────────────────────────────
  function getXPath(el) {
    if (el.id) return `//*[@id="${el.id}"]`;
    const parts = [];
    let node = el;
    while (node && node.nodeType === Node.ELEMENT_NODE) {
      let sibIdx = 1;
      let sib = node.previousSibling;
      while (sib) {
        if (sib.nodeType === Node.ELEMENT_NODE && sib.tagName === node.tagName) sibIdx++;
        sib = sib.previousSibling;
      }
      parts.unshift(`${node.tagName.toLowerCase()}[${sibIdx}]`);
      node = node.parentNode;
    }
    return '/' + parts.join('/');
  }

  // ── FIX 4 — Semantic label fallback (3-pass) ─────────────────────
  function findBySemanticLabel(role, label) {
    const needle = label.toLowerCase().replace(/\s+/g, ' ').trim();
    let pool;

    if (role === 'input') {
      pool = Array.from(document.querySelectorAll(
        'input:not([type="hidden"]):not([type="submit"]),textarea,[contenteditable="true"],[contenteditable=""]'
      ));
    } else if (role === 'select') {
      pool = Array.from(document.querySelectorAll('select'));
    } else {
      pool = Array.from(document.querySelectorAll(
        'button,a[href],[role="button"],[role="link"],[role="menuitem"],[role="tab"],input[type="submit"]'
      ));
    }

    function elLabel(el) {
      // FIX-ELLABEL-v14.3: strip keyboard shortcut hints before matching.
      // getLabel() (used at snapshot-build time) already strips these, but
      // elLabel() was reading aria-label raw — so "Search Amazon (Alt+/)"
      // never matched the snapshot label "Search Amazon". Now they agree.
      let raw = (
        el.getAttribute('aria-label') ||
        el.getAttribute('placeholder') ||
        el.getAttribute('data-testid') ||
        el.getAttribute('name') ||
        el.getAttribute('title') ||
        el.innerText ||
        el.getAttribute('value') || ''
      );
      raw = raw.replace(/\s*[\(\[]\s*(?:Alt|Ctrl|Shift|Cmd|Meta|⌘|⌥)[^)\]]*[\)\]]/gi, '').trim();
      raw = raw.replace(/\s*,\s*(alt|ctrl|shift|forward slash|backspace|enter|escape)[^,]*/gi, '').trim();
      return raw.toLowerCase().replace(/\s+/g, ' ').trim();
    }

    for (const el of pool) { if (!isVisible(el)) continue; if (elLabel(el) === needle) return el; }
    for (const el of pool) { if (!isVisible(el)) continue; const lbl = elLabel(el); if (lbl.startsWith(needle) || needle.startsWith(lbl)) return el; }
    for (const el of pool) { if (!isVisible(el)) continue; const lbl = elLabel(el); if (lbl.includes(needle) || needle.includes(lbl)) return el; }
    return null;
  }

  // ── ACTION EXECUTOR ────────────────────────────────────────────
  window.__omni_act__ = function (action, ref, value, snapshotIndex) {
    function findEl(r) {
      const item = (snapshotIndex || []).find(i => i.ref === r);
      if (!item) return null;

      // Check live registry first (FIX-C1 benefit: el is already known)
      if (window.__omni_registry__?.[r]?.el) {
        return window.__omni_registry__[r].el;
      }

      if (item.xpath.startsWith('//*[@id=')) {
        const idMatch = item.xpath.match(/\[@id="([^"]+)"\]/);
        if (idMatch) {
          const el = document.getElementById(idMatch[1]);
          if (el) return el;
        }
      }

      try {
        const result = document.evaluate(
          item.xpath, document, null,
          XPathResult.FIRST_ORDERED_NODE_TYPE, null
        );
        if (result.singleNodeValue && isVisible(result.singleNodeValue)) {
          return result.singleNodeValue;
        }
      } catch (_) {}

      return findBySemanticLabel(item.role, item.label);
    }

    const el = findEl(ref);

    // ── CLICK ──────────────────────────────────────────────────────
    if (action === 'click') {
      if (!el) return { success: false, error: `"${ref}" not found for click` };
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return new Promise(res => setTimeout(() => {
        const rect    = el.getBoundingClientRect();
        const centerX = rect.left + rect.width  / 2;
        const centerY = rect.top  + rect.height / 2;
        const eventOpts = { bubbles: true, cancelable: true, clientX: centerX, clientY: centerY, screenX: centerX, screenY: centerY };
        el.dispatchEvent(new MouseEvent('mouseover',  eventOpts));
        el.dispatchEvent(new MouseEvent('mouseenter', eventOpts));
        el.dispatchEvent(new MouseEvent('mousedown',  eventOpts));
        el.click();
        el.dispatchEvent(new MouseEvent('mouseup',    eventOpts));
        res({ success: true });
      }, 60 + Math.random() * 100));
    }

    // ── TYPE ───────────────────────────────────────────────────────
    if (action === 'type') {
      if (!el) return { success: false, error: `"${ref}" not found for type` };
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.focus();
      return (async () => {
        const val = String(value || '');
        if (el.isContentEditable) {
          document.execCommand('selectAll', false, null);
          document.execCommand('delete',    false, null);
          const ok = document.execCommand('insertText', false, val);
          if (!ok) el.textContent = val;
          el.dispatchEvent(new Event('input',  { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          const ariaLabel = (el.getAttribute('aria-label') || '').toLowerCase();
          const isRecipientField = ariaLabel.includes('to') || ariaLabel.includes('cc') || ariaLabel.includes('bcc') || ariaLabel.includes('recipient');
          if (isRecipientField) {
            await new Promise(r => setTimeout(r, 300));
            el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', keyCode: 9, which: 9, bubbles: true, cancelable: true }));
            el.dispatchEvent(new KeyboardEvent('keyup',   { key: 'Tab', keyCode: 9, which: 9, bubbles: true }));
          } else {
            el.dispatchEvent(new Event('blur', { bubbles: true }));
            el.focus();
          }
        } else {
          setNativeValue(el, '');
          for (const char of val) {
            await new Promise(r => setTimeout(r, 30 + Math.random() * 60));
            el.dispatchEvent(new KeyboardEvent('keydown', { key: char, code: `Key${char.toUpperCase()}`, bubbles: true, cancelable: true }));
            setNativeValue(el, el.value + char);
            el.dispatchEvent(new KeyboardEvent('keyup',   { key: char, code: `Key${char.toUpperCase()}`, bubbles: true }));
          }
          el.dispatchEvent(new Event('change', { bubbles: true }));
          el.dispatchEvent(new Event('blur',   { bubbles: true }));
          el.focus();
        }
        return { success: true, typed: val.length };
      })();
    }

    // ── SUBMIT ─────────────────────────────────────────────────────
    if (action === 'submit') {
      if (!el) return { success: false, error: `"${ref}" not found for submit` };
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true, cancelable: true }));
      el.dispatchEvent(new KeyboardEvent('keyup',   { key: 'Enter', keyCode: 13, bubbles: true }));
      if (el.form) {
        try { el.form.requestSubmit(); } catch (_) {
          el.form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        }
      }
      return { success: true };
    }

    // ── EXTRACT ────────────────────────────────────────────────────
    if (action === 'extract') {
      if (!el) {
        const item = (snapshotIndex || []).find(i => i.ref === ref);
        const hint  = item ? ` ("${item.label}")` : '';
        return { success: false, error: `${ref}${hint} not found — element may have moved. Use read_body for page text.` };
      }
      const text = el.innerText || el.value || el.textContent || '';
      return { success: true, text: text.trim() };
    }

    return { success: false, error: `Unknown action: ${action}` };
  };

  // ── BODY TEXT ────────────────────────────────────────────────────
  window.__omni_body__ = function () {
    return {
      success: true,
      text:  document.body.innerText || '',
      url:   location.href,
      title: document.title,
    };
  };

  // ── SESSION / AUTH ERROR DETECTION ──────────────────────────────
  window.__hubtique_detectAuthError__ = function () {
    const url   = location.href.toLowerCase();
    const title = (document.title || '').toLowerCase();
    const body  = (document.body.innerText || '').toLowerCase();
    let score   = 0;

    const authUrlPat = /\/(login|log-in|signin|sign-in|auth|account\/login|session\/new|oauth|sso|reauthenticate)(\/|\?|$)/;
    if (authUrlPat.test(url)) score += 2;

    const authTitlePat = /^(sign in|log in|login|sign in to|log in to|welcome back|authenticate|session expired)/;
    if (authTitlePat.test(title)) score += 2;

    const passwordInputs = Array.from(document.querySelectorAll('input[type="password"]')).filter(isVisible);
    const signInButtons  = Array.from(document.querySelectorAll('button,input[type="submit"],[role="button"]')).filter(el => {
      if (!isVisible(el)) return false;
      const lbl = (el.innerText || el.getAttribute('value') || el.getAttribute('aria-label') || '').toLowerCase();
      return /^(sign in|log in|login|continue|next|submit|get started)$/.test(lbl.trim());
    });
    if (passwordInputs.length >= 1 && signInButtons.length >= 1) score += 2;

    const bodyAuthPat = /session.{0,10}(expired|ended|timed out)|please (sign|log) in|you('ve| have) been (signed|logged) out|(sign|log) in to (continue|access)|your session|login required/;
    if (bodyAuthPat.test(body)) score += 1;

    const allInteractives = Array.from(document.querySelectorAll('input:not([type="hidden"]),button,select,textarea,[role="button"]')).filter(isVisible);
    const nonAuthInputs   = allInteractives.filter(el => {
      const type = (el.getAttribute('type') || '').toLowerCase();
      return !['email', 'password', 'submit', 'checkbox', 'radio', 'button'].includes(type) && el.tagName !== 'BUTTON';
    });
    if (allInteractives.length <= 5 && nonAuthInputs.length <= 1) score += 1;
    else if (nonAuthInputs.length > 6) score -= 2;

    return { isAuthError: score >= 3, loginUrl: location.href, score };
  };

  // ── 2FA / CAPTCHA DETECTION ─────────────────────────────────────
  window.__hubtique_detect2FA__ = function () {
    const body = (document.body.innerText || '').toLowerCase();
    const patterns = [
      /verify it.?s you/i, /enter.{0,20}code/i, /two.?factor/i,
      /2fa/i, /security check/i, /captcha/i, /prove you.?re human/i,
      /we.?ve sent a code/i, /check your.{0,20}email/i,
      /unusual.{0,20}activity/i, /confirm.{0,20}identity/i,
      /i.?m not a robot/i, /recaptcha/i,
    ];
    const urlPats = [/challenge/, /captcha/, /verify/, /checkpoint/];
    return patterns.some(p => p.test(body)) ||
           urlPats.some(p => p.test(location.href.toLowerCase())) ||
           !!document.querySelector('iframe[src*="recaptcha"],iframe[src*="captcha"]');
  };

  // ── HUMAN ACTIVITY MONITOR ───────────────────────────────────────
  let _lastActivityTime  = Date.now();
  let _lastMousePosition = { x: 0, y: 0 };
  const _INACTIVITY_TIMEOUT_MS = 5000;
  let _mouseMoveCounter = 0;

  document.addEventListener('mousemove', (e) => {
    _lastActivityTime  = Date.now();
    _lastMousePosition = { x: e.clientX, y: e.clientY };
    _mouseMoveCounter++;
    if (_mouseMoveCounter % 10 === 0) {
      chrome.runtime.sendMessage({ action: 'human_activity', type: 'mouse_move', position: _lastMousePosition, timestamp: _lastActivityTime }).catch(() => {});
    }
  }, { passive: true });

  document.addEventListener('keydown', (e) => {
    _lastActivityTime = Date.now();
    chrome.runtime.sendMessage({ action: 'human_activity', type: 'keydown', key: e.key.substring(0, 20), timestamp: _lastActivityTime }).catch(() => {});
  }, { passive: true });

  document.addEventListener('click', (e) => {
    _lastActivityTime  = Date.now();
    _lastMousePosition = { x: e.clientX, y: e.clientY };
    chrome.runtime.sendMessage({ action: 'human_activity', type: 'click', position: _lastMousePosition, target: (e.target?.name || e.target?.id || 'unknown').substring(0, 40), timestamp: _lastActivityTime }).catch(() => {});
  });

  document.addEventListener('input', (e) => {
    _lastActivityTime = Date.now();
    chrome.runtime.sendMessage({ action: 'human_activity', type: 'input', field: (e.target?.name || e.target?.id || 'unknown').substring(0, 40), timestamp: _lastActivityTime }).catch(() => {});
  }, { passive: true });

  function _isHumanActive() {
    return (Date.now() - _lastActivityTime) < _INACTIVITY_TIMEOUT_MS;
  }

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'check_human_activity') {
      sendResponse({ isActive: _isHumanActive(), lastActivityTime: _lastActivityTime, timeSinceActivity: Date.now() - _lastActivityTime, position: _lastMousePosition });
      return;
    }
    if (request.action === 'check_ready') {
      sendResponse({ ready: document.readyState === 'complete', state: document.readyState });
      return;
    }
  });

  window.hubtiqueActivityMonitor = {
    isActive:        _isHumanActive,
    getLastActivity: () => _lastActivityTime,
    getLastPosition: () => _lastMousePosition,
  };

  console.log('[Hubtique v11.1] Live snapshot engine ready — __omni_registry__ + contenteditable + React events + auth detection');
})();
