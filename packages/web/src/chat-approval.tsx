/**
 * Tool approval notification cards and operator approval UI shell.
 * Renders non-interactive info cards for tool.approved / tool.denied events.
 * When backend approval-gating lands, the interactive modal activates automatically.
 */
import { Wrench, Check, X, AlertTriangle, Clock } from 'lucide-react';

export type ApprovalEvent = {
  id: string;
  callId: string;
  toolName: string;
  argsPreview?: string;
  allowed: boolean;
  reason?: string;
  reasonCode?: string;
  capability?: string;
  createdAt: number;
};

export function ApprovalCard({ event }: { event: ApprovalEvent }) {
  return (
    <div className={`approval-card ${event.allowed ? 'approved' : 'denied'}`}>
      <div className="approval-card-head">
        {event.allowed ? <Check size={13} /> : <X size={13} />}
        <Wrench size={12} />
        <strong>{event.toolName}</strong>
        <span className="approval-verdict">
          {event.allowed ? 'approved' : 'denied'}
        </span>
        {event.capability ? <span className="approval-cap">{event.capability}</span> : null}
      </div>
      {event.reason ? <p className="approval-reason">{event.reason}</p> : null}
      {event.argsPreview ? (
        <details className="approval-args">
          <summary>args</summary>
          <code>{event.argsPreview}</code>
        </details>
      ) : null}
    </div>
  );
}

export function AbortConfirmation({ onConfirm, onCancel, elapsedMs }: {
  onConfirm: () => void;
  onCancel: () => void;
  elapsedMs?: number;
}) {
  return (
    <div className="abort-confirm-overlay">
      <div className="abort-confirm-card">
        <AlertTriangle size={18} />
        <h3>Cancel this run?</h3>
        <p>Any in-progress tool calls will be interrupted. This cannot be undone.</p>
        {elapsedMs ? (
          <p className="abort-elapsed">
            <Clock size={12} /> Ran for {formatElapsed(elapsedMs)}
          </p>
        ) : null}
        <div className="abort-actions">
          <button className="primary-btn danger" type="button" onClick={onConfirm}>
            Cancel run
          </button>
          <button className="ghost-btn" type="button" onClick={onCancel}>
            Keep running
          </button>
        </div>
      </div>
    </div>
  );
}

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function ContextNotification({ event, data }: {
  event: string;
  data: Record<string, unknown>;
}) {
  const fillPercent = typeof data.fillPercent === 'number' ? data.fillPercent : null;
  const usedTokens = typeof data.usedTokens === 'number' ? data.usedTokens : null;
  const contextWindowTokens = typeof data.contextWindowTokens === 'number' ? data.contextWindowTokens : null;

  const level = event.includes('critical') ? 'critical'
    : event.includes('warn') ? 'warn'
    : 'info';

  return (
    <div className={`context-notification level-${level}`}>
      <span className="context-notify-icon">
        {level === 'critical' ? '⚠' : level === 'warn' ? '⚡' : 'ℹ'}
      </span>
      <span className="context-notify-text">
        Context window: {fillPercent !== null ? `${fillPercent}% full` : 'compressed'}
        {usedTokens !== null && contextWindowTokens !== null
          ? ` (${usedTokens.toLocaleString()} / ${contextWindowTokens.toLocaleString()} tokens)`
          : null}
      </span>
    </div>
  );
}

export function CancelledBanner() {
  return (
    <div className="cancelled-banner">
      <X size={14} /> Run cancelled by operator
    </div>
  );
}
