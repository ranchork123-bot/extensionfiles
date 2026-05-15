// src/workflow-engine.js — Hubtique OS v14.0
// ─────────────────────────────────────────────────────────────────────
// Phases 2, 3 and 4 of the 5-phase architecture:
//   Phase 2 — WORKFLOW CREATION:  LLM produces a WorkflowGraph JSON
//   Phase 3 — VISION LOOP:        execute each node with screenshot-first
//   Phase 4 — FAILURE INTELLIGENCE: smart recovery, not blind retry
//
// WorkflowGraph is persisted to chrome.storage.local so:
//   - SW restarts can resume mid-workflow
//   - CometBrowser.tsx can display live node status
//   - Failure history accumulates across retries
//
// Exports:
//   createWorkflow(understanding)  → WorkflowGraph (saved to storage)
//   executeWorkflow(workflowId)    → { success, result, collected_data }
//   resumeWorkflow(workflowId)     → same (resumes from current_node)
//   WORKFLOW_PROMPT                → template string
// ─────────────────────────────────────────────────────────────────────

import { captureAndDescribe } from './vision.js';
import { handleBlockers }     from './blocker-handler.js';

// ── WORKFLOW PROMPT ──────────────────────────────────────────────────
export const WORKFLOW_PROMPT = `You are a workflow planner for browser automation.
You have already analyzed the task. Now create the execution workflow.
Every node must be self-contained with specific instructions — never generic.

TASK UNDERSTANDING:
{UNDERSTANDING_JSON}

SITE-SPECIFIC RULES — apply to relevant nodes:
- Amazon search results: use read_body NOT getSnapshot. Skip "Sponsored" rows. Price format $XXX.XX.
  Blockers: cookie banner (click Accept), captcha (human-handoff), geo popup (auto-dismissed by content.js).
- BestBuy: zip code modal already auto-dismissed by content.js. Price on listing card.
- Gmail compose: getSnapshot → click "Compose" → type "To recipients" → type "Subject" → type "Message Body" → click "Send".
- DuckDuckGo AI Chat: navigate to https://duckduckgo.com/?q=DuckDuckGo+AI+Chat&ia=chat
  → type prompt in chat input → wait 8 seconds → read_body to get response.
- JustPaste.it: navigate → find main textarea → type content → click Publish → read new URL from page.
- Reddit/HN/Wikipedia/news: navigate → read_body immediately → DONE. Never getSnapshot on these.

NODE RULES:
1. Maximum 50 nodes.
2. Every "navigate" node must have after_navigate_verify.
3. Search results / listing pages → use_read_body: true, use_get_snapshot: false.
4. Form pages / interactive pages → use_read_body: false, use_get_snapshot: true.
5. Every node must have at least 2 on_failure strategies.
6. Every node that opens a new page must have blocker_handlers.
7. Node instructions must be specific: name the field, the button, the data pattern.
   BAD: "Find the price". GOOD: "Use read_body. Find first listing containing 'WH-1000XM5'
   that is NOT labeled 'Sponsored'. Extract price matching pattern $XXX.XX."

Output ONLY valid JSON — no markdown, no prose, no code fences:
{
  "workflow_id": "wf-{timestamp}",
  "task_summary": "one sentence",
  "nodes": [
    {
      "id": "N1",
      "name": "descriptive name",
      "site": "site name",
      "action": "navigate|read_body|getSnapshot|type|click|submit|extract|wait|llm_generate|human-handoff|DONE",
      "url": "full URL if navigate, else omit",
      "after_navigate_verify": {
        "url_must_contain": "domain fragment",
        "page_must_contain_text": "expected text",
        "if_fails": "retry|try_alternative_url|human-handoff"
      },
      "instruction": "SPECIFIC instruction for this exact page and action",
      "field_label": "exact visible label if type or click",
      "value": "text to type if type action",
      "use_read_body": false,
      "use_get_snapshot": true,
      "blocker_handlers": [
        { "if_see": "cookie banner", "do": "click Accept or Continue" },
        { "if_see": "captcha",       "do": "human-handoff immediately" }
      ],
      "expected_result": "what the page should show after this node",
      "success_check": "how to verify it worked",
      "on_success": "N2",
      "on_failure": "first recovery strategy as a string",
      "on_failure_fallback": "second recovery if first fails",
      "collects": "field_name or null",
      "depends_on": [],
      "status": "pending",
      "attempts": 0,
      "max_attempts": 3,
      "failure_log": []
    }
  ],
  "collected_data": {},
  "completed_nodes": [],
  "failed_nodes": [],
  "current_node": "N1",
  "status": "pending",
  "time_limit_ms": 600000
}`;

// ── DYNAMIC EXECUTION PROMPT ─────────────────────────────────────────
// Built fresh per step — not a static string.
// Injects vision description, node instruction, collected data,
// failure history, pending nodes, anti-bot rules.
export function buildDynamicExecutionPrompt(node, workflow, visionDescription = '') {
  const pending = (workflow.nodes || [])
    .filter(n => n.status === 'pending' && n.id !== node.id)
    .map(n => `  ${n.id}: ${n.name}`)
    .join('\n') || '  none';

  const completed = workflow.completed_nodes?.join(', ') || 'none yet';

  const failureHistory = node.failure_log?.length
    ? node.failure_log.join(' | ')
    : 'none — first attempt';

  const recoveryStrategy =
    node.attempts === 0 ? 'normal execution' :
    node.attempts === 1 ? (node.on_failure || 'retry same action') :
    (node.on_failure_fallback || 'human-handoff');

  const collectedJson = JSON.stringify(workflow.collected_data || {}, null, 2);

  const blockerLines = (node.blocker_handlers || [])
    .map(b => `  • If you see "${b.if_see}" → ${b.do}`)
    .join('\n') || '  none specified';

  return `You are executing node ${node.id} of a browser automation workflow.
You have full context. Use it. Output ONE JSON action only.

═══ WHAT YOU SEE RIGHT NOW (screenshot analysis) ═══
${visionDescription || 'Vision unavailable — proceed with planned action'}

═══ YOUR GOAL ═══
${workflow.task_summary || 'Complete the workflow'}
Final output needed: ${workflow.nodes?.find(n => n.action === 'DONE')?.instruction || 'Complete all nodes'}

═══ CURRENT NODE ═══
Node: ${node.id} — ${node.name}
Site: ${node.site}
Instruction: ${node.instruction}
${node.use_read_body ? 'USE: read_body (NOT getSnapshot on this page)' : 'USE: getSnapshot to find interactive elements'}
Expected result: ${node.expected_result}
Success check: ${node.success_check}

═══ HANDLE THESE BLOCKERS FIRST (before doing anything else) ═══
${blockerLines}

═══ DATA COLLECTED SO FAR ═══
${collectedJson}

═══ PREVIOUS ATTEMPTS ON THIS NODE ═══
Attempts: ${node.attempts}/${node.max_attempts}
What failed: ${failureHistory}
Recovery strategy: ${recoveryStrategy}

═══ COMPLETED NODES ═══
${completed}

═══ PENDING AFTER THIS ═══
${pending}

═══ ANTI-BOT RULES (NEVER SKIP) ═══
- Wait 1-2 seconds before clicking on any new page
- Never click the same element twice in a row
- If element label contains keyboard shortcuts like "alt, forward slash", "ctrl+enter" —
  IGNORE the shortcut text. Find the button by its function name (e.g. "Search Amazon")
- If you see a captcha → human-handoff immediately, no exceptions
- On Amazon: Skip "Sponsored" listings. Use read_body not getSnapshot for results pages.

═══ AVAILABLE ACTIONS ═══
{"action":"navigate","url":"https://..."}
{"action":"read_body"}
{"action":"getSnapshot"}
{"action":"click","label":"visible button/link text"}
{"action":"type","label":"field name","value":"text to type"}
{"action":"submit","label":"field name"}
{"action":"scroll","direction":"down","amount":500}
{"action":"wait","seconds":2}
{"action":"llm_generate","prompt":"generate text about X"}
{"action":"extract","label":"element label"}
{"action":"human-handoff","reason":"why"}
{"action":"DONE","value":"complete result with ALL collected data"}

Output ONE JSON action. No markdown. No explanation.`.trim();
}

// ── createWorkflow ───────────────────────────────────────────────────
// Phase 2: LLM produces a full WorkflowGraph from the TaskUnderstanding.
// Saved to chrome.storage.local immediately.
//
// Usage:
//   const workflow = await createWorkflow(understanding);
export async function createWorkflow(understanding) {
  console.log(`[WORKFLOW v14] 🗺️ Phase 2: Creating workflow...`);

  const prompt = WORKFLOW_PROMPT
    .replace('{UNDERSTANDING_JSON}', JSON.stringify(understanding, null, 2))
    .replace('{timestamp}', Date.now());

  const systemPrompt =
    'You are a browser automation workflow planner. ' +
    'Output ONLY valid JSON parseable by JSON.parse(). ' +
    'No markdown fences, no prose before or after.';

  const result = await _callLLM(
    [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: prompt },
    ],
    4000
  );

  if (!result.success) {
    throw new Error(`createWorkflow: LLM call failed — ${result.error}`);
  }

  let workflow;
  try {
    workflow = _parseJSON(result.text);
  } catch (e) {
    throw new Error(`createWorkflow: Failed to parse workflow JSON — ${e.message}`);
  }

  // Ensure required fields exist
  if (!Array.isArray(workflow.nodes) || workflow.nodes.length === 0) {
    throw new Error('createWorkflow: workflow has no nodes');
  }

  // Stamp each node with default tracking fields if missing
  workflow.nodes = workflow.nodes.map(n => ({
    status:       'pending',
    attempts:     0,
    max_attempts: 3,
    failure_log:  [],
    ...n,
  }));

  // Attach the understanding so execution prompts can reference it
  workflow._understanding = understanding;
  workflow.status         = 'pending';
  workflow.created_at     = Date.now();

  // Persist to storage
  await chrome.storage.local.set({
    [`workflow_${workflow.workflow_id}`]: workflow,
    active_workflow: workflow,
  });

  console.log(`[WORKFLOW v14] ✅ Workflow created: ${workflow.workflow_id}`);
  console.log(`  Nodes: ${workflow.nodes.length}`);
  console.log(`  First node: ${workflow.nodes[0]?.id} — ${workflow.nodes[0]?.name}`);

  return workflow;
}

// ── executeWorkflow ──────────────────────────────────────────────────
// Phase 3+4: Execute each node with vision + blocker handling.
// Resumes from workflow.current_node (supports SW restart recovery).
//
// Usage:
//   const result = await executeWorkflow(workflow.workflow_id);
export async function executeWorkflow(workflowId) {
  // Load workflow from storage
  const stored = await chrome.storage.local.get(`workflow_${workflowId}`);
  let workflow  = stored[`workflow_${workflowId}`];

  if (!workflow) {
    throw new Error(`executeWorkflow: workflow ${workflowId} not found in storage`);
  }

  console.log(`[WORKFLOW v14] 🚀 Phase 3: Executing workflow ${workflowId}`);
  console.log(`  Starting from: ${workflow.current_node}`);

  workflow.status     = 'running';
  workflow.started_at = Date.now();
  await _saveWorkflow(workflow);

  const TIME_LIMIT_MS = workflow.time_limit_ms || 600_000; // 10 min default
  const startTime     = Date.now();

  // ── Main execution loop ──────────────────────────────────────────
  while (true) {
    // Time budget check
    if (Date.now() - startTime > TIME_LIMIT_MS) {
      console.error(`[WORKFLOW v14] ⏰ Time limit exceeded (${TIME_LIMIT_MS / 1000}s)`);
      workflow.status = 'failed';
      workflow.last_error = `Time limit exceeded after ${Math.round((Date.now() - startTime) / 1000)}s`;
      await _saveWorkflow(workflow);
      return { success: false, error: workflow.last_error, collected_data: workflow.collected_data };
    }

    // Find current node
    const node = _getCurrentNode(workflow);
    if (!node) {
      // No more pending nodes — check if we completed
      if (workflow.completed_nodes.length > 0) {
        console.log(`[WORKFLOW v14] ✅ All nodes completed`);
        workflow.status       = 'completed';
        workflow.completed_at = Date.now();
        await _saveWorkflow(workflow);
        return {
          success:        true,
          result:         workflow.final_result,
          collected_data: workflow.collected_data,
        };
      }
      break;
    }

    console.log(`[WORKFLOW v14] ▶️ Node ${node.id}: ${node.name} (attempt ${node.attempts + 1}/${node.max_attempts})`);

    // ── Phase 3: Vision — see the page before acting ─────────────
    let visionDesc = null;
    try {
      const extId = typeof window !== 'undefined' ? window.__hubtique_ext_id__ : null;
      const vision = await captureAndDescribe(extId);
      visionDesc   = vision.raw_description;
      console.log(`[WORKFLOW v14] 👁️ Vision: ${vision.current_site} / ${vision.current_page_type}`);

      // Check for blockers vision detected
      if (vision.blocker_is_blocking) {
        const tabId = await _getActiveTabId();
        if (tabId) {
          const blockerResult = await handleBlockers(node, tabId, extId, vision);
          if (blockerResult.humanHandoff) {
            console.log(`[WORKFLOW v14] 🙋 Human handoff: ${blockerResult.action}`);
            workflow.status     = 'paused_human';
            workflow.last_error = blockerResult.action;
            await _saveWorkflow(workflow);
            return { success: false, humanHandoff: true, reason: blockerResult.action };
          }
          if (blockerResult.handled && blockerResult.waitMs > 0) {
            await _sleep(blockerResult.waitMs);
          }
        }
      }
    } catch (e) {
      console.warn(`[WORKFLOW v14] Vision phase error (non-fatal): ${e.message}`);
      visionDesc = 'Vision unavailable — proceeding without visual context';
    }

    // ── Execute node ──────────────────────────────────────────────
    const nodeResult = await _executeNode(node, workflow, visionDesc);

    // ── Process result ────────────────────────────────────────────
    if (nodeResult.success) {
      // Collect data if this node produces a value
      if (node.collects && nodeResult.value != null) {
        workflow.collected_data[node.collects] = nodeResult.value;
        console.log(`[WORKFLOW v14] 💾 Collected ${node.collects}: ${String(nodeResult.value).substring(0, 80)}`);
      }

      // DONE action — workflow complete
      if (nodeResult.done) {
        workflow.final_result   = nodeResult.value;
        workflow.status         = 'completed';
        workflow.completed_at   = Date.now();
        if (node.collects) {
          workflow.collected_data[node.collects] = nodeResult.value;
        }
        _markNodeComplete(workflow, node);
        await _saveWorkflow(workflow);
        console.log(`[WORKFLOW v14] 🎉 DONE: ${String(nodeResult.value).substring(0, 200)}`);
        return {
          success:        true,
          result:         nodeResult.value,
          collected_data: workflow.collected_data,
        };
      }

      _markNodeComplete(workflow, node);

      // Advance to next node
      const nextId = node.on_success;
      if (nextId) {
        const nextNode = workflow.nodes.find(n => n.id === nextId);
        if (nextNode) {
          workflow.current_node = nextId;
        } else {
          // on_success points to a non-existent node — advance sequentially
          workflow.current_node = _nextPendingNode(workflow)?.id || null;
        }
      } else {
        workflow.current_node = _nextPendingNode(workflow)?.id || null;
      }

      await _saveWorkflow(workflow);

    } else {
      // ── Phase 4: Failure Intelligence ────────────────────────────
      node.attempts++;
      node.failure_log.push(
        `Attempt ${node.attempts}: ${nodeResult.error || 'unknown error'}`
      );

      if (nodeResult.humanHandoff) {
        console.log(`[WORKFLOW v14] 🙋 Human handoff requested: ${nodeResult.error}`);
        workflow.status     = 'paused_human';
        workflow.last_error = nodeResult.error;
        await _saveWorkflow(workflow);
        return { success: false, humanHandoff: true, reason: nodeResult.error };
      }

      if (node.attempts >= node.max_attempts) {
        console.error(`[WORKFLOW v14] ❌ Node ${node.id} failed after ${node.attempts} attempts`);
        node.status = 'failed';
        workflow.failed_nodes.push(node.id);

        // If this node was required, abort workflow; optional nodes skip
        if (node.required !== false) {
          workflow.status     = 'failed';
          workflow.last_error = `Required node ${node.id} (${node.name}) failed: ${node.failure_log.slice(-1)[0]}`;
          await _saveWorkflow(workflow);
          return { success: false, error: workflow.last_error, collected_data: workflow.collected_data };
        }

        // Optional: skip to next node
        console.warn(`[WORKFLOW v14] ⚠️ Node ${node.id} failed but is optional — skipping`);
        workflow.current_node = _nextPendingNode(workflow)?.id || null;
      }
      // else: retry same node (attempts < max_attempts) — loop continues

      await _saveWorkflow(workflow);
    }
  }

  // Fell out of loop without completing
  const success = workflow.status === 'completed';
  return {
    success,
    result:         workflow.final_result,
    collected_data: workflow.collected_data,
    error:          workflow.last_error,
  };
}

// ── resumeWorkflow ───────────────────────────────────────────────────
// Called by background.js onStartup when an active_workflow is found.
export async function resumeWorkflow(workflowId) {
  console.log(`[WORKFLOW v14] 🔄 Resuming workflow: ${workflowId}`);
  return executeWorkflow(workflowId);
}

// ── _executeNode ─────────────────────────────────────────────────────
// Calls the LLM with a dynamic execution prompt, gets one action,
// sends it to background.js for execution.
async function _executeNode(node, workflow, visionDesc) {
  const prompt = buildDynamicExecutionPrompt(node, workflow, visionDesc);

  // Call LLM for this step's action decision
  const llmResult = await _callLLM(
    [{ role: 'user', content: prompt }],
    600
  );

  if (!llmResult.success) {
    return { success: false, error: `LLM call failed: ${llmResult.error}` };
  }

  let action;
  try {
    action = _parseJSON(llmResult.text);
  } catch (e) {
    return { success: false, error: `LLM returned invalid JSON: ${e.message}` };
  }

  console.log(`[WORKFLOW v14] 🤖 LLM action: ${JSON.stringify(action).substring(0, 120)}`);

  // Human handoff requested by LLM
  if (action.action === 'human-handoff') {
    return { success: false, humanHandoff: true, error: action.reason || 'Agent requested human help' };
  }

  // DONE — extract value
  if (action.action === 'DONE') {
    return { success: true, done: true, value: action.value };
  }

  // Send action to background.js for execution
  try {
    const result = await _sendExtCmd(action);
    if (!result?.success && result?.error) {
      return { success: false, error: result.error, value: result };
    }
    // Extract collected value from result
    const value = result?.text || result?.body || result?.found || result?.navigated || result;
    return { success: true, value, raw: result };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ── _sendExtCmd ──────────────────────────────────────────────────────
// Sends one action to background.js and returns the result.
// Mirrors CometBrowser.tsx's sendExtCmd pattern.
async function _sendExtCmd(action) {
  const extId = typeof window !== 'undefined' ? window.__hubtique_ext_id__ : null;

  // In SW context (background.js calling this directly), dispatch to handlers
  if (!extId && typeof chrome !== 'undefined' && chrome.tabs) {
    // We're in the service worker — call executeStep directly
    // background.js will inject executeStep when importing this module
    if (typeof executeStep === 'function') {
      return executeStep(action, {});
    }
  }

  if (!extId) throw new Error('Extension bridge not available');

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Extension cmd timeout (30s)')), 30_000);
    chrome.runtime.sendMessage(extId, action, (response) => {
      clearTimeout(timeout);
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(response);
      }
    });
  });
}

// ── Storage helpers ──────────────────────────────────────────────────

async function _saveWorkflow(workflow) {
  await chrome.storage.local.set({
    [`workflow_${workflow.workflow_id}`]: workflow,
    active_workflow: workflow,
  });
}

function _getCurrentNode(workflow) {
  const id = workflow.current_node;
  if (!id) return null;
  return workflow.nodes.find(n => n.id === id && n.status !== 'completed' && n.status !== 'failed') || null;
}

function _nextPendingNode(workflow) {
  return workflow.nodes.find(n => n.status === 'pending') || null;
}

function _markNodeComplete(workflow, node) {
  node.status = 'completed';
  if (!workflow.completed_nodes.includes(node.id)) {
    workflow.completed_nodes.push(node.id);
  }
}

async function _getActiveTabId() {
  try {
    const d = await chrome.storage.local.get('activeAgentTabId');
    return d.activeAgentTabId || null;
  } catch (_) {
    return null;
  }
}

// ── LLM + JSON helpers ───────────────────────────────────────────────

async function _callLLM(messages, maxTokens = 1000) {
  // SW context: use callAI directly (imported by background.js)
  if (typeof callAI === 'function') {
    try {
      const r = await callAI(messages);
      return { success: true, text: r.text, provider: r.provider };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  // Web app context: bridge through extension
  const extId = typeof window !== 'undefined' && window.__hubtique_ext_id__;
  if (extId && typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
    try {
      const result = await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('Bridge timeout')), 20_000);
        chrome.runtime.sendMessage(extId, { action: 'llm_generate', messages, taskId: null }, (r) => {
          clearTimeout(t);
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else resolve(r);
        });
      });
      if (result?.success && result.text) return { success: true, text: result.text };
      return { success: false, error: result?.error || 'Bridge call failed' };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  // Fallback: Pollinations
  for (let i = 1; i <= 3; i++) {
    try {
      if (i > 1) await _sleep(2000 * i);
      const resp = await fetch('https://text.pollinations.ai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'openai-large', max_tokens: maxTokens, messages }),
      });
      if (resp.ok) {
        const d = await resp.json();
        const t = d?.choices?.[0]?.message?.content?.trim();
        if (t) return { success: true, text: t, provider: 'pollinations' };
      }
    } catch (_) {}
  }

  return { success: false, error: 'All LLM providers failed' };
}

function _parseJSON(text) {
  if (!text) throw new Error('empty input');
  try { return JSON.parse(text.trim()); } catch (_) {}
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) { try { return JSON.parse(fence[1].trim()); } catch (_) {} }
  const obj = text.match(/\{[\s\S]*\}/);
  if (obj) { try { return JSON.parse(obj[0]); } catch (_) {} }
  throw new Error(`No valid JSON. First 300: ${text.substring(0, 300)}`);
}

function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
