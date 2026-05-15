// src/notifier.js — Notification System v10
// Sends Chrome system notifications AND posts messages to the Lovable UI.
// Both toast (auto-dismiss) and persistent banners are supported.
//
// v10 additions (Gap 3):
//  ✅ notifySessionExpired() — system notification + DB record + UI event
//     when a task hits a login wall mid-execution. Manual resume only.

import * as DB from "./db.js";

// ── Send Chrome OS notification (system tray) ──────────────────────
export async function showSystemNotification(title, message, type = "basic") {
  const id = `hubtique_${Date.now()}`;
  chrome.notifications.create(id, {
    type,
    iconUrl: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 48 48'><text y='36' font-size='36'>🤖</text></svg>",
    title,
    message,
    priority: 2,
    requireInteraction: type === "persistent",
  });
  return id;
}

// ── Post to Lovable UI (the web app) ──────────────────────────────
// This sends a message to all tabs of the connected Lovable app.
export async function postToUI(eventType, payload) {
  try {
    const tabs = await chrome.tabs.query({ url: ["*://*.lovable.app/*", "http://localhost:*/*"] });
    for (const tab of tabs) {
      chrome.tabs.sendMessage(tab.id, { hubtique_event: eventType, ...payload }).catch(() => {});
    }
  } catch (_) {}
}

// ── Notify: all providers failed, user needs to add more ──────────
export async function notifyNeedsProviders(taskId, taskName, attemptCount, retryInMs) {
  const minutes = Math.ceil(retryInMs / 60000);

  // System notification
  await showSystemNotification(
    `⚠️ Task Paused: ${taskName}`,
    `All AI providers are rate-limited (attempt ${attemptCount}). Auto-retry in ${minutes} min. Open Hubtique to add more free providers.`
  );

  // Persist to DB so UI can read it
  await DB.createNotification({
    task_id: taskId,
    type: "needs_providers",
    severity: "warning",
    title: `⚠️ "${taskName}" paused — providers rate-limited`,
    message: `Attempted ${attemptCount} times. All providers hit rate limits. Adding a new free API key will resume this task immediately. Otherwise auto-retry in ${minutes} min.`,
    actions: [
      { label: "+ Add Groq (free)", link: "/vault?add=groq" },
      { label: "+ Add NVIDIA NIM (free — DeepSeek R1)", link: "/vault?add=nvidia" },
      { label: "+ Add Cerebras (free)", link: "/vault?add=cerebras" },
      { label: "+ Add SambaNova (free)", link: "/vault?add=sambanova" },
      { label: "+ Add OpenRouter (free)", link: "/vault?add=openrouter" },
      { label: "+ Add Google AI (free)", link: "/vault?add=google" },
      { label: "+ Add GitHub Models (free — GitHub PAT)", link: "/vault?add=github" },
    ],
    countdown_until: Date.now() + retryInMs,
    retry_in_ms: retryInMs,
  });

  // Push to UI
  await postToUI("task_paused", {
    taskId, taskName, attemptCount,
    message: `All providers rate-limited. Retry in ${minutes} min.`,
    retryAt: Date.now() + retryInMs,
  });

  console.log(`[NOTIFIER] ⚠️ Notified user: needs providers for task ${taskId}`);
}

// ── Notify: 2FA detected, human needed ────────────────────────────
export async function notify2FADetected(taskId, taskName, url) {
  await showSystemNotification(
    `🔐 2FA Required: ${taskName}`,
    `Human verification needed at ${url}. Open the browser tab and complete the verification, then the task will resume.`
  );

  await DB.createNotification({
    task_id: taskId,
    type: "2fa_required",
    severity: "critical",
    title: `🔐 2FA Required — ${taskName}`,
    message: `The task hit a verification screen at ${url}. Please complete the 2FA/CAPTCHA manually, then click "Resume Task".`,
    actions: [{ label: "Resume Task", action: "resume_task", taskId }],
    url,
  });

  await postToUI("2fa_required", { taskId, taskName, url });
}

// ── Notify: task completed ─────────────────────────────────────────
export async function notifyTaskComplete(taskId, taskName, provider) {
  await showSystemNotification(`✅ Task Complete: ${taskName}`, `Completed via ${provider}`);
  await postToUI("task_complete", { taskId, taskName, provider });
  await DB.logExecution(taskId, { action: "task_complete", provider });
}

// ── Notify: task permanently failed ───────────────────────────────
export async function notifyTaskFailed(taskId, taskName, reason) {
  await showSystemNotification(`❌ Task Failed: ${taskName}`, reason);
  await postToUI("task_failed", { taskId, taskName, reason });
}

// ── Notify: recurring task completed iteration ─────────────────────
export async function notifyRecurringComplete(taskId, taskName, iteration, nextRunMs) {
  const nextMins = Math.round(nextRunMs / 60000);
  await postToUI("recurring_tick", {
    taskId, taskName, iteration,
    message: `Iteration ${iteration} done. Next run in ${nextMins} min.`,
  });
}

// ── Notify: session expired mid-task, human must re-login ─────────
// Manual resume only — task is paused at its last checkpoint.
// UI should show a "Re-login & Resume" button that opens the loginUrl tab
// and surfaces a "Resume Task" action once the user is back.
export async function notifySessionExpired(taskId, taskName, loginUrl) {
  // System tray notification — gets the user's attention even if the
  // Lovable app tab is in the background.
  await showSystemNotification(
    `🔒 Session Expired: ${taskName}`,
    `Your login session ended mid-task. Re-login at ${loginUrl}, then click "Resume Task" — progress is saved.`
  );

  // Persist to DB so the UI can display this after reconnect / refresh.
  await DB.createNotification({
    task_id: taskId,
    type: "session_expired",
    severity: "critical",
    title: `🔒 Session expired — "${taskName}" paused`,
    message:
      `The task was running and the browser was redirected to a login page at:\n${loginUrl}\n\n` +
      `All progress is saved. Re-login in the browser tab, then click "Resume Task" to continue from where it left off.`,
    actions: [
      { label: "Open Login Page", action: "open_url", url: loginUrl },
      { label: "Resume Task",     action: "resume_task", taskId },
    ],
    url: loginUrl,
  });

  // Push live event to Lovable UI (if the tab is open).
  await postToUI("session_expired", {
    taskId,
    taskName,
    loginUrl,
    message: `Session expired at ${loginUrl}. Re-login then resume.`,
  });

  console.log(`[NOTIFIER] 🔒 Session expired notified for task ${taskId} — login required at ${loginUrl}`);
}

// ── Flush unshown notifications to UI on connect ──────────────────
export async function flushPendingNotifications() {
  const pending = await DB.getUnshownNotifications();
  for (const n of pending) {
    await postToUI("notification", n);
    await DB.markNotificationShown(n.id);
  }
}
