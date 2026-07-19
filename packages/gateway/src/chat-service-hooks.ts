import type { Config } from '@los/infra/config';
import { ensureSessionStore, saveSession } from '@los/agent/session';
import { emitRunningToolCallUpsert, emitToolCallUpsertFromSessionEvent, relaySessionEvent } from './chat-live-events.js';
import { persistStreamCheckpoint } from './chat-stream-persist.js';

const checkpointTracker = new Map<string, { count: number; lastAt: number }>();

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
      if (event.type === 'session.completed' || event.type === 'session.error') {
        import('@los/memory').then(({ compactSession }) => compactSession({ sessionId: sid, runSpecId }).catch(() => undefined)).catch(() => undefined);
        checkpointTracker.delete(sid);
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
        import('@los/memory').then(({ compactSession }) => compactSession({ sessionId: sid, runSpecId, checkpoint: true, autoTrigger: trigger }).catch(() => undefined)).catch(() => undefined);
      }
      checkpointTracker.set(sid, ck);
    },
  };
}
