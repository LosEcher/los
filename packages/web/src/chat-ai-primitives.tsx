/**
 * AI-native UI primitives for Chat/Work (Beautiful UI patterns, LOS tokens).
 * Thinking, tool chips, task rows, HITL option cards, streaming elapsed.
 */
import { useEffect, useState, type ReactNode } from 'react';
import {
  Wrench,
  Check,
  X,
  Loader2,
  Circle,
  AlertTriangle,
  Brain,
  ChevronRight,
} from 'lucide-react';
import type { ApprovalEvent } from './chat-approval.js';
import type { ToolCall, ToolCallStatus } from './chat-messages.js';
import { useI18n } from './i18n';

// ── Pure helpers (unit-tested) ───────────────────────────────────────────

export function formatToolChipPreview(
  toolName: string,
  argsPreview: string,
  args?: Record<string, unknown>,
): string {
  if (args) {
    const pathLike = firstString(args, [
      'path', 'file_path', 'filePath', 'target_file', 'target', 'command', 'pattern', 'query',
    ]);
    if (pathLike) return truncateOneLine(pathLike, 64);
  }
  const raw = argsPreview.trim();
  if (!raw) return toolName;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed && typeof parsed === 'object') {
      const pathLike = firstString(parsed, [
        'path', 'file_path', 'filePath', 'target_file', 'target', 'command', 'pattern', 'query',
      ]);
      if (pathLike) return truncateOneLine(pathLike, 64);
    }
  } catch {
    // plain text preview
  }
  return truncateOneLine(raw.replace(/\s+/g, ' '), 64);
}

export function toolCallsToTaskRows(toolCalls: ToolCall[]): TaskRowModel[] {
  return toolCalls.map(tc => ({
    id: tc.callId,
    label: tc.toolName,
    detail: formatToolChipPreview(tc.toolName, tc.argsPreview, tc.args),
    status: mapToolStatusToTask(tc.status),
    durationMs: tc.durationMs,
  }));
}

export type TaskRowStatus = 'pending' | 'running' | 'completed' | 'failed' | 'blocked';

export type TaskRowModel = {
  id: string;
  label: string;
  detail?: string;
  status: TaskRowStatus;
  durationMs?: number;
};

function mapToolStatusToTask(status: ToolCallStatus): TaskRowStatus {
  if (status === 'running') return 'running';
  if (status === 'completed') return 'completed';
  if (status === 'error' || status === 'denied') return 'failed';
  return 'pending';
}

function firstString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function truncateOneLine(text: string, max: number): string {
  const one = text.replace(/\s+/g, ' ').trim();
  if (one.length <= max) return one;
  return `${one.slice(0, max - 1)}…`;
}

export function formatElapsedMs(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

// ── Hooks ────────────────────────────────────────────────────────────────

export function useElapsedMs(active: boolean, startedAt?: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [active]);
  if (!active || !startedAt) return 0;
  return Math.max(0, now - startedAt);
}

// ── Thinking ─────────────────────────────────────────────────────────────

export function ThinkingBlock({
  text,
  streaming,
  defaultOpen,
}: {
  text: string;
  streaming?: boolean;
  defaultOpen?: boolean;
}) {
  const { t } = useI18n();
  if (!text) return null;
  const open = defaultOpen ?? Boolean(streaming);
  return (
    <details className="ai-thinking" open={open || undefined}>
      <summary className="ai-thinking-summary">
        <Brain size={12} aria-hidden="true" />
        <span>{t('chat.reasoning')}</span>
        {streaming ? (
          <span className="ai-thinking-live">{t('chat.ai.thinkingLive')}</span>
        ) : null}
      </summary>
      <div className="ai-thinking-body">
        <pre className="ai-thinking-text">{text}</pre>
      </div>
    </details>
  );
}

// ── Tool chip (compact default) ──────────────────────────────────────────

export function ToolChip({
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
  const preview = formatToolChipPreview(toolCall.toolName, toolCall.argsPreview, toolCall.args);

  return (
    <details
      className="tool-chip"
      data-status={toolCall.status}
      data-gate={gate ?? undefined}
    >
      <summary className="tool-chip-summary">
        <span className="tool-chip-icon" aria-hidden="true">
          {toolCall.status === 'running' ? <Loader2 size={12} className="spin" /> : <Wrench size={12} />}
        </span>
        <strong className="tool-chip-name">{toolCall.toolName}</strong>
        <span className="tool-chip-preview" title={preview}>{preview}</span>
        {toolCall.status === 'running' && (
          <span className="tool-status running">{t('chat.tool.running')}</span>
        )}
        {toolCall.status === 'completed' && (
          <span className="tool-status completed">{t('chat.tool.done')}</span>
        )}
        {toolCall.status === 'error' && (
          <span className="tool-status error">{t('chat.tool.error')}</span>
        )}
        {toolCall.status === 'denied' && (
          <span className="tool-status error">{t('chat.tool.denied')}</span>
        )}
        {gate === 'approved' && (
          <span className="tool-gate approved">{t('chat.approval.approved')}</span>
        )}
        {gate === 'denied' && toolCall.status !== 'denied' && (
          <span className="tool-gate denied">{t('chat.approval.denied')}</span>
        )}
        {toolCall.durationMs !== undefined && (
          <span className="tool-duration">{formatElapsedMs(toolCall.durationMs)}</span>
        )}
        <ChevronRight size={12} className="tool-chip-chevron" aria-hidden="true" />
      </summary>
      <div className="tool-chip-body">
        {toolCall.argsPreview ? (
          <div className="tool-args">
            <span className="tool-label">{t('chat.tool.args')}</span>
            <code>{toolCall.argsPreview}</code>
          </div>
        ) : null}
        {toolCall.resultPreview ? (
          <div className="tool-result">
            <span className="tool-label">{t('chat.tool.result')}</span>
            <code>{toolCall.resultPreview}</code>
          </div>
        ) : null}
        {toolCall.errorPreview ? (
          <div className="tool-result">
            <span className="tool-label">{t('chat.tool.error')}</span>
            <code>{toolCall.errorPreview}</code>
          </div>
        ) : null}
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

export function ToolChipList({
  toolCalls,
  approvalByCallId,
}: {
  toolCalls: ToolCall[];
  approvalByCallId?: Map<string, ApprovalEvent>;
}) {
  if (toolCalls.length === 0) return null;
  return (
    <div className="tool-chip-list" role="list" aria-label="tool calls">
      {toolCalls.map(tc => (
        <ToolChip
          key={tc.callId}
          toolCall={tc}
          approval={approvalByCallId?.get(tc.callId)}
        />
      ))}
    </div>
  );
}

// ── Task rows ────────────────────────────────────────────────────────────

function TaskStatusIcon({ status }: { status: TaskRowStatus }) {
  if (status === 'running') return <Loader2 size={12} className="spin" />;
  if (status === 'completed') return <Check size={12} />;
  if (status === 'failed') return <X size={12} />;
  if (status === 'blocked') return <AlertTriangle size={12} />;
  return <Circle size={10} />;
}

export function TaskRow({ row }: { row: TaskRowModel }) {
  const { t } = useI18n();
  const statusLabel =
    row.status === 'running' ? t('chat.tool.running')
      : row.status === 'completed' ? t('chat.tool.done')
        : row.status === 'failed' ? t('chat.tool.error')
          : row.status === 'blocked' ? t('chat.ai.taskBlocked')
            : t('chat.ai.taskPending');

  return (
    <div className="task-row" data-status={row.status} role="listitem">
      <span className="task-row-icon" data-status={row.status} aria-hidden="true">
        <TaskStatusIcon status={row.status} />
      </span>
      <div className="task-row-main">
        <strong className="task-row-label">{row.label}</strong>
        {row.detail ? <span className="task-row-detail">{row.detail}</span> : null}
      </div>
      <span className="task-row-status">{statusLabel}</span>
      {row.durationMs !== undefined ? (
        <span className="task-row-duration">{formatElapsedMs(row.durationMs)}</span>
      ) : null}
    </div>
  );
}

export function TaskRowList({
  rows,
  title,
}: {
  rows: TaskRowModel[];
  title?: string;
}) {
  const { t } = useI18n();
  if (rows.length === 0) return null;
  return (
    <div className="task-row-list" role="list" aria-label={title ?? t('chat.ai.tasks')}>
      {title ? <div className="task-row-list-title">{title}</div> : null}
      {rows.map(row => <TaskRow key={row.id} row={row} />)}
    </div>
  );
}

// ── Streaming elapsed ────────────────────────────────────────────────────

export function StreamingElapsed({ active, startedAt }: { active: boolean; startedAt?: number }) {
  const { t } = useI18n();
  const elapsed = useElapsedMs(active, startedAt);
  if (!active) return null;
  return (
    <div className="ai-stream-elapsed" aria-live="polite">
      <Loader2 size={12} className="spin" aria-hidden="true" />
      <span>{t('chat.ai.streaming')}</span>
      {startedAt ? <span className="ai-stream-elapsed-time">{formatElapsedMs(elapsed)}</span> : null}
    </div>
  );
}

// ── HITL typed options (Beautiful UI Approval Card) ──────────────────────

export type HitlOption = {
  id: string;
  label: string;
  tone?: 'primary' | 'danger' | 'neutral';
  description?: string;
};

export function HitlQuestionCard({
  title,
  body,
  options,
  busy,
  onSelect,
  footer,
}: {
  title: string;
  body?: string;
  options: HitlOption[];
  busy?: boolean;
  onSelect: (optionId: string) => void;
  footer?: ReactNode;
}) {
  return (
    <div className="hitl-card" role="group" aria-label={title}>
      <div className="hitl-card-head">
        <strong>{title}</strong>
      </div>
      {body ? <p className="hitl-card-body">{body}</p> : null}
      <div className="hitl-card-options">
        {options.map(option => (
          <button
            key={option.id}
            type="button"
            className={`hitl-option hitl-option-${option.tone ?? 'neutral'}`}
            disabled={busy}
            title={option.description}
            onClick={() => onSelect(option.id)}
          >
            {option.label}
          </button>
        ))}
      </div>
      {footer ? <div className="hitl-card-footer">{footer}</div> : null}
    </div>
  );
}
