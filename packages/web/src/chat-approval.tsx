/**
 * Tool approval notification cards and interactive operator steering.
 * - ApprovalCard: shows tool.approved / tool.denied outcomes
 * - OperatorSteeringBar: posts approve/deny/escalate via operator-events
 */
import { useState } from 'react';
import { Wrench, Check, X, AlertTriangle, Clock, ArrowUpRight } from 'lucide-react';
import { postOperatorSteering } from './api/index.js';

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

export function ApprovalCard({
  event,
  sessionId,
  onSteered,
}: {
  event: ApprovalEvent;
  sessionId?: string | null;
  onSteered?: (instruction: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function steer(instruction: 'approve' | 'deny' | 'escalate') {
    if (!sessionId || busy) return;
    setBusy(true);
    setError(null);
    try {
      await postOperatorSteering(sessionId, {
        instruction,
        reason: `web ApprovalCard ${instruction} for ${event.toolName}`,
        turnBoundary: 'immediate',
      });
      onSteered?.(instruction);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

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
      {sessionId ? (
        <div className="approval-actions" style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
          <button type="button" className="tiny-btn" disabled={busy} onClick={() => void steer('approve')}>
            <Check size={12} /> Approve
          </button>
          <button type="button" className="tiny-btn" disabled={busy} onClick={() => void steer('deny')}>
            <X size={12} /> Deny
          </button>
          <button type="button" className="tiny-btn" disabled={busy} onClick={() => void steer('escalate')}>
            <ArrowUpRight size={12} /> Escalate
          </button>
        </div>
      ) : null}
      {error ? <div className="error-banner" style={{ marginTop: 6 }}>{error}</div> : null}
    </div>
  );
}

/** Always-visible session steering when a chat session is active. */
export function OperatorSteeringBar({
  sessionId,
  disabled,
}: {
  sessionId: string;
  disabled?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function steer(instruction: 'approve' | 'deny' | 'escalate') {
    if (disabled || busy) return;
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      await postOperatorSteering(sessionId, {
        instruction,
        reason: `web OperatorSteeringBar ${instruction}`,
        turnBoundary: 'immediate',
      });
      setStatus(`sent ${instruction}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="operator-steering-bar" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', padding: '6px 0' }}>
      <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>Operator:</span>
      <button type="button" className="tiny-btn" disabled={disabled || busy} onClick={() => void steer('approve')}>
        <Check size={12} /> Approve
      </button>
      <button type="button" className="tiny-btn" disabled={disabled || busy} onClick={() => void steer('deny')}>
        <X size={12} /> Deny
      </button>
      <button type="button" className="tiny-btn" disabled={disabled || busy} onClick={() => void steer('escalate')}>
        <ArrowUpRight size={12} /> Escalate
      </button>
      {status ? <span style={{ fontSize: 12, color: 'var(--ok, green)' }}>{status}</span> : null}
      {error ? <span style={{ fontSize: 12, color: 'var(--danger, red)' }}>{error}</span> : null}
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
