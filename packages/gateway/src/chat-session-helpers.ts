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
import { claimRunSpec, listRunSpecs, type RunSpecRecord } from '@los/agent/run-specs';
import { listServiceInstances, loadServiceInstance, type ServiceInstanceRecord } from '@los/agent/service-instances';
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

// ── Session recovery (cross-gateway failover) ────────────

export interface RecoverableSession {
  sessionId: string;
  lastCheckpointAt: string | null;
  messageCount: number;
  turnCount: number;
  incompleteRunSpecs: Array<{
    id: string;
    status: string;
    prompt: string;
    createdAt: string;
    gatewayId?: string;
    gatewayOnline?: boolean;
  }>;
  lastEventId: number | null;
  recentEventCount: number;
}

export async function findRecoverableSessions(opts?: {
  limit?: number;
}): Promise<RecoverableSession[]> {
  const limit = opts?.limit ?? 50;
  const activeRunSpecs = await listRunSpecs(500);
  const incomplete = activeRunSpecs.filter(
    r => r.status === 'failed' || r.status === 'cancelled' || r.status === 'blocked' || r.status === 'running',
  );

  // Batch-load service instances for gateway liveness checks
  const gatewayIds = [...new Set(incomplete.map(r => r.gatewayId).filter((id): id is string => Boolean(id)))];
  const gatewayStatuses = new Map<string, boolean>();
  for (const gid of gatewayIds) {
    const inst = await loadServiceInstance(gid).catch(() => null);
    gatewayStatuses.set(gid, inst?.status === 'online');
  }

  const seen = new Set<string>();
  const results: RecoverableSession[] = [];

  for (const spec of incomplete) {
    if (!spec.sessionId || seen.has(spec.sessionId)) continue;
    seen.add(spec.sessionId);

    const session = await loadSession(spec.sessionId).catch(() => null);
    if (!session || session.messages.length === 0) continue;

    const sessionIncomplete = incomplete.filter(r => r.sessionId === spec.sessionId);
    const recentEvents = await listRecentSessionEvents(spec.sessionId, 10).catch(() => [] as SessionEventRecord[]);

    results.push({
      sessionId: spec.sessionId,
      lastCheckpointAt: session.updatedAt,
      messageCount: session.messages.length,
      turnCount: session.turns.length,
      incompleteRunSpecs: sessionIncomplete.map(r => ({
        id: r.id,
        status: r.status ?? 'unknown',
        prompt: r.prompt ?? '',
        createdAt: r.createdAt,
        gatewayId: r.gatewayId,
        gatewayOnline: r.gatewayId ? (gatewayStatuses.get(r.gatewayId) ?? false) : undefined,
      })),
      lastEventId: recentEvents.at(-1)?.id ?? null,
      recentEventCount: recentEvents.length,
    });

    if (results.length >= limit) break;
  }

  return results;
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

// ── Auto orphan reclamation ────────────────────────────

export interface OrphanReclamationResult {
  staleGatewayIds: string[];
  claimedRunSpecIds: string[];
  errors: string[];
}

export async function reclaimOrphanedRuns(gatewayServiceId: string): Promise<OrphanReclamationResult> {
  const staleGatewayIds: string[] = [];
  const claimedRunSpecIds: string[] = [];
  const errors: string[] = [];

  try {
    // Find gateways whose heartbeat is older than 60s
    const services = await listServiceInstances(200);
    const now = Date.now();
    const staleMs = 60_000;

    for (const svc of services) {
      if (svc.serviceId === gatewayServiceId) continue;
      if (svc.serviceKind !== 'gateway') continue;
      const heartbeatAge = now - new Date(svc.lastHeartbeatAt).getTime();
      if (heartbeatAge > staleMs && svc.status === 'online') {
        staleGatewayIds.push(svc.serviceId);
      }
    }

    if (staleGatewayIds.length === 0) return { staleGatewayIds: [], claimedRunSpecIds: [], errors: [] };

    // Find orphaned run specs owned by stale gateways
    const allSpecs = await listRunSpecs(1000);
    const nonTerminal = new Set(['created', 'running', 'blocked']);
    const orphaned = allSpecs.filter(
      r => r.gatewayId && staleGatewayIds.includes(r.gatewayId) && nonTerminal.has(r.status),
    );

    for (const spec of orphaned) {
      try {
        await claimRunSpec(spec.id, gatewayServiceId);
        claimedRunSpecIds.push(spec.id);
      } catch (err) {
        errors.push(`${spec.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } catch (err) {
    errors.push(`reclamation scan failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  return { staleGatewayIds, claimedRunSpecIds, errors };
}
