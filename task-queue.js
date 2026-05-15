// src/task-queue.js — FIXED
// This file is now an ES module to match the rest of the extension.

import * as DB from "./db.js";

export async function addToQueue(taskDef) {
  return await DB.createTask(taskDef);
}

export async function getQueue() {
  return await DB.getAllTasks();
}

export async function clearQueue() {
  const tasks = await DB.getAllTasks();
  for (const t of tasks) {
    await DB.deleteTask(t.id);
    await DB.clearCheckpoints(t.id);
  }
}
