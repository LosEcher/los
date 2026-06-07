/**
 * Chat session helpers — resume state, todo binding, branch source loading.
 * Extracted from chat-route.ts.
 */

import type { TaskRunRecord } from '@los/agent/task-runs';
import type { SessionEventRecord } from '@los/agent/session-events';
import { listTaskRunsForSession } from '@los/agent/task-runs';
import { listRecentSessionEvents } from '@los/agent/session-events';
import { loadTodo, updateTodo, type TodoStatus } from '@los/agent/todos';
import { loadSession } from '@los/agent/session';
import type { Message } from '@los/agent';

// ── Replay event normalization ──────────────────────────

export function normalizeReplayEvents(value: unknown): Array<{ event: string; data: unknown }> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const events = (value as { events?: unknown }).events;
  if (!Array.isArray(events)) return [];
  return events.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const event = (entry as { event?: unknown }).event;
    if (typeof event !== 'string' || !event.trim()) return [];
    return [{ event, data: (entry as { data?: unknown }).data ?? {} }];
  });
}

// ── Resume state ─────────────────────────────────────────

export async function loadResumeState(sessionId: string) {
  const [taskRuns, recentEvents] = await Promise.all([
    listTaskRunsForSession(sessionId, 10),
    listRecentSessionEvents(sessionId, 50),
  ]);
  const compactTasks = taskRuns.map(summarizeTaskRunForResume);
  const compactEvents = recentEvents.map(summarizeEventForResume);
  return {
    recentTaskRuns: compactTasks,
    activeTaskRuns: compactTasks.filter(task => task.status === 'queued' || task.status === 'running'),
    lastTaskRun: compactTasks[0] ?? null,
    recentEvents: compactEvents,
    recentEventCount: compactEvents.length,
    lastEventId: compactEvents.at(-1)?.id ?? null,
  };
}

function summarizeTaskRunForResume(task: TaskRunRecord): Record<string, unknown> {
  return {
    id: task.id, status: task.status, traceId: task.traceId,
    dedupeKey: task.dedupeKey ?? null, nodeId: task.nodeId ?? null,
    requestId: task.requestId ?? null, provider: task.provider ?? null,
    model: task.model ?? null, startedAt: task.startedAt ?? null,
    completedAt: task.completedAt ?? null, heartbeatAt: task.heartbeatAt ?? null,
    leaseExpiresAt: task.leaseExpiresAt ?? null, updatedAt: task.updatedAt,
  };
}

function summarizeEventForResume(event: SessionEventRecord): Record<string, unknown> {
  return {
    id: event.id, type: event.type, turn: event.turn,
    source: event.source, model: event.model ?? null,
    toolName: event.toolName ?? null, payload: event.payload,
    createdAt: event.createdAt,
  };
}

// ── Todo binding ─────────────────────────────────────────

export type BoundTodoUpdate = {
  status: TodoStatus; sessionId: string; taskRunId?: string;
  traceId: string; requestId: string; runSpecId?: string;
  event: string; reason?: string; blockedVerificationRecordIds?: string[];
};

export async function updateBoundTodoFromRun(todoId: string, input: BoundTodoUpdate): Promise<void> {
  const existing = await loadTodo(todoId).catch(() => null);
  if (!existing) return;
  await updateTodo(todoId, {
    status: input.status, sessionId: input.sessionId,
    taskRunId: input.taskRunId ?? existing.taskRunId ?? null,
    traceId: input.traceId, requestId: input.requestId,
    metadata: {
      ...existing.metadata, dispatchReady: false,
      lastRun: {
        ...(isRecord(existing.metadata.lastRun) ? existing.metadata.lastRun : {}),
        event: input.event, status: input.status,
        sessionId: input.sessionId,
        taskRunId: input.taskRunId ?? existing.taskRunId ?? null,
        traceId: input.traceId, requestId: input.requestId,
        runSpecId: input.runSpecId ?? null,
        reason: input.reason ?? null,
        blockedVerificationRecordIds: input.blockedVerificationRecordIds ?? [],
        updatedAt: new Date().toISOString(),
      },
    },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

// ── Branch source loading ────────────────────────────────

export async function loadBranchSource(branchFrom: string, branchAtTurn?: number) {
  const parent = await loadSession(branchFrom);
  if (!parent) return { error: `Branch source session not found: ${branchFrom}` };
  let messages: Message[];
  if (branchAtTurn && branchAtTurn > 0) {
    let assistantCount = 0;
    const filtered: Message[] = [];
    for (const msg of parent.messages) {
      if (msg.role === 'assistant') {
        if (assistantCount >= branchAtTurn) break;
        assistantCount++;
      }
      filtered.push(msg);
    }
    messages = filtered;
  } else {
    messages = parent.messages;
  }
  return { messages, parent };
}
