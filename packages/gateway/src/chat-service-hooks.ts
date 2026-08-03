import type { Config } from '@los/infra/config';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { ensureSessionStore, saveSession } from '@los/agent/session';
import { emitRunningToolCallUpsert, emitToolCallUpsertFromSessionEvent, relaySessionEvent } from './chat-live-events.js';
import { persistStreamCheckpoint } from './chat-stream-persist.js';
import { getLogger } from '@los/infra/logger';
import type { RecoveryCheckpointInput } from '@los/memory';

const log = getLogger('chat-hooks');
const checkpointTracker = new Map<string, { count: number; lastAt: number }>();

// Recovery-checkpoint cadence (event-storm convergence, advisory 2026-08-04 candidate A).
// Every tool transition used to trigger one compactSession — long runs with 200+ tool
// calls produced 200+ compaction.pre/post_compact event pairs plus 200+ rows in
// memory_compactions. Throttle to at most one checkpoint per MIN_INTERVAL while
// keeping the event-count cadence and the max-interval backstop.
const CHECKPOINT_MIN_INTERVAL_MS = 60_000;
const CHECKPOINT_EVENT_COUNT = 20;
const CHECKPOINT_MAX_INTERVAL_MS = 10 * 60_000;
const toolStateCache = new Map<string, {
  pendingCalls: RecoveryCheckpointInput['toolState']['pendingCalls'];
  lastResults: RecoveryCheckpointInput['toolState']['lastResult'];
  fileReferences: RecoveryCheckpointInput['fileReferences'];
  lastEventId: string;
  lastEventIndex: number;
  turns: Set<number>;
}>();

export function createChatTaskHooks(input: {
  sid: string;
  runSpecId: string;
  requestId: string;
  tenantId: string;
  projectId: string;
  userId: string;
  traceId: string;
  provider: string | undefined;
  model: string | undefined;
  workspaceRoot: string;
  toolMode: string;
  config: Config;
  resumedSession: any;
  ctx: { activeTaskRunId: string | undefined; lastCheckpoint: any };
  send: (event: string, payload: unknown) => void;
}) {
  const { sid, runSpecId, requestId, tenantId, projectId, userId, traceId, send, ctx } = input;
  let sentSession = false;
  return {
    onTaskEvent: (event: any) => {
      ctx.activeTaskRunId = event.taskRun.id;
      if (!sentSession && event.type !== 'task.deduplicated') {
        sentSession = true;
        send('session', {
          sessionId: event.taskRun.sessionId, taskRunId: event.taskRun.id, traceId: event.taskRun.traceId,
          requestId, nodeId: event.taskRun.nodeId ?? null, dedupeKey: event.taskRun.dedupeKey ?? null,
          model: event.taskRun.model ?? null,
        });
      }
      send('task', {
        type: event.type, taskRunId: event.taskRun.id, sessionId: event.taskRun.sessionId,
        traceId: event.taskRun.traceId, requestId, nodeId: event.taskRun.nodeId ?? null,
        dedupeKey: event.taskRun.dedupeKey ?? null, status: event.taskRun.status,
        model: event.taskRun.model ?? null,
      });
    },
    onTurn: async (turn: any) => {
      send('turn', {
        loopCount: turn.loopCount, text: turn.text.slice(0, 200), toolCallCount: turn.toolCalls.length,
        toolNames: turn.toolCalls.map((tc: any) => tc.function.name), reasoning: turn.reasoningContent?.slice(0, 200),
      });
      await persistStreamCheckpoint({
        sessionId: sid, runSpecId, eventType: 'turn', turn: turn.loopCount,
        payload: { loopCount: turn.loopCount, textPreview: turn.text.slice(0, 500), toolCallCount: turn.toolCalls.length,
          toolNames: turn.toolCalls.map((tc: any) => tc.function.name) },
      });
    },
    onToolCall: async (callId: string, tool: string, args: unknown, turn: number) => {
      _trackRequestedToolCall(sid, callId, tool, args, turn);
      await emitRunningToolCallUpsert({ send, sessionId: sid, runSpecId, turn, callId, toolName: tool, input: args as Record<string, unknown> });
      import('./chat-cbm-symbol-cache.js').then(m => m.cacheSymbolsForToolCall(
        sid, callId, tool, args as Record<string, unknown>, input.workspaceRoot,
      )).catch(() => undefined);
    },
    onModelDelta: async (delta: any) => {
      send('model.delta', {
        turn: delta.turn, provider: delta.provider, model: delta.model ?? null,
        textDelta: delta.textDelta ?? '', reasoningDelta: delta.reasoningDelta ?? '',
      });
      await persistStreamCheckpoint({
        sessionId: sid, runSpecId, eventType: 'model.delta', turn: delta.turn,
        payload: { provider: delta.provider, model: delta.model ?? null, textDelta: delta.textDelta ?? '', reasoningDelta: delta.reasoningDelta ?? '' },
      });
    },
    onCheckpoint: async (state: any) => {
      ctx.lastCheckpoint = state;
      await ensureSessionStore().catch(() => undefined);
      await saveSession({
        id: sid, tenantId, projectId, userId, requestId, traceId,
        createdAt: input.resumedSession?.createdAt ?? new Date().toISOString(), updatedAt: new Date().toISOString(),
        messages: state.messages, turns: input.resumedSession ? [...input.resumedSession.turns, ...state.turns] : state.turns,
        metadata: { ...(input.resumedSession?.metadata ?? {}), provider: input.provider ?? input.config.agent.defaultProvider,
          model: input.model ?? null, workspaceRoot: input.workspaceRoot, toolMode: input.toolMode },
      }).catch(() => undefined);
    },
    onSessionEvent: async (event: any) => {
      relaySessionEvent(send, event);
      await emitToolCallUpsertFromSessionEvent({ send, sessionId: sid, runSpecId, event });

      // Track tool state for checkpoint snapshots
      _updateToolStateCache(sid, event);

      if (event.type === 'session.completed' || event.type === 'session.error') {
        const recoveryCheckpoint = _snapshotRecoveryCheckpoint(sid);
        await persistRecoveryCheckpoint(sid, runSpecId, recoveryCheckpoint, 'manual', 'full');
        import('@los/memory').then(({ compactSession }) =>
          compactSession({
            sessionId: sid, runSpecId, recoveryCheckpoint,
            onPreCompact: async (ctx) => {
              // Save tool state snapshot before compaction
              const ts = toolStateCache.get(sid);
              if (ts) {
                send('operator', {
                  type: 'compaction.pre_compact',
                  sessionId: ctx.sessionId,
                  trigger: ctx.trigger ?? 'session_completed',
                  reason: event.type === 'session.error' ? 'Session error — compacting for recovery' : 'Session completed — running final compaction',
                  preCompactAt: ctx.preCompactAt,
                  pendingCalls: ts.pendingCalls.length,
                  fileReferences: ts.fileReferences.length,
                });
              }
            },
            onPostCompact: async (ctx) => {
              send('operator', {
                type: 'compaction.post_compact',
                sessionId: ctx.sessionId,
                compactionId: ctx.compactionId,
                observationCount: ctx.observationCount,
                taskRunCount: ctx.taskRunCount,
                proceduralCandidateCount: ctx.proceduralCandidateCount,
                confidence: ctx.confidence,
                mode: ctx.mode,
                metrics: (ctx.summary as any).compactionMetrics ?? null,
              });
            },
          }).catch(() => undefined)
        ).catch(() => undefined);
        checkpointTracker.delete(sid);
        toolStateCache.delete(sid);
        return;
      }
      const ck = checkpointTracker.get(sid) ?? { count: 0, lastAt: Date.now() };
      ck.count += 1;
      const isToolTransition = event.type === 'tool_call_state.updated'
        && ((event.payload as any)?.to === 'succeeded' || (event.payload as any)?.to === 'failed');
      const now = Date.now();
      const sinceLastCheckpoint = now - ck.lastAt;
      const triggeredByCount = ck.count >= CHECKPOINT_EVENT_COUNT;
      // Throttle to one checkpoint per CHECKPOINT_MIN_INTERVAL_MS: without this, every
      // tool transition (or every 20th event) triggers a compactSession, producing one
      // compaction.pre/post_compact event pair and one memory_compactions row each time
      // (200+ per long run). Events arriving inside the throttle window accumulate in
      // ck.count and fire as soon as the window passes; the max-interval backstop still
      // forces a checkpoint during idle stretches.
      const throttled = sinceLastCheckpoint < CHECKPOINT_MIN_INTERVAL_MS;
      const shouldCheckpoint = sinceLastCheckpoint >= CHECKPOINT_MAX_INTERVAL_MS
        || (!throttled && (triggeredByCount || isToolTransition));
      if (shouldCheckpoint) {
        ck.count = 0; ck.lastAt = now;
        const trigger = triggeredByCount ? 'event_count' : isToolTransition ? 'tool_state_change' : 'time_interval';
        const recoveryCheckpoint = _snapshotRecoveryCheckpoint(sid);
        await persistRecoveryCheckpoint(sid, runSpecId, recoveryCheckpoint, trigger, 'checkpoint');
        import('@los/memory').then(({ compactSession }) =>
          compactSession({
            sessionId: sid, runSpecId, checkpoint: true, autoTrigger: trigger, recoveryCheckpoint,
            onPreCompact: async (ctx) => {
              const ts = toolStateCache.get(sid);
              if (ts) {
                send('operator', {
                  type: 'compaction.pre_compact',
                  sessionId: ctx.sessionId,
                  trigger: ctx.trigger ?? trigger,
                  reason: `Checkpoint triggered by ${ctx.trigger ?? 'unknown'}`,
                  preCompactAt: ctx.preCompactAt,
                  pendingCalls: ts.pendingCalls.length,
                  fileReferences: ts.fileReferences.length,
                });
              }
            },
            onPostCompact: async (ctx) => {
              send('operator', {
                type: 'compaction.post_compact',
                sessionId: ctx.sessionId,
                compactionId: ctx.compactionId,
                observationCount: ctx.observationCount,
                taskRunCount: ctx.taskRunCount,
                proceduralCandidateCount: ctx.proceduralCandidateCount,
                confidence: ctx.confidence,
                mode: ctx.mode,
                trigger: ctx.trigger ?? trigger,
                metrics: (ctx.summary as any).compactionMetrics ?? null,
              });
            },
          }).catch(() => undefined)
        ).catch(() => undefined);
      }
      checkpointTracker.set(sid, ck);
    },
  };
}

// ── Tool state tracking for compaction checkpoints ───────────────

export function _updateToolStateCache(sessionId: string, event: any): void {
  const ts = getOrCreateToolState(sessionId);

  if (Number.isSafeInteger(event.id) && event.id > 0) {
    ts.lastEventId = String(event.id);
    ts.lastEventIndex = event.id;
  }
  if (Number.isSafeInteger(event.turn) && event.turn > 0) ts.turns.add(event.turn);

  if (event.type === 'tool_call_state.updated') {
    const payload = event.payload as Record<string, unknown> | undefined;
    const status = payload?.to as string | undefined;
    const callId = String(payload?.entityId ?? payload?.callId ?? '');
    if (!callId) {
      toolStateCache.set(sessionId, ts);
      return;
    }
    const existing = ts.pendingCalls.find(call => call.callId === callId);
    const toolName = String(payload?.toolName ?? event.toolName ?? existing?.toolName ?? 'unknown');
    if (status === 'succeeded' || status === 'failed' || status === 'cancelled') {
      // Move from pending to lastResults
      ts.pendingCalls = ts.pendingCalls.filter(c => c.callId !== callId);
      ts.lastResults.push({
        callId,
        toolName,
        outcome: status === 'succeeded' ? 'success' : status === 'failed' ? 'error' : 'cancelled',
        resultSummary: typeof payload?.result === 'string'
          ? payload.result.slice(0, 200)
          : String(payload?.reason ?? `${status} at ${new Date().toISOString()}`).slice(0, 200),
      });
      // Keep only last 5 results
      if (ts.lastResults.length > 5) ts.lastResults = ts.lastResults.slice(-5);
    } else {
      const pendingStatus = status === 'running' ? 'running' : 'requested';
      const next = {
        callId,
        toolName,
        args: isRecord(payload?.args) ? payload.args : existing?.args ?? {},
        status: pendingStatus,
      } satisfies RecoveryCheckpointInput['toolState']['pendingCalls'][number];
      ts.pendingCalls = [...ts.pendingCalls.filter(call => call.callId !== callId), next];
    }
  } else if (event.type === 'tool.execute') {
    // Track file references from tool executions
    const payload = event.payload as Record<string, unknown> | undefined;
    const filePath = payload?.path as string | undefined;
    const fileRefs = payload?.fileReferences as Array<{ path: string; hash?: string }> | undefined;
    if (filePath) {
      ts.fileReferences.push({
        path: filePath,
        contentHash: computeFileContentHash(filePath),
        lastOperation: (payload?.op as string) === 'write' ? 'write' : 'read',
      });
    }
    if (fileRefs) {
      for (const ref of fileRefs) {
        ts.fileReferences.push({
          path: ref.path,
          contentHash: ref.hash ?? '',
          lastOperation: 'read',
        });
      }
    }
    // Keep only last 10 file references
    if (ts.fileReferences.length > 10) ts.fileReferences = ts.fileReferences.slice(-10);
  }

  toolStateCache.set(sessionId, ts);
}

export function _trackRequestedToolCall(
  sessionId: string,
  callId: string,
  toolName: string,
  args: unknown,
  turn: number,
): void {
  const ts = getOrCreateToolState(sessionId);
  if (turn > 0) ts.turns.add(turn);
  ts.pendingCalls = [
    ...ts.pendingCalls.filter(call => call.callId !== callId),
    { callId, toolName, args: isRecord(args) ? args : {}, status: 'requested' },
  ];
  toolStateCache.set(sessionId, ts);
}

export function _snapshotRecoveryCheckpoint(sessionId: string): RecoveryCheckpointInput | undefined {
  const ts = toolStateCache.get(sessionId);
  if (!ts) return undefined;
  return {
    toolState: {
      pendingCalls: ts.pendingCalls.map(call => ({ ...call, args: { ...call.args } })),
      lastResult: ts.lastResults.map(result => ({ ...result })),
    },
    fileReferences: ts.fileReferences.slice(-10).map(reference => ({ ...reference })),
    messageCursor: {
      lastEventId: ts.lastEventId,
      lastEventIndex: ts.lastEventIndex,
      turnCount: ts.turns.size,
    },
  };
}

async function persistRecoveryCheckpoint(
  sessionId: string,
  runSpecId: string,
  checkpoint: RecoveryCheckpointInput | undefined,
  trigger: string,
  mode: 'checkpoint' | 'full',
): Promise<void> {
  if (!checkpoint) return;
  await persistStreamCheckpoint({
    sessionId,
    runSpecId,
    eventType: 'session.recovery.checkpoint',
    turn: checkpoint.messageCursor.turnCount,
    payload: { ...checkpoint, trigger, mode },
  });
}

function getOrCreateToolState(sessionId: string) {
  return toolStateCache.get(sessionId) ?? {
    pendingCalls: [],
    lastResults: [],
    fileReferences: [],
    lastEventId: '',
    lastEventIndex: 0,
    turns: new Set<number>(),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Compute the same sha256 hex fingerprint used by detectStaleFiles
 * (session-recovery-context.ts) so recovery can compare checkpoint hashes
 * against current file content. Unreadable files keep an empty hash, which
 * detectStaleFiles already treats as stale.
 */
function computeFileContentHash(path: string): string {
  try {
    const content = readFileSync(path, 'utf-8');
    return createHash('sha256').update(content).digest('hex');
  } catch {
    return '';
  }
}
