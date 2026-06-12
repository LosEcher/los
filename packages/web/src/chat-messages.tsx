/**
 * Chat message types, accumulation logic, and bubble rendering components.
 * Refactored from the flat event-log pattern to message-bubble pattern.
 */
import { type ReactNode, useState } from 'react';
import { Wrench } from 'lucide-react';
import { EmptyText } from './ui.js';
import type { StreamRow } from './chat-helpers.js';

// ── Types ────────────────────────────────────────────

export type ToolCallStatus = 'running' | 'completed' | 'error' | 'denied';

export type ToolCall = {
  callId: string;
  toolName: string;
  argsPreview: string;
  args?: Record<string, unknown>;
  resultPreview?: string;
  errorPreview?: string;
  status: ToolCallStatus;
  durationMs?: number;
  attempts?: number;
};

export type MessageRole = 'user' | 'assistant' | 'system' | 'separator';

export type Message = {
  id: string;
  role: MessageRole;
  content: string;
  // Assistant-specific
  turnIndex?: number;
  totalTurns?: number;
  provider?: string;
  model?: string;
  toolCalls: ToolCall[];
  reasoning?: string;
  loopCount?: number;
  // System/separator
  eventType?: string;
  level?: 'normal' | 'ok' | 'warn' | 'error';
  meta?: string;
};

// ── Helpers ──────────────────────────────────────────

function truncateJson(raw: string, maxLen: number): string {
  return raw.length > maxLen ? raw.slice(0, maxLen) + '…' : raw;
}

// ── Accumulation ─────────────────────────────────────

export function accumulateEvent(
  messages: Message[],
  event: string,
  data: Record<string, unknown>,
): Message[] {
  const msgs = [...messages];
  const last = msgs[msgs.length - 1];

  // ── model.delta: append text to current assistant bubble ──
  if (event === 'model.delta') {
    const textDelta = String(data.textDelta ?? data.text ?? data.delta ?? '');
    const reasoningDelta = String(data.reasoningDelta ?? '');
    const provider = typeof data.provider === 'string' ? data.provider : undefined;
    const model = typeof data.model === 'string' ? data.model : undefined;

    if (last && last.role === 'assistant') {
      msgs[msgs.length - 1] = {
        ...last,
        content: last.content + textDelta,
        reasoning: reasoningDelta ? (last.reasoning ?? '') + reasoningDelta : last.reasoning,
        provider: provider ?? last.provider,
        model: model ?? last.model,
      };
    } else {
      msgs.push({
        id: crypto.randomUUID(),
        role: 'assistant',
        content: textDelta,
        reasoning: reasoningDelta || undefined,
        provider,
        model,
        toolCalls: [],
        turnIndex: (last?.turnIndex ?? 0) + 1,
      });
    }
    return msgs;
  }

  // ── tool.call.upsert: stable UI event from gateway live stream / replay ──
  if (event === 'tool.call.upsert' || event === 'tool_call') {
    const toolName = String(data.toolName ?? data.tool ?? '');
    const callId = typeof data.callId === 'string' && data.callId ? data.callId : '';
    if (!callId) return msgs;
    const toolCall: ToolCall = {
      callId,
      toolName,
      argsPreview: typeof data.argsPreview === 'string' ? data.argsPreview : '',
      status: data.status === 'completed' || data.status === 'error' || data.status === 'denied' ? data.status : 'running',
      resultPreview: typeof data.resultPreview === 'string' ? data.resultPreview : undefined,
      errorPreview: typeof data.errorPreview === 'string' ? data.errorPreview : undefined,
      durationMs: typeof data.durationMs === 'number' ? data.durationMs : undefined,
      attempts: typeof data.attempts === 'number' ? data.attempts : undefined,
    };
    const idx = [...msgs].reverse().findIndex(m => m.role === 'assistant' && m.toolCalls.some(tc => tc.callId === callId));
    if (idx >= 0) {
      const realIdx = msgs.length - 1 - idx;
      const target = msgs[realIdx]!;
      msgs[realIdx] = {
        ...target,
        toolCalls: target.toolCalls.map(tc => (tc.callId === callId ? { ...tc, ...toolCall } : tc)),
      };
      return msgs;
    }
    if (last && last.role === 'assistant') {
      msgs[msgs.length - 1] = {
        ...last,
        toolCalls: [...last.toolCalls, toolCall],
      };
    } else {
      msgs.push({
        id: crypto.randomUUID(),
        role: 'assistant',
        content: '',
        toolCalls: [toolCall],
        turnIndex: (last?.turnIndex ?? 0) + 1,
      });
    }
    return msgs;
  }

  if (event === 'tool.call') {
    const toolName = typeof data.toolName === 'string' ? data.toolName : '';
    const payload = (data.payload && typeof data.payload === 'object' && !Array.isArray(data.payload))
      ? (data.payload as Record<string, unknown>)
      : {};
    const callId = typeof payload.callId === 'string' ? payload.callId : '';
    if (!callId) return msgs;
    const args = (payload.args && typeof payload.args === 'object' && !Array.isArray(payload.args))
      ? (payload.args as Record<string, unknown>)
      : undefined;
    let argsPreview = '';
    try {
      argsPreview = truncateJson(JSON.stringify(args ?? {}), 200);
    } catch {
      argsPreview = '';
    }
    const toolCall: ToolCall = {
      callId,
      toolName,
      args,
      argsPreview,
      status: 'running',
    };
    const idx = [...msgs].reverse().findIndex(m => m.role === 'assistant' && m.toolCalls.some(tc => tc.callId === callId));
    if (idx >= 0) {
      const realIdx = msgs.length - 1 - idx;
      const target = msgs[realIdx]!;
      msgs[realIdx] = {
        ...target,
        toolCalls: target.toolCalls.map(tc => (tc.callId === callId ? { ...tc, ...toolCall } : tc)),
      };
      return msgs;
    }

    if (last && last.role === 'assistant') {
      msgs[msgs.length - 1] = {
        ...last,
        toolCalls: [...last.toolCalls, toolCall],
      };
    } else {
      msgs.push({
        id: crypto.randomUUID(),
        role: 'assistant',
        content: '',
        toolCalls: [toolCall],
        turnIndex: (last?.turnIndex ?? 0) + 1,
      });
    }
    return msgs;
  }

  if (event === 'tool.result') {
    const payload = (data.payload && typeof data.payload === 'object' && !Array.isArray(data.payload))
      ? (data.payload as Record<string, unknown>)
      : {};
    const callId = typeof payload.callId === 'string' ? payload.callId : '';
    const ok = payload.ok === true;
    const denied = payload.denied === true;
    const status: ToolCallStatus = denied ? 'denied' : ok ? 'completed' : 'error';
    const resultPreview = typeof payload.contentPreview === 'string' ? payload.contentPreview : undefined;
    const errorPreview = typeof payload.errorPreview === 'string' ? payload.errorPreview : undefined;
    const durationMs = typeof payload.durationMs === 'number' ? payload.durationMs : undefined;
    const attempts = typeof payload.attempts === 'number' ? payload.attempts : undefined;

    const idx = [...msgs].reverse().findIndex(m => m.role === 'assistant' && m.toolCalls.some(tc => tc.callId === callId));
    if (idx >= 0) {
      const realIdx = msgs.length - 1 - idx;
      const target = msgs[realIdx]!;
      msgs[realIdx] = {
        ...target,
        toolCalls: target.toolCalls.map(tc => {
          if (tc.callId !== callId) return tc;
          return {
            ...tc,
            status,
            resultPreview: resultPreview ?? tc.resultPreview,
            errorPreview: errorPreview ?? tc.errorPreview,
            durationMs: durationMs ?? tc.durationMs,
            attempts: attempts ?? tc.attempts,
          };
        }),
      };
    }
    return msgs;
  }

  // ── turn: finalize current assistant turn ──
  if (event === 'turn') {
    const toolNames: string[] = Array.isArray(data.toolNames) ? (data.toolNames as string[]) : [];
    if (last && last.role === 'assistant') {
      msgs[msgs.length - 1] = {
        ...last,
        content: last.content || String(data.text ?? ''),
        reasoning: String(data.reasoning ?? last.reasoning ?? ''),
        loopCount: Number(data.loopCount ?? 0),
        totalTurns: typeof data.totalTurns === 'number' ? data.totalTurns : last.totalTurns,
      };
    } else {
      msgs.push({
        id: crypto.randomUUID(),
        role: 'assistant',
        content: String(data.text ?? ''),
        reasoning: String(data.reasoning ?? ''),
        toolCalls: toolNames.map(name => ({
          callId: crypto.randomUUID(),
          toolName: name,
          argsPreview: '',
          status: 'completed' as const,
        })),
        loopCount: Number(data.loopCount ?? 0),
        turnIndex: (last?.turnIndex ?? 0) + 1,
      });
    }
    return msgs;
  }

  // ── done ──
  if (event === 'done') {
    msgs.push({
      id: crypto.randomUUID(),
      role: 'system',
      content: typeof data.text === 'string' ? data.text : 'Run completed.',
      eventType: 'done',
      level: 'ok',
      meta: data.sessionId ? `session ${data.sessionId}` : undefined,
      toolCalls: [],
    });
    return msgs;
  }

  // ── error ──
  if (event === 'error') {
    msgs.push({
      id: crypto.randomUUID(),
      role: 'system',
      content: String(data.message ?? 'stream error'),
      eventType: 'error',
      level: 'error',
      toolCalls: [],
    });
    return msgs;
  }

  // ── session lifecycle events ──
  if (event === 'session' || event === 'session.resumed' || event === 'session.branched' ||
      event === 'session.resume_state' || event === 'session.loading') {
    msgs.push({
      id: crypto.randomUUID(),
      role: 'system',
      content: formatSessionEvent(event, data),
      eventType: event,
      level: 'ok',
      meta: eventMeta(event, data),
      toolCalls: [],
    });
    return msgs;
  }

  // ── task ──
  if (event === 'task') {
    const status = String(data.status ?? '');
    msgs.push({
      id: crypto.randomUUID(),
      role: 'system',
      content: String(data.type ?? data.status ?? 'task event'),
      eventType: 'task',
      level: status.includes('succeeded') ? 'ok' : status.includes('failed') ? 'error' : 'normal',
      meta: [data.taskRunId, data.nodeId].filter(Boolean).join(' · '),
      toolCalls: [],
    });
    return msgs;
  }

  // ── cancelled / deduplicated ──
  if (event === 'cancelled' || event === 'deduplicated') {
    msgs.push({
      id: crypto.randomUUID(),
      role: 'system',
      content: event === 'cancelled' ? 'Run cancelled.' : 'Deduplicated — matching run already in progress.',
      eventType: event,
      level: 'warn',
      meta: data.taskRunId ? `task ${data.taskRunId}` : undefined,
      toolCalls: [],
    });
    return msgs;
  }

  // ── fallback for unknown events ──
  msgs.push({
    id: crypto.randomUUID(),
    role: 'system',
    content: JSON.stringify(data),
    eventType: event,
    level: 'normal',
    meta: `event: ${event}`,
    toolCalls: [],
  });
  return msgs;
}

function formatSessionEvent(event: string, data: Record<string, unknown>): string {
  if (event === 'session' && data.sessionId) return `Session started: ${data.sessionId}`;
  if (event === 'session.resumed') return `Resumed session (${data.turnCount ?? '?'} turns, ${data.messageCount ?? '?'} msgs)`;
  if (event === 'session.branched') return `Branched from ${String(data.parentSessionId ?? 'unknown')}`;
  if (event === 'session.resume_state') return 'Loaded session resume state.';
  if (event === 'session.loading') return String(data.message ?? data);
  return String(data.message ?? data);
}

function eventMeta(event: string, data: Record<string, unknown>): string | undefined {
  if (event === 'session') return data.taskRunId ? `task ${data.taskRunId}` : undefined;
  if (event === 'session.branched') return `${data.copiedMessageCount ?? data.messageCount ?? '?'} messages copied`;
  if (event === 'session.resumed') return `last task ${String(data.resumeLastTaskRunId ?? 'none')}`;
  return undefined;
}

// ── History ──────────────────────────────────────────

export function buildHistoryMessages(
  apiMessages: Array<Record<string, unknown>>,
  turns: Array<Record<string, unknown>>,
): Message[] {
  const result: Message[] = [];
  let turnIdx = 0;

  for (const msg of apiMessages) {
    const role = String(msg.role ?? '');
    if (role === 'system') continue;

    if (role === 'user') {
      const content = String(msg.content ?? '');
      result.push({
        id: crypto.randomUUID(),
        role: 'user',
        content: content.length > 400 ? content.slice(0, 400) + '…' : content,
        toolCalls: [],
      });
    } else if (role === 'assistant') {
      const toolCalls = Array.isArray(msg.tool_calls)
        ? (msg.tool_calls as Array<Record<string, unknown>>)
        : [];
      const tcList: ToolCall[] = toolCalls.map(tc => ({
        callId: String(tc.id ?? crypto.randomUUID()),
        toolName: String((tc.function as Record<string, unknown> | undefined)?.name ?? ''),
        argsPreview: truncateJson(String((tc.function as Record<string, unknown> | undefined)?.arguments ?? ''), 200),
        status: 'completed' as const,
      }));
      const text = String(msg.content ?? '');
      const turn = turns[turnIdx] as Record<string, unknown> | undefined;
      const reasoning = turn?.reasoningContent && typeof turn.reasoningContent === 'string'
        ? turn.reasoningContent
        : undefined;
      result.push({
        id: crypto.randomUUID(),
        role: 'assistant',
        content: text,
        reasoning,
        toolCalls: tcList,
        turnIndex: turnIdx + 1,
        totalTurns: turns.length,
      });
      turnIdx++;
    }
    // tool role messages are implicitly covered by the assistant's tool_calls
  }

  result.push({
    id: crypto.randomUUID(),
    role: 'separator',
    content: `${result.length} prior messages shown. Send a prompt to continue.`,
    level: 'ok',
    meta: `${turnIdx} turns in history`,
    toolCalls: [],
  });

  return result;
}

export function readyMessages(): Message[] {
  return [{
    id: crypto.randomUUID(),
    role: 'system',
    content: 'Choose a project, provider, model, and tool mode before sending.',
    meta: 'project tools can edit files; choose all tools when the run needs shell commands',
    toolCalls: [],
  }];
}



// ── Components ───────────────────────────────────────

export function ToolCard({ toolCall }: { toolCall: ToolCall }) {
  return (
    <details className="tool-card">
      <summary className="tool-card-head">
        <Wrench size={12} />
        <strong>{toolCall.toolName}</strong>
        {toolCall.status === 'running' && <span className="tool-status running">running</span>}
        {toolCall.status === 'completed' && <span className="tool-status completed">done</span>}
        {toolCall.status === 'error' && <span className="tool-status error">error</span>}
        {toolCall.status === 'denied' && <span className="tool-status error">denied</span>}
      </summary>
      <div className="tool-card-body">
        {toolCall.argsPreview && (
          <div className="tool-args">
            <span className="tool-label">Args</span>
            <code>{toolCall.argsPreview}</code>
          </div>
        )}
        {toolCall.resultPreview && (
          <div className="tool-result">
            <span className="tool-label">Result</span>
            <code>{toolCall.resultPreview}</code>
          </div>
        )}
        {toolCall.errorPreview && (
          <div className="tool-result">
            <span className="tool-label">Error</span>
            <code>{toolCall.errorPreview}</code>
          </div>
        )}
      </div>
    </details>
  );
}

export function MessageBubble({ message }: { message: Message }) {
  if (message.role === 'separator') {
    return (
      <div className="chat-separator">
        <p>{message.content}</p>
        {message.meta ? <code>{message.meta}</code> : null}
      </div>
    );
  }

  if (message.role === 'system') {
    return (
      <div className={`chat-system-message${message.level ? ` level-${message.level}` : ''}`}>
        <span className="chat-system-event">{message.eventType ?? 'system'}</span>
        <div>
          <p>{message.content}</p>
          {message.meta ? <code>{message.meta}</code> : null}
        </div>
      </div>
    );
  }

  return (
    <div className={`chat-message ${message.role}`}>
      <div className={`chat-bubble chat-bubble-${message.role}`}>
        {message.role === 'assistant' && (
          <div className="chat-bubble-meta">
            {(message.provider || message.model) && (
              <span className="chat-provider-model">
                {[message.provider, message.model].filter(Boolean).join(' / ')}
              </span>
            )}
            {message.turnIndex !== undefined && (
              <span className="chat-turn">
                T{message.turnIndex}{message.totalTurns ? `/${message.totalTurns}` : ''}
              </span>
            )}
          </div>
        )}
        {message.reasoning && message.reasoning.length > 0 && (
          <details className="chat-reasoning">
            <summary>Reasoning</summary>
            <p>{message.reasoning}</p>
          </details>
        )}
        <div className="chat-bubble-text">
          {message.content || (message.toolCalls.length > 0 ? null : <span className="chat-empty">(empty)</span>)}
        </div>
        {message.toolCalls.length > 0 && (
          <div className="chat-tool-calls">
            {message.toolCalls.map(tc => (
              <ToolCard key={tc.callId} toolCall={tc} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function ChatMessages({ messages, debugMode, onDebugModeChange, children }: {
  messages: Message[];
  debugMode: boolean;
  onDebugModeChange: (mode: boolean) => void;
  children?: ReactNode;
}) {
  return (
    <>
      <div className="detail-filter-bar">
        <span className="detail-filter-label">
          {messages.filter(m => m.role !== 'separator').length} messages
        </span>
        <label className="debug-toggle" title="Show raw agent events (tool_call_state.*, model.turn.started, etc.)">
          <input
            type="checkbox"
            checked={debugMode}
            onChange={e => onDebugModeChange(e.target.checked)}
          />
          <span>debug events</span>
        </label>
      </div>

      {debugMode ? (
        <div className="stream-list">{children}</div>
      ) : (
        <div className="stream-list">
          {messages.length === 0 ? (
            <EmptyText text="No messages yet." />
          ) : (
            messages.map(msg => (
              <MessageBubble key={msg.id} message={msg} />
            ))
          )}
        </div>
      )}
    </>
  );
}
