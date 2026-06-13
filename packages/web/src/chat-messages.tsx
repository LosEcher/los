/**
 * Chat message types, accumulation logic, and bubble rendering components.
 * Refactored from the flat event-log pattern to message-bubble pattern.
 */
import { type ReactNode, useState } from 'react';
import { Wrench } from 'lucide-react';
import { EmptyText } from './ui.js';

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
  turnIndex?: number;
  totalTurns?: number;
  provider?: string;
  model?: string;
  toolCalls: ToolCall[];
  reasoning?: string;
  loopCount?: number;
  eventType?: string;
  level?: 'normal' | 'ok' | 'warn' | 'error';
  meta?: string;
};

// Re-export deprecated accumulator — retained for debug-mode raw event replay only
export { accumulateEvent } from './chat-accumulator.js';

// ── History ──────────────────────────────────────────

function truncateJson(raw: string, maxLen: number): string {
  return raw.length > maxLen ? raw.slice(0, maxLen) + '…' : raw;
}

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
