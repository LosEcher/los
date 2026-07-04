/**
 * @los/agent/tools/builtin/worker-ask-tools — worker↔coordinator blocking tools.
 *
 * Two built-in tools that let an agent ask the coordinator a blocking question
 * (ask_coordinator) or request human intervention (escalate). Both follow the
 * same flow (see scheduler/worker-block-error.ts for the full rationale):
 *
 *   1. emit a worker_message (type 'ask' / 'escalation') carrying the question/options/reason
 *   2. append a worker.ask / worker.escalation session event so the operator SSE
 *      stream surfaces it for the UI to render an approval/answer prompt
 *   3. transitionExecutionState(task_run → blocked, reason 'worker_ask'/'worker_escalation')
 *   4. abortTaskRunForBlock(taskRunId, reason) — aborts the runAgent loop's signal
 *   5. scheduled-task-runner's catch sees the worker-block abort reason and returns
 *      {status:'blocked'} (NOT cancelled)
 *
 * Step 3 (state machine change) MUST happen before step 4 (abort) — the abort is
 * only to unwind the loop; the blocked transition is what actually parks the task.
 *
 * If taskRunId is undefined (runAgent invoked outside a scheduled task, e.g. a
 * direct unit test), the tools refuse to block and return a tool error — blocking
 * a non-scheduled execution has no recovery path.
 */

import { appendSessionEvent } from '../../session-events.js';
import { transitionExecutionState } from '../../execution-store.js';
import { sendWorkerMessage } from '../../worker-messages.js';
import { abortTaskRunForBlock } from '../../scheduler/abort-registry.js';
import type { BuiltinToolOptions, ToolRegistry } from '../core/registry.js';

function asString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.map(v => (typeof v === 'string' ? v.trim() : '')).filter(Boolean);
  return items.length > 0 ? items : undefined;
}

/**
 * Shared block flow for ask/escalate. Emits the worker message, the session
 * event, transitions the task_run to blocked, then aborts the runAgent loop.
 * Returns the tool result content (the abort fires after; the result is the
 * fallback if the abort is delayed a tick).
 */
async function blockTaskRunForWorker(input: {
  registry: ToolRegistry;
  options: BuiltinToolOptions;
  type: 'ask' | 'escalation';
  blockReason: string;
  payload: { question?: string; options?: string[]; reason?: string };
  eventType: 'worker.ask' | 'worker.escalation';
}): Promise<{ content: string; error?: string }> {
  const { registry: _registry, options, type, blockReason, payload, eventType } = input;
  const taskRunId = options.taskRunId;
  if (!taskRunId) {
    return {
      content: '',
      error: `${type} is only available inside a scheduled task (no taskRunId in tool context)`,
    };
  }
  const dispatchId = options.dispatchId;
  const sessionId = options.sessionId;

  // 1. emit the worker_message
  const message = await sendWorkerMessage({
    dispatchId,
    taskId: undefined,
    type,
    payload,
  }).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`failed to emit ${type} worker message: ${msg}`);
  });

  // 2. append the session event so operator SSE surfaces it
  if (sessionId) {
    await appendSessionEvent({
      sessionId,
      type: eventType,
      payload: {
        messageId: message.id,
        taskRunId,
        dispatchId,
        runSpecId: options.runSpecId,
        ...payload,
      },
    }).catch(() => undefined);
  }

  // 3. transition the task_run to blocked (must happen BEFORE the abort).
  // If this fails the task_run is NOT blocked — aborting anyway would leave
  // task_runs.status != 'blocked' while emitting task.blocked, so
  // claimBlockedTaskRunsWithAnswer (WHERE status='blocked') would never resume
  // it. Surface the error instead of swallowing.
  try {
    await transitionExecutionState({
      entityType: 'task_run',
      entityId: taskRunId,
      to: 'blocked',
      reason: blockReason,
      sessionId,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: '', error: `failed to block task_run: ${msg}` };
  }

  // 4. abort the runAgent loop; scheduled-task-runner's catch will see the
  //    worker_block: reason and return {status:'blocked'}
  abortTaskRunForBlock(taskRunId, blockReason);

  return { content: `${type} emitted (messageId=${message.id}); task_run blocked, awaiting coordinator` };
}

export function registerWorkerAskTools(registry: ToolRegistry, options: BuiltinToolOptions): void {
  registry.register('ask_coordinator', async (args) => {
    const question = asString(args.question);
    if (!question) return { content: '', error: 'question is required' };
    const optionsField = asStringArray(args.options);

    return blockTaskRunForWorker({
      registry,
      options,
      type: 'ask',
      blockReason: 'worker_ask',
      payload: { question, options: optionsField },
      eventType: 'worker.ask',
    });
  }, {
    type: 'function',
    function: {
      name: 'ask_coordinator',
      description: 'Ask the coordinator a blocking question and pause execution. The task is blocked until the operator answers via POST /runs/:id/answer; the answer is injected into the resumed execution. Use sparingly — only when you genuinely cannot proceed without a human/coordinator decision.',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'The blocking question to surface to the operator/coordinator.' },
          options: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional allowed answers. If omitted, the answer is free-text.',
          },
        },
        required: ['question'],
      },
    },
  }, {
    riskLevel: 'L1',
    permissions: ['worker:ask'],
    timeoutMs: 5_000,
    retryable: false,
    idempotent: false,
    costLevel: 'low',
    sideEffect: true,
    tags: ['worker', 'block', 'coordination'],
  });

  registry.register('escalate', async (args) => {
    const reason = asString(args.reason);
    if (!reason) return { content: '', error: 'reason is required' };

    return blockTaskRunForWorker({
      registry,
      options,
      type: 'escalation',
      blockReason: 'worker_escalation',
      payload: { reason },
      eventType: 'worker.escalation',
    });
  }, {
    type: 'function',
    function: {
      name: 'escalate',
      description: 'Escalate to a human operator, blocking the task. Use when the task cannot continue without human intervention (e.g. destructive action requiring approval, ambiguous requirement, suspected safety issue). The operator intervenes via the existing recover/steering flow.',
      parameters: {
        type: 'object',
        properties: {
          reason: { type: 'string', description: 'Why human intervention is needed.' },
        },
        required: ['reason'],
      },
    },
  }, {
    riskLevel: 'L1',
    permissions: ['worker:escalate'],
    timeoutMs: 5_000,
    retryable: false,
    idempotent: false,
    costLevel: 'low',
    sideEffect: true,
    tags: ['worker', 'block', 'escalation'],
  });
}
