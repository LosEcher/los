/**
 * Tool approval outcomes + operator steering.
 * Status is shown inline on tool chips in the timeline; this module provides
 * compact footer summary and the sticky OperatorSteeringBar (HITL option card).
 */
import { useMemo, useState } from 'react';
import { Check, X, AlertTriangle, Clock, ChevronDown } from 'lucide-react';
import { postOperatorSteering } from './api/index.js';
import { HitlQuestionCard } from './chat-ai-primitives.js';
import { useI18n } from './i18n';

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

/** Compact status-only row (debug / expanded summary). No top-of-page stacking. */
export function ApprovalCard({ event }: { event: ApprovalEvent }) {
  const { t } = useI18n();
  return (
    <div className={`approval-card ${event.allowed ? 'approved' : 'denied'}`}>
      <div className="approval-card-head">
        {event.allowed ? <Check size={13} /> : <X size={13} />}
        <strong>{event.toolName}</strong>
        <span className="approval-verdict">
          {event.allowed ? t('chat.approval.approved') : t('chat.approval.denied')}
        </span>
        {event.capability ? <span className="approval-cap">{event.capability}</span> : null}
      </div>
      {event.reason ? <p className="approval-reason">{event.reason}</p> : null}
    </div>
  );
}

/** Footer chip: how many tools gated this run, expand for list. */
export function ApprovalSummary({ events }: { events: ApprovalEvent[] }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const { approved, denied } = useMemo(() => {
    let approvedCount = 0;
    let deniedCount = 0;
    for (const event of events) {
      if (event.allowed) approvedCount += 1;
      else deniedCount += 1;
    }
    return { approved: approvedCount, denied: deniedCount };
  }, [events]);

  if (events.length === 0) return null;

  return (
    <div className="approval-summary">
      <button
        type="button"
        className="approval-summary-toggle"
        onClick={() => setOpen(value => !value)}
        aria-expanded={open}
      >
        <ChevronDown size={14} className={open ? 'is-open' : undefined} />
        <span>
          {approved > 0 ? t('chat.approval.summaryApproved', { count: approved }) : null}
          {approved > 0 && denied > 0 ? ' · ' : null}
          {denied > 0 ? t('chat.approval.summaryDenied', { count: denied }) : null}
        </span>
      </button>
      {open ? (
        <div className="approval-summary-list">
          {events.map(event => <ApprovalCard key={event.id} event={event} />)}
        </div>
      ) : null}
    </div>
  );
}

/** Sticky session steering — sits under the timeline, above the composer. */
export function WorkerAskCard({
  question,
  options,
  busy,
  onAnswer,
}: {
  question: string;
  options: string[];
  busy?: boolean;
  onAnswer: (answer: string) => void;
}) {
  const { t } = useI18n();
  const optionList = options.length > 0
    ? options.map(option => ({
        id: option,
        label: option,
        tone: 'primary' as const,
      }))
    : [
        { id: 'yes', label: t('chat.ai.yes'), tone: 'primary' as const },
        { id: 'no', label: t('chat.ai.no'), tone: 'danger' as const },
      ];
  return (
    <HitlQuestionCard
      title={t('chat.ai.workerAskTitle')}
      body={question}
      busy={busy}
      options={optionList}
      onSelect={onAnswer}
    />
  );
}

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
  const { t } = useI18n();

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
      setStatus(t('chat.sentInstruction', { instruction }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="operator-steering-bar">
      <HitlQuestionCard
        title={t('chat.operator')}
        body={t('chat.ai.hitlSteerBody')}
        busy={disabled || busy}
        options={[
          { id: 'approve', label: t('chat.approve'), tone: 'primary', description: t('chat.ai.hitlApproveHint') },
          { id: 'deny', label: t('chat.deny'), tone: 'danger', description: t('chat.ai.hitlDenyHint') },
          { id: 'escalate', label: t('chat.escalate'), tone: 'neutral', description: t('chat.ai.hitlEscalateHint') },
        ]}
        onSelect={(id) => {
          if (id === 'approve' || id === 'deny' || id === 'escalate') void steer(id);
        }}
        footer={(
          <>
            {status ? <span className="operator-steering-ok">{status}</span> : null}
            {error ? <span className="operator-steering-err">{error}</span> : null}
          </>
        )}
      />
    </div>
  );
}

export function AbortConfirmation({ onConfirm, onCancel, elapsedMs }: {
  onConfirm: () => void;
  onCancel: () => void;
  elapsedMs?: number;
}) {
  const { t } = useI18n();
  return (
    <div className="abort-confirm-overlay">
      <div className="abort-confirm-card">
        <AlertTriangle size={18} />
        <h3>{t('chat.abort.title')}</h3>
        <p>{t('chat.abort.body')}</p>
        {elapsedMs ? (
          <p className="abort-elapsed">
            <Clock size={12} /> {t('chat.abort.ranFor', { elapsed: formatElapsed(elapsedMs) })}
          </p>
        ) : null}
        <div className="abort-actions">
          <button className="primary-btn danger" type="button" onClick={onConfirm}>
            {t('chat.abort.cancelRun')}
          </button>
          <button className="ghost-btn" type="button" onClick={onCancel}>
            {t('chat.abort.keepRunning')}
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
  const { t } = useI18n();
  const fillPercent = typeof data.fillPercent === 'number' ? data.fillPercent : null;
  const usedTokens = typeof data.usedTokens === 'number' ? data.usedTokens : null;
  const contextWindowTokens = typeof data.contextWindowTokens === 'number' ? data.contextWindowTokens : null;

  const level = event.includes('critical') ? 'critical'
    : event.includes('warn') ? 'warn'
    : 'info';

  const detail = fillPercent !== null
    ? t('chat.ctx.full', { percent: fillPercent })
    : t('chat.ctx.compressed');
  const tokens = usedTokens !== null && contextWindowTokens !== null
    ? ` ${t('chat.ctx.tokens', { used: usedTokens.toLocaleString(), total: contextWindowTokens.toLocaleString() })}`
    : '';

  return (
    <div className={`context-notification level-${level}`}>
      <span className="context-notify-icon">
        {level === 'critical' ? '⚠' : level === 'warn' ? '⚡' : 'ℹ'}
      </span>
      <span className="context-notify-text">
        {t('chat.ctx.summary', { detail: detail + tokens })}
      </span>
    </div>
  );
}

export function CancelledBanner() {
  const { t } = useI18n();
  return (
    <div className="cancelled-banner">
      <X size={14} /> {t('chat.cancelledBanner')}
    </div>
  );
}
