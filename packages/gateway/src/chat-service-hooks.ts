import type { Config } from '@los/infra/config';
import { ensureSessionStore, saveSession } from '@los/agent/session';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { emitRunningToolCallUpsert, emitToolCallUpsertFromSessionEvent, relaySessionEvent } from './chat-live-events.js';
import { persistStreamCheckpoint } from './chat-stream-persist.js';
import { getLogger } from '@los/infra/logger';

const log = getLogger('chat-hooks');
const checkpointTracker = new Map<string, { count: number; lastAt: number }>();
const toolStateCache = new Map<string, {
  pendingCalls: Array<{ callId: string; toolName: string; args: Record<string, unknown>; status: string }>;
  lastResults: Array<{ callId: string; toolName: string; outcome: string; resultSummary: string }>;
  fileReferences: Array<{ path: string; contentHash: string; lastOperation: string }>;
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
  allowedTools?: string[];
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
      updateToolStateCache(sid, event);

      if (event.type === 'session.completed' || event.type === 'session.error') {
        import('@los/memory').then(({ compactSession }) =>
          compactSession({
            sessionId: sid, runSpecId,
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
      const timeSinceLast = Date.now() - ck.lastAt;
      const triggeredByCount = ck.count >= 20;
      const shouldCheckpoint = triggeredByCount || isToolTransition || timeSinceLast >= 10 * 60 * 1000;
      if (shouldCheckpoint) {
        ck.count = 0; ck.lastAt = Date.now();
        const trigger = triggeredByCount ? 'event_count' : isToolTransition ? 'tool_state_change' : 'time_interval';
        const wsRoot = input.workspaceRoot;
        import('@los/memory').then(({ compactSession }) =>
          compactSession({
            sessionId: sid, runSpecId, checkpoint: true, autoTrigger: trigger,
            onPreCompact: async (ctx) => {
              const ts = toolStateCache.get(sid);
              if (ts && ts.pendingCalls.length > 0) {
                log.debug(`Checkpoint with ${ts.pendingCalls.length} pending tool calls`);
              }
            },
            onPostCompact: async (ctx) => {
              rebuildFileContext({ ctx, sid, wsRoot, send });
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
              // Re-declare available tools after compaction (name-only list)
              if (input.allowedTools && input.allowedTools.length > 0) {
                send('operator', {
                  type: 'compaction.tool_catalog',
                  sessionId: ctx.sessionId,
                  compactionId: ctx.compactionId,
                  tools: input.allowedTools,
                  count: input.allowedTools.length,
                });
              }
            },
          }).catch(() => undefined)
        ).catch(() => undefined);
      }
      checkpointTracker.set(sid, ck);
    },
  };
}

// ── Tool state tracking for compaction checkpoints ───────────────

function updateToolStateCache(sessionId: string, event: any): void {
  const ts = toolStateCache.get(sessionId) ?? {
    pendingCalls: [],
    lastResults: [],
    fileReferences: [],
  };

  if (event.type === 'tool_call_state.updated') {
    const payload = event.payload as Record<string, unknown> | undefined;
    const status = payload?.to as string | undefined;
    if (status === 'succeeded' || status === 'failed' || status === 'cancelled') {
      // Move from pending to lastResults
      const callId = event.tool_call_state_id as string;
      ts.pendingCalls = ts.pendingCalls.filter(c => c.callId !== callId);
      ts.lastResults.push({
        callId,
        toolName: event.toolName ?? 'unknown',
        outcome: status === 'succeeded' ? 'success' : status === 'failed' ? 'error' : 'cancelled',
        resultSummary: typeof payload?.result === 'string'
          ? payload.result.slice(0, 200)
          : `${status} at ${new Date().toISOString()}`,
      });
      // Keep only last 5 results
      if (ts.lastResults.length > 5) ts.lastResults = ts.lastResults.slice(-5);
    } else {
      // Still pending
      ts.pendingCalls.push({
        callId: event.tool_call_state_id as string ?? `pending-${Date.now()}`,
        toolName: event.toolName ?? 'unknown',
        args: (payload?.args as Record<string, unknown>) ?? {},
        status: status ?? 'requested',
      });
    }
  } else if (event.type === 'tool.execute') {
    // Track file references from tool executions
    const payload = event.payload as Record<string, unknown> | undefined;
    const filePath = payload?.path as string | undefined;
    const fileRefs = payload?.fileReferences as Array<{ path: string; hash?: string }> | undefined;
    if (filePath) {
      ts.fileReferences.push({
        path: filePath,
        contentHash: '',
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

// ── PostCompact file context rebuild ────────────────────────

const MAX_REBUILD_FILES = 5;
const MAX_FILE_CONTENT_CHARS = 2000;

interface RebuildFileContextInput {
  ctx: {
    sessionId: string;
    compactionId: string;
    trigger?: string;
    symbolSummary?: Array<{
      symbolId: string;
      name: string;
      kind: string;
      file: string;
      operationCount: number;
    }>;
  };
  sid: string;
  wsRoot: string;
  send: (event: string, payload: unknown) => void;
}

function rebuildFileContext(input: RebuildFileContextInput): void {
  const { ctx, sid, wsRoot, send } = input;
  const symbols = ctx.symbolSummary;
  if (!symbols || symbols.length === 0) return;

  const fileMap = new Map<string, { path: string; operationCount: number }>();
  for (const s of symbols) {
    if (!s.file) continue;
    const existing = fileMap.get(s.file);
    if (!existing || existing.operationCount < s.operationCount) {
      fileMap.set(s.file, { path: s.file, operationCount: s.operationCount });
    }
  }

  const topFiles = [...fileMap.values()]
    .sort((a, b) => b.operationCount - a.operationCount)
    .slice(0, MAX_REBUILD_FILES);
  if (topFiles.length === 0) return;

  const ts = toolStateCache.get(sid);
  const fileContexts: Array<{
    path: string; content: string; truncated: boolean; hash: string; changed: boolean | null;
  }> = [];

  for (const { path: filePath } of topFiles) {
    const resolved = resolvePath(wsRoot, filePath);
    try {
      const content = readFileSync(resolved, 'utf-8');
      const hash = createHash('sha256').update(content).digest('hex').slice(0, 16);
      const truncated = content.length > MAX_FILE_CONTENT_CHARS;
      const prevRef = ts?.fileReferences.find(r => r.path === filePath);
      const changed = prevRef ? prevRef.contentHash !== hash : null;
      fileContexts.push({ path: filePath,
        content: truncated ? content.slice(0, MAX_FILE_CONTENT_CHARS) : content,
        truncated, hash, changed });
      if (ts) ts.fileReferences.push({ path: filePath, contentHash: hash, lastOperation: 'read' });
    } catch { /* file deleted or unreadable */ }
  }

  if (fileContexts.length > 0) {
    send('operator', {
      type: 'compaction.file_context',
      sessionId: ctx.sessionId, compactionId: ctx.compactionId,
      trigger: ctx.trigger ?? 'checkpoint',
      files: fileContexts, rebuiltAt: new Date().toISOString(),
    });
  }
}
