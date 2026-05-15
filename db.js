// src/db.js — IndexedDB Persistence Layer v12.0
// All task state survives browser crash, restart, power loss.
//
// v12.0 NEW:
//  ✅ SEEN_ITEMS store — dedup for recurring monitoring tasks (mark_seen / filter_unseen steps)
//  ✅ API_CALLS store  — audit log for external API calls (api_call step)
//  ✅ MEDIA_QUEUE store — video/image generation job tracking (file pipeline tasks)
//  ✅ markItemSeen() / getSeenItems() / cleanupSeenItems() helpers
//  ✅ logApiCall() / updateApiCall() helpers
//  ✅ createMediaJob() / updateMediaJob() / getMediaJob() helpers
//  ✅ DB_VERSION bumped to 3 — onupgradeneeded handles v1→v2→v3 migrations
//
// CARRIED FROM v2 (unchanged):
//  ✅ TASKS, PROVIDER_STATE, NOTIFICATIONS, EXECUTION_LOG, CHECKPOINTS stores
//  ✅ All CRUD functions for tasks, providers, checkpoints, notifications, logs

const DB_NAME    = "HubtiqueTaskQueue";
const DB_VERSION = 4;   // bumped from 3 (v13: added task_steps store)

const STORES = {
  TASKS:          "tasks",
  PROVIDER_STATE: "provider_state",
  NOTIFICATIONS:  "notifications",
  EXECUTION_LOG:  "execution_log",
  CHECKPOINTS:    "checkpoints",
  // v12 new:
  SEEN_ITEMS:     "seen_items",
  API_CALLS:      "api_calls",
  MEDIA_QUEUE:    "media_queue",
  // v13 new:
  TASK_STEPS:     "task_steps",  // per-step execution reports for frontend display
};

let _db = null;

// ── Open / Init ────────────────────────────────────────────────────────
export async function initDatabase() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => { _db = req.result; resolve(_db); };

    req.onupgradeneeded = (e) => {
      const db = e.target.result;

      // ── v1 stores ──
      if (e.oldVersion < 1) {
        const tasks = db.createObjectStore(STORES.TASKS, { keyPath: "id" });
        tasks.createIndex("status",          "status");
        tasks.createIndex("next_retry_time", "next_retry_time");
        tasks.createIndex("type",            "type");
        tasks.createIndex("created_at",      "created_at");

        const prov = db.createObjectStore(STORES.PROVIDER_STATE, { keyPath: "provider_id" });
        prov.createIndex("status", "status");

        const notif = db.createObjectStore(STORES.NOTIFICATIONS, { keyPath: "id" });
        notif.createIndex("shown",   "shown");
        notif.createIndex("task_id", "task_id");

        const log = db.createObjectStore(STORES.EXECUTION_LOG, { keyPath: "id", autoIncrement: true });
        log.createIndex("task_id",   "task_id");
        log.createIndex("timestamp", "timestamp");
      }

      // ── v2 stores ──
      if (e.oldVersion < 2) {
        const cp = db.createObjectStore(STORES.CHECKPOINTS, { keyPath: "id", autoIncrement: true });
        cp.createIndex("task_id",    "task_id");
        cp.createIndex("step_index", "step_index");
      }

      // ── v3 stores (new in v12.0) ──
      if (e.oldVersion < 3) {
        // SEEN_ITEMS — dedup store for recurring monitoring tasks
        // Key: `${storeName}::${itemId}` (composite — unique per store+item)
        const seen = db.createObjectStore(STORES.SEEN_ITEMS, { keyPath: "key" });
        seen.createIndex("store_name", "store_name");
        seen.createIndex("seen_at",    "seen_at");

        // API_CALLS — external API call audit log
        const apiCalls = db.createObjectStore(STORES.API_CALLS, { keyPath: "id", autoIncrement: true });
        apiCalls.createIndex("task_id",    "task_id");
        apiCalls.createIndex("status",     "status");
        apiCalls.createIndex("created_at", "created_at");

        // MEDIA_QUEUE — video/image generation job tracking
        const media = db.createObjectStore(STORES.MEDIA_QUEUE, { keyPath: "id" });
        media.createIndex("task_id",    "task_id");
        media.createIndex("status",     "status");
        media.createIndex("created_at", "created_at");
      }

      // ── v4 stores (new in v13.0) ──
      if (e.oldVersion < 4) {
        // TASK_STEPS — per-step execution reports consumed by the frontend
        // dashboard (TaskStepDisplay.jsx) to show real-time progress.
        // key: autoIncrement; indexed by task_id for fast per-task queries.
        const steps = db.createObjectStore(STORES.TASK_STEPS, { keyPath: "id", autoIncrement: true });
        steps.createIndex("task_id",    "task_id");
        steps.createIndex("step_id",    "step_id");
        steps.createIndex("timestamp",  "timestamp");
      }
    };
  });
}

async function getDB() {
  if (_db) return _db;
  return initDatabase();
}

// ── Generic helpers ────────────────────────────────────────────────────
function tx(store, mode, fn) {
  return getDB().then(db => new Promise((resolve, reject) => {
    const t   = db.transaction(store, mode);
    const s   = t.objectStore(store);
    const req = fn(s);
    if (req && req.onsuccess !== undefined) {
      req.onsuccess = () => resolve(req.result);
      req.onerror   = () => reject(req.error);
    } else {
      t.oncomplete = () => resolve();
      t.onerror    = () => reject(t.error);
    }
  }));
}

// ─────────────────────────────────────────────────────────────────────
// TASKS
// ─────────────────────────────────────────────────────────────────────
export async function createTask(def) {
  const task = {
    id:                    `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    created_at:            Date.now(),
    updated_at:            Date.now(),
    status:                "queued",
    type:                  def.type || "single",
    definition:            def,
    attempt_count:         0,
    current_step_index:    0,
    provider_rotation:     def.providers || ["groq", "cerebras", "openrouter", "google", "sambanova", "pollinations"],
    current_provider_index: 0,
    next_retry_time:       null,
    last_error:            null,
    result:                null,
    recurring_interval_ms: def.interval_ms || null,
    recurrence_count:      0,
  };
  await tx(STORES.TASKS, "readwrite", s => s.put(task));
  return task.id;
}

export async function getTask(taskId) {
  return tx(STORES.TASKS, "readonly", s => s.get(taskId));
}

export async function updateTask(taskId, updates) {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const t   = db.transaction(STORES.TASKS, "readwrite");
    const s   = t.objectStore(STORES.TASKS);
    const req = s.get(taskId);
    req.onsuccess = () => {
      const task = req.result;
      if (!task) return reject(new Error(`Task ${taskId} not found`));
      const updated = { ...task, ...updates, updated_at: Date.now() };
      const put = s.put(updated);
      put.onsuccess = () => resolve(updated);
      put.onerror   = () => reject(put.error);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function getTasksByStatus(status) {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const t   = db.transaction(STORES.TASKS, "readonly");
    const idx = t.objectStore(STORES.TASKS).index("status");
    const req = idx.getAll(status);
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

export async function getAllTasks() {
  return tx(STORES.TASKS, "readonly", s => s.getAll());
}

export async function deleteTask(taskId) {
  return tx(STORES.TASKS, "readwrite", s => s.delete(taskId));
}

// ─────────────────────────────────────────────────────────────────────
// PROVIDER STATE
// ─────────────────────────────────────────────────────────────────────
export async function getProviderState(providerId) {
  const result = await tx(STORES.PROVIDER_STATE, "readonly", s => s.get(providerId));
  return result || { provider_id: providerId, status: "unknown", current_usage: 0, daily_limit: 0, cooldown_until: null };
}

export async function updateProviderState(providerId, updates) {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const t   = db.transaction(STORES.PROVIDER_STATE, "readwrite");
    const s   = t.objectStore(STORES.PROVIDER_STATE);
    const req = s.get(providerId);
    req.onsuccess = () => {
      const existing = req.result || { provider_id: providerId };
      const merged   = { ...existing, ...updates, updated_at: Date.now() };
      const put = s.put(merged);
      put.onsuccess = () => resolve(merged);
      put.onerror   = () => reject(put.error);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function getAllProviderStates() {
  return tx(STORES.PROVIDER_STATE, "readonly", s => s.getAll());
}

// ─────────────────────────────────────────────────────────────────────
// CHECKPOINTS
// ─────────────────────────────────────────────────────────────────────
export async function saveCheckpoint(taskId, stepIndex, data) {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const t   = db.transaction(STORES.CHECKPOINTS, "readwrite");
    const s   = t.objectStore(STORES.CHECKPOINTS);
    const idx = s.index("task_id");
    const req = idx.openCursor(IDBKeyRange.only(taskId));
    const toDelete = [];

    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) {
        if (cursor.value.step_index === stepIndex) toDelete.push(cursor.primaryKey);
        cursor.continue();
      } else {
        toDelete.forEach(k => s.delete(k));
        const add = s.add({ task_id: taskId, step_index: stepIndex, data, saved_at: Date.now() });
        add.onsuccess = () => resolve();
        add.onerror   = () => reject(add.error);
      }
    };
    req.onerror = () => reject(req.error);
  });
}

export async function getLastCheckpoint(taskId) {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const t   = db.transaction(STORES.CHECKPOINTS, "readonly");
    const idx = t.objectStore(STORES.CHECKPOINTS).index("task_id");
    const req = idx.getAll(taskId);
    req.onsuccess = () => {
      const all = req.result;
      if (!all.length) return resolve(null);
      all.sort((a, b) => b.step_index - a.step_index);
      resolve(all[0]);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function clearCheckpoints(taskId) {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const t   = db.transaction(STORES.CHECKPOINTS, "readwrite");
    const idx = t.objectStore(STORES.CHECKPOINTS).index("task_id");
    const req = idx.openCursor(IDBKeyRange.only(taskId));
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) { cursor.delete(); cursor.continue(); } else resolve();
    };
    req.onerror = () => reject(req.error);
  });
}

// ─────────────────────────────────────────────────────────────────────
// EXECUTION LOG
// ─────────────────────────────────────────────────────────────────────
export async function logExecution(taskId, entry) {
  return tx(STORES.EXECUTION_LOG, "readwrite", s =>
    s.add({ task_id: taskId, timestamp: Date.now(), ...entry })
  );
}

export async function getExecutionLog(taskId) {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const t   = db.transaction(STORES.EXECUTION_LOG, "readonly");
    const idx = t.objectStore(STORES.EXECUTION_LOG).index("task_id");
    const req = idx.getAll(taskId);
    req.onsuccess = () => resolve(req.result.sort((a, b) => a.timestamp - b.timestamp));
    req.onerror   = () => reject(req.error);
  });
}

// ─────────────────────────────────────────────────────────────────────
// NOTIFICATIONS
// ─────────────────────────────────────────────────────────────────────
export async function createNotification(notif) {
  const id   = `notif_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const full = { id, created_at: Date.now(), shown: false, dismissed: false, ...notif };
  await tx(STORES.NOTIFICATIONS, "readwrite", s => s.put(full));
  return id;
}

export async function getUnshownNotifications() {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const t   = db.transaction(STORES.NOTIFICATIONS, "readonly");
    const idx = t.objectStore(STORES.NOTIFICATIONS).index("shown");
    const req = idx.getAll(false);
    req.onsuccess = () => resolve(req.result.filter(n => !n.dismissed));
    req.onerror   = () => reject(req.error);
  });
}

export async function markNotificationShown(notifId) {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const t   = db.transaction(STORES.NOTIFICATIONS, "readwrite");
    const s   = t.objectStore(STORES.NOTIFICATIONS);
    const req = s.get(notifId);
    req.onsuccess = () => {
      const n = req.result;
      if (!n) return resolve();
      n.shown = true; n.shown_at = Date.now();
      s.put(n);
      t.oncomplete = resolve;
    };
    req.onerror = () => reject(req.error);
  });
}

export async function dismissNotification(notifId) {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const t   = db.transaction(STORES.NOTIFICATIONS, "readwrite");
    const s   = t.objectStore(STORES.NOTIFICATIONS);
    const req = s.get(notifId);
    req.onsuccess = () => {
      const n = req.result;
      if (!n) return resolve();
      n.dismissed = true; n.dismissed_at = Date.now();
      s.put(n);
      t.oncomplete = resolve;
    };
    req.onerror = () => reject(req.error);
  });
}

// ─────────────────────────────────────────────────────────────────────
// SEEN ITEMS (v12 new) — dedup for recurring monitoring tasks
// ─────────────────────────────────────────────────────────────────────

// Mark a single item as seen in a named store
export async function markItemSeen(storeName, itemId) {
  const key = `${storeName}::${itemId}`;
  return tx(STORES.SEEN_ITEMS, "readwrite", s => s.put({
    key,
    store_name: storeName,
    item_id:    itemId,
    seen_at:    Date.now(),
  }));
}

// Get all seen item IDs for a store as a Set<string>
export async function getSeenItems(storeName) {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const t   = db.transaction(STORES.SEEN_ITEMS, "readonly");
    const idx = t.objectStore(STORES.SEEN_ITEMS).index("store_name");
    const req = idx.getAll(storeName);
    req.onsuccess = () => {
      const ids = new Set(req.result.map(r => String(r.item_id)));
      resolve(ids);
    };
    req.onerror = () => reject(req.error);
  });
}

// Clean up seen items older than maxAgeDays (default 30)
export async function cleanupSeenItems(maxAgeDays = 30) {
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const t   = db.transaction(STORES.SEEN_ITEMS, "readwrite");
    const idx = t.objectStore(STORES.SEEN_ITEMS).index("seen_at");
    const req = idx.openCursor(IDBKeyRange.upperBound(cutoff));
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) { cursor.delete(); cursor.continue(); } else resolve();
    };
    req.onerror = () => reject(req.error);
  });
}

// ─────────────────────────────────────────────────────────────────────
// API CALLS (v12 new) — external API call audit log
// ─────────────────────────────────────────────────────────────────────

export async function logApiCall(taskId, entry) {
  const full = {
    task_id:      taskId,
    created_at:   Date.now(),
    status:       "pending",
    url:          entry.url || '',
    method:       entry.method || 'POST',
    request_body: entry.request_body || null,
    response:     null,
    error:        null,
    ...entry,
  };
  return tx(STORES.API_CALLS, "readwrite", s => s.add(full));
}

export async function updateApiCall(id, updates) {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const t   = db.transaction(STORES.API_CALLS, "readwrite");
    const s   = t.objectStore(STORES.API_CALLS);
    const req = s.get(id);
    req.onsuccess = () => {
      const existing = req.result;
      if (!existing) return resolve();
      const updated = { ...existing, ...updates, updated_at: Date.now() };
      const put = s.put(updated);
      put.onsuccess = () => resolve(updated);
      put.onerror   = () => reject(put.error);
    };
    req.onerror = () => reject(req.error);
  });
}

// ─────────────────────────────────────────────────────────────────────
// MEDIA QUEUE (v12 new) — video/image generation job tracking
// ─────────────────────────────────────────────────────────────────────

export async function createMediaJob(taskId, jobDef) {
  const job = {
    id:         `media_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    task_id:    taskId,
    created_at: Date.now(),
    status:     "pending",    // pending | processing | complete | failed
    provider:   jobDef.provider || "unknown",
    job_id:     jobDef.job_id || null,      // provider's job ID for polling
    prompt:     jobDef.prompt || null,
    media_url:  null,         // final URL when complete
    file_id:    null,         // HubtiqueFS fileId after download
    error:      null,
    ...jobDef,
  };
  await tx(STORES.MEDIA_QUEUE, "readwrite", s => s.put(job));
  return job.id;
}

export async function updateMediaJob(jobId, updates) {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const t   = db.transaction(STORES.MEDIA_QUEUE, "readwrite");
    const s   = t.objectStore(STORES.MEDIA_QUEUE);
    const req = s.get(jobId);
    req.onsuccess = () => {
      const existing = req.result;
      if (!existing) return resolve();
      const updated = { ...existing, ...updates, updated_at: Date.now() };
      const put = s.put(updated);
      put.onsuccess = () => resolve(updated);
      put.onerror   = () => reject(put.error);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function getMediaJob(jobId) {
  return tx(STORES.MEDIA_QUEUE, "readonly", s => s.get(jobId));
}

export async function getPendingMediaJobs(taskId) {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const t   = db.transaction(STORES.MEDIA_QUEUE, "readonly");
    const idx = t.objectStore(STORES.MEDIA_QUEUE).index("task_id");
    const req = idx.getAll(taskId);
    req.onsuccess = () => resolve(req.result.filter(j => j.status !== "complete" && j.status !== "failed"));
    req.onerror   = () => reject(req.error);
  });
}

// ─────────────────────────────────────────────────────────────────────
// TASK STEPS (v13 new) — per-step execution reports for frontend display
// ─────────────────────────────────────────────────────────────────────

// Write a step report. Called by reportStepCompletion() in background.js.
// Returns the auto-incremented IDB record id.
export async function saveTaskStep(taskId, stepReport) {
  return tx(STORES.TASK_STEPS, "readwrite", s =>
    s.add({
      task_id:   taskId,
      step_id:   stepReport.stepId,
      action:    stepReport.action,
      status:    stepReport.status,        // "success" | "failed"
      found:     stepReport.found || null, // what the step extracted/found
      reasoning: stepReport.reasoning || "",
      duration:  stepReport.duration || 0, // ms
      error:     stepReport.error || null,
      attempt:   stepReport.attempt || 1,
      timestamp: Date.now(),
    })
  );
}

// Fetch all step reports for a task, ordered by timestamp ascending.
// Used by the get_step_results message handler in background.js and
// by the TaskStepDisplay.jsx component on first mount.
export async function getTaskSteps(taskId) {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const t   = db.transaction(STORES.TASK_STEPS, "readonly");
    const idx = t.objectStore(STORES.TASK_STEPS).index("task_id");
    const req = idx.getAll(taskId);
    req.onsuccess = () =>
      resolve(req.result.sort((a, b) => a.timestamp - b.timestamp));
    req.onerror = () => reject(req.error);
  });
}

// Generic helper — update any object store record by key.
// background.js uses this to patch task/step records without importing
// store-specific update functions for every case.
export async function updateObjectStore(storeName, key, updates) {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const t   = db.transaction(storeName, "readwrite");
    const s   = t.objectStore(storeName);
    const req = s.get(key);
    req.onsuccess = () => {
      const existing = req.result;
      if (!existing) {
        // If record doesn't exist yet, insert it (upsert behaviour)
        const put = s.put({ ...updates, id: key, updated_at: Date.now() });
        put.onsuccess = () => resolve(put.result);
        put.onerror   = () => reject(put.error);
        return;
      }
      const updated = { ...existing, ...updates, updated_at: Date.now() };
      const put = s.put(updated);
      put.onsuccess = () => resolve(updated);
      put.onerror   = () => reject(put.error);
    };
    req.onerror = () => reject(req.error);
  });
}

// ─────────────────────────────────────────────────────────────────────
// CLEANUP
// ─────────────────────────────────────────────────────────────────────
export async function cleanup() {
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const all = await getAllTasks();
  for (const task of all) {
    if (["completed", "failed"].includes(task.status) && task.updated_at < cutoff) {
      await deleteTask(task.id);
      await clearCheckpoints(task.id);
    }
  }
  // Clean seen items older than 30 days
  await cleanupSeenItems(30);

  // Clean task_steps older than 7 days (same window as tasks)
  const db = await getDB();
  await new Promise((resolve, reject) => {
    const t   = db.transaction(STORES.TASK_STEPS, "readwrite");
    const idx = t.objectStore(STORES.TASK_STEPS).index("timestamp");
    const req = idx.openCursor(IDBKeyRange.upperBound(cutoff));
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) { cursor.delete(); cursor.continue(); } else resolve();
    };
    req.onerror = () => reject(req.error);
  });
}
