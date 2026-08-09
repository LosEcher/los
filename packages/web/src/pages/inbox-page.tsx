import { useMemo, useState, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  CheckCheck,
  ChevronRight,
  CircleDot,
  Play,
  Plus,
  RefreshCcw,
  Shield,
  ShieldAlert,
  Zap,
} from 'lucide-react';

import {
  getJson,
  postJson,
  type InboxEntry,
  type InboxResponse,
  type WorkItemAttentionState,
  type WorkItemNextAction,
  type WorkItemProjection,
} from '../api/index.js';
import { formatDate } from '../ui.js';
import { tt, useI18n } from '../i18n';

type GovernanceJobSummary = {
  id: string;
  jobType: string;
  status: string;
  circuitState: string;
  escalated: boolean;
  findingCount: number | null;
  autoFixEnabled: boolean;
  lastRunAt: string | null;
};

type GovernanceListResponse = {
  count: number;
  attentionCount: number;
  jobs: GovernanceJobSummary[];
};

function isGovernanceAttention(job: GovernanceJobSummary): boolean {
  return job.escalated
    || job.circuitState === 'open'
    || job.status === 'paused'
    || (job.findingCount ?? 0) > 0;
}

type InboxFilter = 'all' | 'decision' | 'recovery' | 'review' | 'running';

type InboxPrimaryKind = 'start' | 'open';

type InboxDecision = {
  need: string;
  why: string;
  effect: string;
  primaryKind: InboxPrimaryKind;
  primaryLabel: string;
};

export function InboxPage({
  onOpenWork,
  onOpenRun,
  onOpenSession,
  onApprovePlan: _onApprovePlan,
  onStartWork,
}: {
  onOpenWork: (id: string) => void;
  onOpenRun: (id: string) => void;
  onOpenSession: (id: string) => void;
  /** Kept for App wiring; plan approval happens on Work after review (W3 single-CTA). */
  onApprovePlan: (runSpecId: string) => void;
  onStartWork?: (item: WorkItemProjection) => void;
}) {
  const [filter, setFilter] = useState<InboxFilter>('all');
  const [quickGoal, setQuickGoal] = useState('');
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const inbox = useQuery({
    queryKey: ['inbox'],
    queryFn: () => getJson<InboxResponse>('/inbox?limit=100'),
    refetchInterval: 10_000,
  });
  const governance = useQuery({
    queryKey: ['governance-jobs', 'inbox'],
    queryFn: () => getJson<GovernanceListResponse>('/governance/jobs'),
    refetchInterval: 30_000,
  });
  const runGovJob = useMutation({
    mutationFn: (jobType: string) => postJson(`/governance/jobs/${jobType}/run`, {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['governance-jobs'] });
    },
  });
  const quickMutation = useMutation({
    mutationFn: (goal: string) => postJson<{ id: string }>('/work-items/quick', { goal }),
    onSuccess: async (data) => {
      setQuickGoal('');
      queryClient.invalidateQueries({ queryKey: ['inbox'] });
      queryClient.invalidateQueries({ queryKey: ['work-items'] });
      if (onStartWork) {
        try {
          const projection = await getJson<WorkItemProjection>(`/work-items/${data.id}`);
          onStartWork(projection);
        } catch {
          onOpenWork(data.id);
        }
      } else {
        onOpenWork(data.id);
      }
    },
  });
  const handleQuickSubmit = useCallback(() => {
    const trimmed = quickGoal.trim();
    if (!trimmed || quickMutation.isPending) return;
    quickMutation.mutate(trimmed);
  }, [quickGoal, quickMutation]);
  const entries = inbox.data?.results ?? [];
  const visible = useMemo(() => entries.filter(entry => matchesFilter(entry, filter)), [entries, filter]);
  const govAttention = useMemo(
    () => (governance.data?.jobs ?? []).filter(isGovernanceAttention).slice(0, 5),
    [governance.data?.jobs],
  );
  const govCount = governance.data?.attentionCount ?? govAttention.length;

  return (
    <section className="daily-page inbox-page">
      <div className="daily-toolbar">
        <div className="attention-summary" aria-label={t('work.inbox.summaryAria')}>
          <SummaryCount label={t('work.inbox.sum.decisions')} value={count(entries, ['approval_required', 'verification_blocked'])} tone="warn" />
          <SummaryCount label={t('work.inbox.sum.recovery')} value={count(entries, ['recovery_required'])} tone="danger" />
          <SummaryCount label={t('work.inbox.sum.review')} value={count(entries, ['review_ready'])} tone="ok" />
          <SummaryCount label={t('work.inbox.sum.running')} value={count(entries, ['running'])} tone="info" />
          <SummaryCount label={t('work.inbox.sum.governance')} value={govCount} tone={govCount > 0 ? 'warn' : 'info'} />
        </div>
        <button
          className="icon-btn"
          type="button"
          title={t('work.inbox.refresh')}
          aria-label={t('work.inbox.refresh')}
          onClick={() => { inbox.refetch(); governance.refetch(); }}
          disabled={inbox.isFetching || governance.isFetching}
        >
          <RefreshCcw size={15} className={inbox.isFetching || governance.isFetching ? 'spin' : ''} />
        </button>
      </div>

      <div className="quick-intake-bar">
        <Zap size={14} className="quick-intake-icon" />
        <input
          type="text"
          className="quick-intake-input"
          placeholder={t('work.inbox.quickPlaceholder')}
          value={quickGoal}
          onChange={e => setQuickGoal(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') handleQuickSubmit(); }}
          disabled={quickMutation.isPending}
        />
        <button
          type="button"
          className="quick-intake-btn"
          onClick={handleQuickSubmit}
          disabled={!quickGoal.trim() || quickMutation.isPending}
          title={t('work.inbox.quickTitle')}
        >
          {quickMutation.isPending ? t('work.inbox.creating') : <><Plus size={14} /> {t('work.inbox.create')}</>}
        </button>
      </div>

      {govAttention.length > 0 ? (
        <section className="inbox-governance-strip" aria-label={t('work.inbox.governanceAria')}>
          <div className="inbox-governance-head">
            <Shield size={15} />
            <strong>{t('work.inbox.governanceTitle')}</strong>
            <span className="muted">{t('work.inbox.governanceHint', { n: String(govCount) })}</span>
            <button type="button" className="link-btn" onClick={() => { window.location.hash = 'governance'; }}>
              {t('work.inbox.governanceOpen')}
            </button>
          </div>
          <ul className="inbox-governance-list">
            {govAttention.map(job => (
              <li key={job.id} className="inbox-governance-row">
                <code>{job.jobType}</code>
                <span className="muted">
                  {job.escalated
                    ? t('work.inbox.governanceEscalated')
                    : job.circuitState === 'open'
                      ? t('work.inbox.governanceCircuit')
                      : job.status === 'paused'
                        ? t('work.inbox.governancePaused')
                        : t('work.inbox.governanceFindings', { n: String(job.findingCount ?? 0) })}
                </span>
                <button
                  type="button"
                  className="ghost-btn tiny-btn"
                  disabled={runGovJob.isPending}
                  onClick={() => runGovJob.mutate(job.jobType)}
                >
                  {t('work.inbox.governanceRun')}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <div className="daily-split">
        <nav className="attention-filters" aria-label={t('work.inbox.filtersAria')}>
          {(['all', 'decision', 'recovery', 'review', 'running'] as const).map(value => (
            <button key={value} type="button" data-active={filter === value} onClick={() => setFilter(value)}>
              <span>{t(`work.inbox.filter.${value}`)}</span>
              <strong>{filterCount(entries, value)}</strong>
            </button>
          ))}
        </nav>

        <div className="attention-feed" aria-live="polite">
          {inbox.isLoading ? <InboxSkeleton /> : null}
          {inbox.error ? <div className="daily-error">{t('work.inbox.unavailable', { error: String(inbox.error) })}</div> : null}
          {!inbox.isLoading && !inbox.error && visible.length === 0 ? (
            <div className="daily-empty">
              <CheckCheck size={22} />
              <strong>{t('work.inbox.noActionTitle')}</strong>
              <span>{filter === 'all' ? t('work.inbox.noActionHint') : t('work.inbox.noActionFiltered', { filter: t(`work.inbox.filter.${filter}`) })}</span>
              <span className="empty-guide-link">
                <button type="button" className="link-btn" onClick={() => window.location.hash = 'chat'}>{t('nav.chat')}</button> {t('work.inbox.guideMid')} <button type="button" className="link-btn" onClick={() => window.location.hash = 'work'}>{t('work.inbox.guideWork')}</button>{t('work.inbox.guideEnd')}
              </span>
            </div>
          ) : null}
          {visible.map(entry => (
            <InboxRow
              key={entry.id}
              entry={entry}
              onOpen={() => openEntry(entry, { onOpenWork, onOpenRun, onOpenSession })}
              onStartWork={onStartWork && entry.workItemId
                ? () => {
                  getJson<WorkItemProjection>(`/work-items/${entry.workItemId}`).then(onStartWork).catch(() => onOpenWork(entry.workItemId!));
                }
                : undefined}
            />
          ))}
        </div>
      </div>
    </section>
  );
}

function InboxRow({
  entry,
  onOpen,
  onStartWork,
}: {
  entry: InboxEntry;
  onOpen: () => void;
  onStartWork?: () => void;
}) {
  const { t } = useI18n();
  const decision = buildInboxDecision(entry, Boolean(onStartWork), t);
  const Icon = attentionIcon(entry.attentionState);
  const runPrimary = () => {
    if (decision.primaryKind === 'start' && onStartWork) {
      onStartWork();
      return;
    }
    onOpen();
  };

  return (
    <article className="attention-row" data-attention={entry.attentionState} data-testid="inbox-decision-row">
      <div className="attention-icon"><Icon size={16} /></div>
      <div className="attention-copy">
        <div className="attention-title-line">
          <strong>{entry.title}</strong>
          <span className={`attention-state ${entry.attentionState}`}>{stateLabel(entry.attentionState, t)}</span>
        </div>
        <div className="inbox-decision" aria-label={t('work.inbox.decisionAria')}>
          <p className="inbox-decision-need"><b>{t('work.inbox.needLabel')}</b> {decision.need}</p>
          <p className="inbox-decision-why"><b>{t('work.inbox.whyLabel')}</b> {decision.why}</p>
          <p className="inbox-decision-effect"><b>{t('work.inbox.effectLabel')}</b> {decision.effect}</p>
        </div>
        <div className="attention-meta">
          <span>{entry.projectId}</span>
          <span>{sourceKindLabel(entry.sourceKind, t)}</span>
          {entry.connector ? <span>{connectorLabel(entry.connector, t)}</span> : null}
          <time dateTime={entry.updatedAt}>{formatDate(entry.updatedAt)}</time>
        </div>
      </div>
      <div className="attention-actions">
        <button
          className={`attention-action inbox-primary-cta${decision.primaryKind === 'start' ? ' start-action' : ''}`}
          type="button"
          onClick={runPrimary}
          title={decision.effect}
          data-testid="inbox-primary-action"
        >
          {decision.primaryKind === 'start' ? <Play size={13} /> : null}
          {decision.primaryLabel}
          <ChevronRight size={14} />
        </button>
      </div>
    </article>
  );
}

/** Pure decision copy for tests and rendering. */
export function buildInboxDecision(
  entry: InboxEntry,
  canStart: boolean,
  t: (key: string, vars?: Record<string, string | number>) => string,
): InboxDecision {
  const startPrimary = entry.nextAction === 'start' && canStart && Boolean(entry.workItemId);
  if (startPrimary) {
    return {
      need: t('work.inbox.need.start'),
      why: t('work.inbox.why.start'),
      effect: t('work.inbox.effect.start'),
      primaryKind: 'start',
      primaryLabel: t('work.inbox.start'),
    };
  }

  switch (entry.attentionState) {
    case 'approval_required':
      return {
        need: t('work.inbox.need.approval'),
        why: t('work.inbox.why.approval'),
        effect: t('work.inbox.effect.approval'),
        primaryKind: 'open',
        primaryLabel: t('work.inbox.action.review_plan'),
      };
    case 'verification_blocked':
      return {
        need: t('work.inbox.need.verification'),
        why: t('work.inbox.why.verification'),
        effect: t('work.inbox.effect.verification'),
        primaryKind: 'open',
        primaryLabel: t('work.inbox.action.inspect_verification'),
      };
    case 'recovery_required':
      return {
        need: t('work.inbox.need.recovery'),
        why: t('work.inbox.why.recovery'),
        effect: t('work.inbox.effect.recovery'),
        primaryKind: 'open',
        primaryLabel: t('work.inbox.action.recover'),
      };
    case 'review_ready':
      return {
        need: t('work.inbox.need.review'),
        why: t('work.inbox.why.review'),
        effect: t('work.inbox.effect.review'),
        primaryKind: 'open',
        primaryLabel: t('work.inbox.action.review_changes'),
      };
    case 'running':
      return {
        need: t('work.inbox.need.running'),
        why: t('work.inbox.why.running'),
        effect: t('work.inbox.effect.running'),
        primaryKind: 'open',
        primaryLabel: t('work.inbox.action.view_progress'),
      };
    default:
      return {
        need: t('work.inbox.need.inspect'),
        why: t('work.inbox.why.inspect'),
        effect: t('work.inbox.effect.inspect'),
        primaryKind: 'open',
        primaryLabel: actionLabelFromNext(entry.nextAction, t),
      };
  }
}

function SummaryCount({ label, value, tone }: { label: string; value: number; tone: string }) {
  return <div className={`summary-count ${tone}`}><span>{label}</span><strong>{value}</strong></div>;
}

function InboxSkeleton() {
  return <div className="daily-skeleton" aria-label={tt('common.loading')}><i /><i /><i /></div>;
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

function stateLabel(state: WorkItemAttentionState, t: (key: string) => string): string {
  const key = `work.inbox.state.${state}`;
  return t(key) ?? state.replaceAll('_', ' ');
}

function sourceKindLabel(kind: InboxEntry['sourceKind'], t: (key: string) => string): string {
  const key = `work.inbox.source.${kind}`;
  const label = t(key);
  return label === key ? kind.replaceAll('_', ' ') : label;
}

function connectorLabel(
  connector: NonNullable<InboxEntry['connector']>,
  t: (key: string, vars?: Record<string, string | number>) => string,
): string {
  if (connector.kind !== 'feed_analysis') {
    return t('work.inbox.connectorGeneric');
  }
  if (connector.callbackStatus === 'dead_letter') return t('work.inbox.connector.deadLetter');
  if (connector.resultAvailable) return t('work.inbox.connector.resultReady');
  if (connector.dispatchStatus === 'failed') return t('work.inbox.connector.dispatchFailed');
  return t('work.inbox.connector.waiting');
}

function actionLabelFromNext(next: WorkItemNextAction, t: (key: string) => string): string {
  const labels: Partial<Record<WorkItemNextAction, string>> = {
    review_plan: 'work.inbox.action.review_plan',
    inspect_verification: 'work.inbox.action.inspect_verification',
    recover: 'work.inbox.action.recover',
    inspect_run: 'work.inbox.action.inspect_run',
    review_changes: 'work.inbox.action.review_changes',
    start: 'work.inbox.start',
  };
  return t(labels[next] ?? 'work.inbox.action.inspect');
}
