import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  AlertTriangle,
  CheckCheck,
  ChevronRight,
  CircleDot,
  RefreshCcw,
  ShieldAlert,
} from 'lucide-react';

import { getJson, type InboxEntry, type InboxResponse, type WorkItemAttentionState } from '../api/index.js';
import { formatDate } from '../ui.js';

type InboxFilter = 'all' | 'decision' | 'recovery' | 'review' | 'running';

export function InboxPage({
  onOpenWork,
  onOpenRun,
  onOpenSession,
}: {
  onOpenWork: (id: string) => void;
  onOpenRun: (id: string) => void;
  onOpenSession: (id: string) => void;
}) {
  const [filter, setFilter] = useState<InboxFilter>('all');
  const inbox = useQuery({
    queryKey: ['inbox'],
    queryFn: () => getJson<InboxResponse>('/inbox?limit=100'),
    refetchInterval: 10_000,
  });
  const entries = inbox.data?.results ?? [];
  const visible = useMemo(() => entries.filter(entry => matchesFilter(entry, filter)), [entries, filter]);

  return (
    <section className="daily-page inbox-page">
      <div className="daily-toolbar">
        <div className="attention-summary" aria-label="Inbox summary">
          <SummaryCount label="decisions" value={count(entries, ['approval_required', 'verification_blocked'])} tone="warn" />
          <SummaryCount label="recovery" value={count(entries, ['recovery_required'])} tone="danger" />
          <SummaryCount label="review" value={count(entries, ['review_ready'])} tone="ok" />
          <SummaryCount label="running" value={count(entries, ['running'])} tone="info" />
        </div>
        <button className="icon-btn" type="button" title="Refresh inbox" aria-label="Refresh inbox" onClick={() => inbox.refetch()} disabled={inbox.isFetching}>
          <RefreshCcw size={15} className={inbox.isFetching ? 'spin' : ''} />
        </button>
      </div>

      <div className="daily-split">
        <nav className="attention-filters" aria-label="Inbox filters">
          {(['all', 'decision', 'recovery', 'review', 'running'] as const).map(value => (
            <button key={value} type="button" data-active={filter === value} onClick={() => setFilter(value)}>
              <span>{value}</span>
              <strong>{filterCount(entries, value)}</strong>
            </button>
          ))}
        </nav>

        <div className="attention-feed" aria-live="polite">
          {inbox.isLoading ? <InboxSkeleton /> : null}
          {inbox.error ? <div className="daily-error">Inbox unavailable: {String(inbox.error)}</div> : null}
          {!inbox.isLoading && !inbox.error && visible.length === 0 ? (
            <div className="daily-empty">
              <CheckCheck size={22} />
              <strong>No action required</strong>
              <span>{filter === 'all' ? 'Runs with no operator action stay out of this view.' : `No ${filter} items are waiting.`}</span>
            </div>
          ) : null}
          {visible.map(entry => (
            <InboxRow
              key={entry.id}
              entry={entry}
              onAction={() => openEntry(entry, { onOpenWork, onOpenRun, onOpenSession })}
            />
          ))}
        </div>
      </div>
    </section>
  );
}

function InboxRow({ entry, onAction }: { entry: InboxEntry; onAction: () => void }) {
  const Icon = attentionIcon(entry.attentionState);
  return (
    <article className="attention-row" data-attention={entry.attentionState}>
      <div className="attention-icon"><Icon size={16} /></div>
      <div className="attention-copy">
        <div className="attention-title-line">
          <strong>{entry.title}</strong>
          <span className="attention-state">{stateLabel(entry.attentionState)}</span>
        </div>
        <div className="attention-meta">
          <span>{entry.projectId}</span>
          <span>{entry.source ?? entry.sourceKind.replaceAll('_', ' ')}</span>
          {entry.connector ? <span>{entry.connector.dispatchStatus} · result {entry.connector.resultAvailable ? 'ready' : 'pending'} · callback {entry.connector.callbackStatus.replaceAll('_', ' ')}</span> : null}
          <time dateTime={entry.updatedAt}>{formatDate(entry.updatedAt)}</time>
          {entry.runSpecId ? <code>{entry.runSpecId.slice(0, 12)}</code> : null}
        </div>
      </div>
      <button className="attention-action" type="button" onClick={onAction}>
        {actionLabel(entry)} <ChevronRight size={14} />
      </button>
    </article>
  );
}

function SummaryCount({ label, value, tone }: { label: string; value: number; tone: string }) {
  return <div className={`summary-count ${tone}`}><span>{label}</span><strong>{value}</strong></div>;
}

function InboxSkeleton() {
  return <div className="daily-skeleton" aria-label="Loading inbox"><i /><i /><i /></div>;
}

function count(entries: InboxEntry[], states: WorkItemAttentionState[]): number {
  return entries.filter(entry => states.includes(entry.attentionState)).length;
}

function filterCount(entries: InboxEntry[], filter: InboxFilter): number {
  return entries.filter(entry => matchesFilter(entry, filter)).length;
}

function matchesFilter(entry: InboxEntry, filter: InboxFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'decision') return entry.attentionState === 'approval_required' || entry.attentionState === 'verification_blocked';
  if (filter === 'recovery') return entry.attentionState === 'recovery_required';
  if (filter === 'review') return entry.attentionState === 'review_ready';
  return entry.attentionState === 'running';
}

function openEntry(entry: InboxEntry, handlers: {
  onOpenWork: (id: string) => void;
  onOpenRun: (id: string) => void;
  onOpenSession: (id: string) => void;
}): void {
  if (entry.workItemId) return handlers.onOpenWork(entry.workItemId);
  if (entry.runSpecId) return handlers.onOpenRun(entry.runSpecId);
  if (entry.sessionId) handlers.onOpenSession(entry.sessionId);
}

function attentionIcon(state: WorkItemAttentionState) {
  if (state === 'recovery_required') return AlertTriangle;
  if (state === 'verification_blocked') return ShieldAlert;
  if (state === 'review_ready') return CheckCheck;
  return CircleDot;
}

function stateLabel(state: WorkItemAttentionState): string {
  return state.replaceAll('_', ' ');
}

function actionLabel(entry: InboxEntry): string {
  const labels: Record<string, string> = {
    review_plan: 'Review plan',
    inspect_verification: 'Inspect checks',
    recover: 'Inspect recovery',
    inspect_run: 'Inspect run',
    review_changes: 'Review result',
  };
  return labels[entry.nextAction] ?? 'Inspect';
}
