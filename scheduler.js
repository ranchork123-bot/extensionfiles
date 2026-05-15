// src/scheduler.js — Polling + Keepalive Scheduler v13.0
// Uses chrome.alarms (not setTimeout) so service worker stays alive.
// Polls every 30 seconds, executes ready tasks, handles retries.
//
// v13.0 CHANGES:
//  ✅ runTask: isLoopOrLimit guard — step limit / loop errors set paused_manually: true
//             prevents 10-hour auto-retry loops when HILO hits MAX_STEPS or LOOP_DETECTED
//
// v12.0 CHANGES:
//  ✅ recoverStuckTasks: stale threshold raised 30s → 120s (longer steps now exist)
//  ✅ runTask: handles VERIFY_SESSION_FAILED as alias for SESSION_EXPIRED
//  ✅ runTask: logs final result to execution log (was missing)
//  ✅ pollCycle: flushPendingNotifications only every 5th cycle (reduce noise)
//  ✅ setupAlarms: keepalive period corrected to exactly 25s (was string fraction)
//  ✅ cleanup() also called on daily_reset (kept from v10)
//  ✅ Export recoverStuckTasks so background.js can call it on startup

import * as DB from "./db.js";
import { callAI, resetDailyQuotas } from "./rotation.js";
import { executeTask } from "./task-executor.js";
import {
  notifyNeedsProviders,
  notify2FADetected,
  notifyTaskComplete,
  notifyTaskFailed,
  notifyRecurringComplete,
  flushPendingNotifications,
  notifySessionExpired,
} from "./notifier.js";

const MAX_CONCURRENT = 3;
let _running    = new Set();   // taskIds currently executing
let _pollTick   = 0;           // counts poll cycles for throttled ops

// ── Backoff: exponential (10 → 20 → 40 → 80 → 24hr max) ─────────────
function calcRetryDelay(attemptCount) {
  const base  = 10 * 60 * 1000;                // 10 min
  const delay = base * Math.pow(2, Math.min(attemptCount - 1, 4));
  return Math.min(delay, 24 * 60 * 60 * 1000); // cap at 24 hours
}

// ── One poll cycle ─────────────────────────────────────────────────────
export async function pollCycle() {
  _pollTick++;

  // Flush pending notifications every 5th poll (~2.5 min) to reduce overhead
  if (_pollTick % 5 === 0) {
    await flushPendingNotifications().catch(() => {});
  }

  const slots = MAX_CONCURRENT - _running.size;
  if (slots <= 0) return;

  const now = Date.now();

  // Combine queued + paused_waiting tasks that are ready to run
  const [queued, waiting] = await Promise.all([
    DB.getTasksByStatus("queued"),
    DB.getTasksByStatus("paused_waiting"),
  ]);

  const candidates = [...queued, ...waiting]
    .filter(t => {
      if (_running.has(t.id)) return false;
      if (t.paused_manually)  return false;  // human-paused: only resume via UI action
      if (t.next_retry_time && t.next_retry_time > now) return false;
      return true;
    })
    .sort((a, b) => {
      // Recurring tasks first, then FIFO by creation time
      const pa = a.type === "recurring" ? 0 : 1;
      const pb = b.type === "recurring" ? 0 : 1;
      return pa - pb || a.created_at - b.created_at;
    })
    .slice(0, slots);

  for (const task of candidates) {
    _running.add(task.id);
    runTask(task).finally(() => _running.delete(task.id));
  }
}

// ── Run a single task with full error handling ─────────────────────────
async function runTask(task) {
  const name = task.definition?.name || task.id;
  console.log(`[SCHED] 🚀 Starting: "${name}" (attempt ${(task.attempt_count || 0) + 1})`);

  await DB.updateTask(task.id, { status: "running", started_at: Date.now() });
  await DB.logExecution(task.id, { action: "task_start", attempt: (task.attempt_count || 0) + 1 });

  try {
    const result = await executeTask(task);
    const iteration = (task.recurrence_count || 0) + 1;

    // ── Success: recurring task ──
    if (task.type === "recurring" && task.recurring_interval_ms) {
      const nextRun = Date.now() + task.recurring_interval_ms;
      await DB.updateTask(task.id, {
        status:              "queued",
        current_step_index:  0,
        attempt_count:       0,
        next_retry_time:     nextRun,
        recurrence_count:    iteration,
        last_completed_at:   Date.now(),
        result,
        paused_manually:     false,
      });
      await DB.clearCheckpoints(task.id);
      await notifyRecurringComplete(task.id, name, iteration, task.recurring_interval_ms);
      console.log(`[SCHED] ♻️ Recurring "${name}" done (iter ${iteration}), next in ${Math.round(task.recurring_interval_ms / 60000)}min`);

    // ── Success: single task ──
    } else {
      await DB.updateTask(task.id, {
        status:           "completed",
        completed_at:     Date.now(),
        result,
        paused_manually:  false,
      });
      await DB.logExecution(task.id, { action: "task_complete", result: JSON.stringify(result).substring(0, 500) });
      await notifyTaskComplete(task.id, name, result?.context?._lastProvider || "unknown");
      console.log(`[SCHED] ✅ "${name}" complete`);
    }

  } catch (e) {
    const code = e.code || "UNKNOWN";
    console.error(`[SCHED] ❌ Task error [${code}]: ${e.message}`);
    await DB.logExecution(task.id, { action: "task_error", code, error: e.message });

    // ── 2FA / CAPTCHA: pause, human must solve ──
    if (code === "2FA_REQUIRED") {
      await DB.updateTask(task.id, {
        status:          "paused_waiting",
        last_error:      "2FA/CAPTCHA detected — human needed",
        next_retry_time: null,
        paused_manually: true,
      });
      await notify2FADetected(task.id, name, e.url || "?");
      console.log(`[SCHED] 🔐 "${name}" paused — 2FA at ${e.url || "?"}`);
      return;
    }

    // ── Session expired (login wall): pause, human must re-login ──
    // Covers both SESSION_EXPIRED (from detectAuthError) and
    // VERIFY_SESSION_FAILED (from verify_session step)
    if (code === "SESSION_EXPIRED" || code === "VERIFY_SESSION_FAILED") {
      await DB.updateTask(task.id, {
        status:          "paused_waiting",
        last_error:      `Session expired — re-login required at ${e.loginUrl || "?"}`,
        next_retry_time: null,
        paused_manually: true,  // never auto-retry — needs human re-login
      });
      await notifySessionExpired(task.id, name, e.loginUrl || "?");
      console.log(`[SCHED] 🔒 "${name}" paused — login required at ${e.loginUrl || "?"}`);
      return;
    }

    // ── No providers / all providers failed ──
    if (code === "ALL_FAILED" || code === "NO_KEYS") {
      const attempt    = (task.attempt_count || 0) + 1;
      const retryDelay = calcRetryDelay(attempt);
      await DB.updateTask(task.id, {
        status:          "paused_waiting",
        last_error:      e.message,
        attempt_count:   attempt,
        next_retry_time: Date.now() + retryDelay,
        paused_manually: false,
      });
      await notifyNeedsProviders(task.id, name, attempt, retryDelay);
      console.log(`[SCHED] ⏸ "${name}" paused (no providers), retry in ${Math.round(retryDelay / 60000)}min`);
      return;
    }

    // ── Step limit / loop — do NOT auto-retry, human must check ──
    const isLoopOrLimit =
      e.message?.includes('hit_max_steps') ||
      e.message?.includes('step limit') ||
      e.message?.includes('loop_detected') ||
      e.message?.includes('Loop detected') ||
      e.code === 'LOOP_DETECTED';

    if (isLoopOrLimit) {
      await DB.updateTask(task.id, {
        status:          "paused_waiting",
        last_error:      `Stopped: ${e.message}. Human review required.`,
        next_retry_time: null,
        paused_manually: true,  // ← prevents pollCycle() from picking it up again
      });
      console.log(`[SCHED] 🛑 "${name}" stopped (loop/limit) — no auto-retry`);
      return;
    }

    // ── Generic error (step timeout, DOM not found, etc.) ──
    const attempt    = (task.attempt_count || 0) + 1;
    const retryDelay = calcRetryDelay(attempt);
    await DB.updateTask(task.id, {
      status:          "paused_waiting",
      last_error:      e.message,
      attempt_count:   attempt,
      next_retry_time: Date.now() + retryDelay,
      paused_manually: false,
    });
    console.log(`[SCHED] 🔁 "${name}" retry in ${Math.round(retryDelay / 60000)}min (attempt ${attempt})`);

    // Notify user after 3+ failures — they may want to check the task
    if (attempt >= 3) {
      await notifyNeedsProviders(task.id, name, attempt, retryDelay);
    }
  }
}

// ── Chrome alarms setup ────────────────────────────────────────────────
export async function setupAlarms() {
  // Clear any stale alarms first (handles extension update/reinstall)
  await chrome.alarms.clearAll();

  // ① Keepalive: wakes service worker every 25 seconds
  //    periodInMinutes must be a number; 25/60 = 0.4166...
  chrome.alarms.create("keepalive", { periodInMinutes: 25 / 60 });

  // ② Poll: checks ready tasks every 30 seconds
  chrome.alarms.create("poll", { delayInMinutes: 0.1, periodInMinutes: 0.5 });

  // ③ Daily quota reset: at UTC midnight
  const now          = new Date();
  const msToMidnight = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)
  ) - now;

  chrome.alarms.create("daily_reset", {
    delayInMinutes:  msToMidnight / 60000,
    periodInMinutes: 24 * 60,
  });

  console.log(`[SCHED] ⏰ Alarms set — keepalive 25s, poll 30s, daily_reset in ${Math.round(msToMidnight / 60000)}min`);
}

// ── Alarm dispatcher (registered in background.js) ────────────────────
export async function onAlarm(alarm) {
  if (alarm.name === "keepalive") {
    // No-op — the alarm itself is enough to keep service worker alive
    return;
  }

  if (alarm.name === "poll") {
    await pollCycle();
    return;
  }

  if (alarm.name === "daily_reset") {
    await resetDailyQuotas();
    await DB.cleanup();
    console.log("[SCHED] 🌅 Daily reset complete");
    return;
  }

  console.warn(`[SCHED] Unknown alarm: ${alarm.name}`);
}

// ── Recover stuck tasks on startup ────────────────────────────────────
// Any task in "running" status survived a service worker crash.
// Re-queue them so they resume from their last checkpoint.
// v12: stale threshold raised to 120s (some steps, like video uploads, take longer)
export async function recoverStuckTasks() {
  const running = await DB.getTasksByStatus("running");
  const STALE_THRESHOLD_MS = 120_000; // 2 minutes
  const stale   = running.filter(t => t.started_at && Date.now() - t.started_at > STALE_THRESHOLD_MS);

  for (const task of stale) {
    console.log(`[SCHED] 🔄 Recovering stuck task: ${task.definition?.name || task.id}`);
    const lastCP = await DB.getLastCheckpoint(task.id);
    await DB.updateTask(task.id, {
      status:             "queued",
      current_step_index: lastCP ? lastCP.step_index : 0,
      next_retry_time:    null,
      paused_manually:    false,
    });
    await DB.logExecution(task.id, { action: "task_recovered", from_step: lastCP?.step_index ?? 0 });
  }

  if (stale.length > 0) {
    console.log(`[SCHED] ♻️ Recovered ${stale.length} stuck task(s)`);
  }
}
