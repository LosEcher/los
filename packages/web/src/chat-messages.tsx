/**
 * Chat message types, accumulation logic, and bubble rendering components.
 * Timeline order: older above, newer below (append-only). Tools live inside
 * assistant turns — not in a top-of-page approval dump.
 *
 * AI-native presentation (tool chips, thinking, task rows) lives in
 * chat-ai-primitives.tsx (Beautiful UI patterns + LOS tokens).
 */
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { MarkdownBlock } from './markdown-renderer.js';
import { ChatVirtualScroller } from './chat-virtual-scroller.js';
import type { ApprovalEvent } from './chat-approval.js';
import {
  StreamingElapsed,
  TaskRowList,
  ThinkingBlock,
  ToolChipList,
  toolCallsToTaskRows,
} from './chat-ai-primitives.js';
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

/** @deprecated Use ToolChip from chat-ai-primitives — kept as alias for imports. */
export { ToolChip as ToolCard } from './chat-ai-primitives.js';

export function MessageBubble({
  message,
  isStreaming,
  approvalByCallId,
  streamStartedAt,
}: {
  message: Message;
  isStreaming?: boolean;
  approvalByCallId?: Map<string, ApprovalEvent>;
  streamStartedAt?: number;
}) {
  const { t } = useI18n();
  const taskRows = useMemo(
    () => toolCallsToTaskRows(message.toolCalls),
    [message.toolCalls],
  );

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
        {message.reasoning && message.reasoning.length > 0 ? (
          <ThinkingBlock text={message.reasoning} streaming={isStreaming} />
        ) : null}
        {/* Compact tool chips first; task rows mirror status for at-a-glance progress. */}
        {message.toolCalls.length > 0 ? (
          <div className="chat-tool-calls">
            <ToolChipList toolCalls={message.toolCalls} approvalByCallId={approvalByCallId} />
            <TaskRowList rows={taskRows} title={t('chat.ai.tasks')} />
          </div>
        ) : null}
        <div className="chat-bubble-text">
          {message.content
            ? <MarkdownBlock content={message.content} />
            : (message.toolCalls.length > 0 ? null : <span className="chat-empty">{t('chat.empty')}</span>)}
        </div>
        {isStreaming ? (
          <StreamingElapsed active={Boolean(isStreaming)} startedAt={streamStartedAt} />
        ) : null}
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
  const [streamStartedAt, setStreamStartedAt] = useState<number | undefined>(undefined);
  useEffect(() => {
    if (running) {
      setStreamStartedAt(prev => prev ?? Date.now());
    } else {
      setStreamStartedAt(undefined);
    }
  }, [running]);

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
                  streamStartedAt={streamStartedAt}
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
