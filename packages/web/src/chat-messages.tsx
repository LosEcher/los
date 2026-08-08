/**
 * Chat message types, accumulation logic, and bubble rendering components.
 * Timeline order: older above, newer below (append-only). Tools live inside
 * assistant turns — not in a top-of-page approval dump.
 */
import { type ReactNode } from 'react';
import { Wrench } from 'lucide-react';
import { MarkdownBlock } from './markdown-renderer.js';
import { ChatVirtualScroller } from './chat-virtual-scroller.js';
import type { ApprovalEvent } from './chat-approval.js';
import { tt, useI18n } from './i18n';

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
    content: tt('chat.historyDivider', { count: result.length }),
    level: 'ok',
    meta: tt('chat.historyTurns', { count: turnIdx }),
    toolCalls: [],
  });

  return result;
}

export function readyMessages(): Message[] {
  return [{
    id: crypto.randomUUID(),
    role: 'system',
    content: tt('chat.readyPrompt'),
    meta: tt('chat.readyMeta'),
    toolCalls: [],
  }];
}

// ── Components ───────────────────────────────────────

export function ToolCard({
  toolCall,
  approval,
}: {
  toolCall: ToolCall;
  approval?: ApprovalEvent;
}) {
  const { t } = useI18n();
  const gate = approval
    ? (approval.allowed ? 'approved' as const : 'denied' as const)
    : toolCall.status === 'denied'
      ? 'denied' as const
      : null;
  return (
    <details className="tool-card" data-status={toolCall.status} data-gate={gate ?? undefined}>
      <summary className="tool-card-head">
        <Wrench size={12} />
        <strong>{toolCall.toolName}</strong>
        {toolCall.status === 'running' && <span className="tool-status running">{t('chat.tool.running')}</span>}
        {toolCall.status === 'completed' && <span className="tool-status completed">{t('chat.tool.done')}</span>}
        {toolCall.status === 'error' && <span className="tool-status error">{t('chat.tool.error')}</span>}
        {toolCall.status === 'denied' && <span className="tool-status error">{t('chat.tool.denied')}</span>}
        {gate === 'approved' && <span className="tool-gate approved">{t('chat.approval.approved')}</span>}
        {gate === 'denied' && toolCall.status !== 'denied' && (
          <span className="tool-gate denied">{t('chat.approval.denied')}</span>
        )}
        {toolCall.durationMs !== undefined && (
          <span className="tool-duration">{formatToolDuration(toolCall.durationMs)}</span>
        )}
      </summary>
      <div className="tool-card-body">
        {toolCall.argsPreview && (
          <div className="tool-args">
            <span className="tool-label">{t('chat.tool.args')}</span>
            <code>{toolCall.argsPreview}</code>
          </div>
        )}
        {toolCall.resultPreview && (
          <div className="tool-result">
            <span className="tool-label">{t('chat.tool.result')}</span>
            <code>{toolCall.resultPreview}</code>
          </div>
        )}
        {toolCall.errorPreview && (
          <div className="tool-result">
            <span className="tool-label">{t('chat.tool.error')}</span>
            <code>{toolCall.errorPreview}</code>
          </div>
        )}
        {approval?.reason ? (
          <div className="tool-result">
            <span className="tool-label">{t('chat.approval.gate')}</span>
            <code>{approval.reason}</code>
          </div>
        ) : null}
      </div>
    </details>
  );
}

function formatToolDuration(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${ms}ms`;
}

export function MessageBubble({
  message,
  isStreaming,
  approvalByCallId,
}: {
  message: Message;
  isStreaming?: boolean;
  approvalByCallId?: Map<string, ApprovalEvent>;
}) {
  const { t } = useI18n();
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
    <div className={`chat-message ${message.role}${isStreaming ? ' streaming' : ''}`}>
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
            <summary>{t('chat.reasoning')}</summary>
            <p>{message.reasoning}</p>
          </details>
        )}
        {/* Tools first (agent loop), then final text — chronological within the turn. */}
        {message.toolCalls.length > 0 && (
          <div className="chat-tool-calls">
            {message.toolCalls.map(tc => (
              <ToolCard
                key={tc.callId}
                toolCall={tc}
                approval={approvalByCallId?.get(tc.callId)}
              />
            ))}
          </div>
        )}
        <div className="chat-bubble-text">
          {message.content
            ? <MarkdownBlock content={message.content} />
            : (message.toolCalls.length > 0 ? null : <span className="chat-empty">{t('chat.empty')}</span>)}
        </div>
      </div>
    </div>
  );
}

export function ChatMessages({
  messages,
  debugMode,
  onDebugModeChange,
  footer,
  children,
  running,
  approvalEvents,
}: {
  messages: Message[];
  debugMode: boolean;
  onDebugModeChange: (mode: boolean) => void;
  /** Sticky actions below the scroll (steering, plan, banners) — not a top dump. */
  footer?: ReactNode;
  children?: ReactNode;
  running?: boolean;
  approvalEvents?: ApprovalEvent[];
}) {
  const { t } = useI18n();
  const approvalByCallId = new Map<string, ApprovalEvent>();
  for (const event of approvalEvents ?? []) {
    if (event.callId) approvalByCallId.set(event.callId, event);
  }

  return (
    <div className="chat-timeline">
      <div className="chat-timeline-toolbar detail-filter-bar">
        <span className="detail-filter-label">
          {t('chat.messageCount', { count: messages.filter(m => m.role !== 'separator').length })}
        </span>
        <label className="debug-toggle" title={t('chat.debugTitle')}>
          <input
            type="checkbox"
            checked={debugMode}
            onChange={e => onDebugModeChange(e.target.checked)}
          />
          <span>{t('chat.debugEvents')}</span>
        </label>
      </div>

      <div className="chat-timeline-scroll">
        {debugMode ? (
          <div className="stream-list">{children}</div>
        ) : (
          <ChatVirtualScroller messages={messages} running={Boolean(running)} debugMode={debugMode}>
            {index => {
              const msg = messages[index];
              if (!msg) return null;
              const isLastAssistant = msg.role === 'assistant'
                && !messages.slice(index + 1).some(m => m.role === 'assistant');
              return (
                <MessageBubble
                  key={msg.id}
                  message={msg}
                  isStreaming={Boolean(running) && isLastAssistant}
                  approvalByCallId={approvalByCallId}
                />
              );
            }}
          </ChatVirtualScroller>
        )}
      </div>

      {footer ? <div className="chat-timeline-footer">{footer}</div> : null}
    </div>
  );
}
