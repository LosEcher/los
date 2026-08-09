import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Bug,
  Check,
  ChevronRight,
  FileCheck2,
  MessageSquare,
  Play,
  Plus,
  RefreshCcw,
  Search,
  ShieldCheck,
  X,
} from 'lucide-react';

import {
  getJson,
  postJson,
  type RunContractDraft,
  type TodoStatus,
  type WorkItemProjection,
  type WorkItemListResponse,
} from '../api/index.js';
import { formatDate } from '../ui.js';
import { useI18n } from '../i18n';
import { StructuredCreateForm } from './work-create-form.js';
import { WorkReviewPanel } from './work-review-panel.js';
import {
  OutcomeCard,
  attentionLabel,
  friendlyWorkError,
  primaryActionKey,
  readWorkDebugPreference,
  writeWorkDebugPreference,
} from './work-guidance.js';

type RuntimeInspect = {
  nodes: Array<{ kind: string; record: { runContract?: RunContractDraft } }>;
};

/** List scope: open = non-terminal; all = every status; otherwise a concrete TodoStatus. */
type WorkStatusFilter = TodoStatus | 'open' | 'all';

function workItemsListUrl(filter: WorkStatusFilter): string {
  const params = new URLSearchParams({ limit: '100' });
  if (filter === 'open') {
    params.set('excludeTerminal', 'true');
  } else if (filter !== 'all') {
    params.set('status', filter);
  }
  return `/work-items?${params.toString()}`;
}

export function WorkPage({
  selectedWorkItemId,
  onSelectedWorkItemChange,
  onStartWork,
  onOpenSession,
  onOpenRun,
}: {
  selectedWorkItemId: string | null;
  onSelectedWorkItemChange: (id: string | null) => void;
  onStartWork: (item: WorkItemProjection) => void;
  onOpenSession: (id: string) => void;
  onOpenRun: (id: string) => void;
}) {
  const queryClient = useQueryClient();
  const { t } = useI18n();
  // Default to open work only — terminal done/cancelled P0 seeds used to flood the list.
  const [statusFilter, setStatusFilter] = useState<WorkStatusFilter>('open');
  const [search, setSearch] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [approvalReason, setApprovalReason] = useState('');
  const [debugMode, setDebugMode] = useState(() => readWorkDebugPreference());
  const [techOpen, setTechOpen] = useState(() => readWorkDebugPreference());

  const list = useQuery({
    queryKey: ['work-items', statusFilter],
    queryFn: () => getJson<WorkItemListResponse>(workItemsListUrl(statusFilter)),
    refetchInterval: 15_000,
  });
  const activeId = selectedWorkItemId ?? list.data?.results[0]?.id ?? null;
  const detail = useQuery({
    queryKey: ['work-item', activeId],
    queryFn: () => getJson<WorkItemProjection>(`/work-items/${activeId}`),
    enabled: Boolean(activeId),
    refetchInterval: 10_000,
  });
  const item = detail.data ?? list.data?.results.find(candidate => candidate.id === activeId) ?? null;
  const visibleItems = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    if (!query) return list.data?.results ?? [];
    return (list.data?.results ?? []).filter(candidate => [candidate.title, candidate.id, candidate.goal].some(value => value.toLocaleLowerCase().includes(query)));
  }, [list.data?.results, search]);
  const runSpecId = item?.evidence.latestRunSpecId;
  const availableActions = item?.availableActions;
  const inspect = useQuery({
    queryKey: ['work-item-run-inspect', runSpecId],
    queryFn: () => getJson<RuntimeInspect>(`/runs/${runSpecId}/inspect`),
    enabled: Boolean(runSpecId),
  });
  const runContract = useMemo(() => runContractFromInspect(inspect.data) ?? item?.runContractDraft, [inspect.data, item]);
  const primary = availableActions ? primaryActionKey(availableActions) : null;

  useEffect(() => {
    if (selectedWorkItemId && !list.isLoading) void detail.refetch();
  }, [selectedWorkItemId]);

  const setDebug = (enabled: boolean) => {
    setDebugMode(enabled);
    writeWorkDebugPreference(enabled);
    if (enabled) setTechOpen(true);
  };

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['work-items'] });
    if (activeId) void queryClient.invalidateQueries({ queryKey: ['work-item', activeId] });
    if (runSpecId) void queryClient.invalidateQueries({ queryKey: ['work-item-run-inspect', runSpecId] });
  };
  const approve = useMutation({
    mutationFn: (action: NonNullable<WorkItemProjection['availableActions']['approvePlan']>) => postJson(`/runs/${action.payload.runSpecId}/approve`, {
      ...action.payload,
      reason: approvalReason.trim() || 'operator approved plan from Work',
    }),
    onSuccess: () => { setApprovalReason(''); },
    onSettled: refresh,
  });
  const verify = useMutation({
    mutationFn: (action: NonNullable<WorkItemProjection['availableActions']['runVerification']>) => postJson(`/runs/${action.payload.runSpecId}/verify`, {}),
    onSuccess: refresh,
  });
  const review = useMutation({
    mutationFn: ({ decision, reason, dirtyPaths = [] }: { decision: 'accepted' | 'revision_requested'; reason: string; dirtyPaths?: string[] }) => postJson(`/work-items/${item!.id}/result-decision`, {
      decision,
      reason,
      closeoutReport: {
        dirtyPaths,
        checks: item!.verificationRecords
          .filter(record => record.status === 'succeeded' || record.status === 'skipped')
          .map(record => record.checkName),
        residualRisk: decision === 'revision_requested' ? reason : undefined,
      },
    }),
    onSuccess: refresh,
  });

  // Phone stack: only show detail when the operator explicitly selected (or deep-linked) an id.
  // Desktop keeps split view with the first list row as a soft default via activeId.
  const mobilePane = selectedWorkItemId ? 'detail' : 'list';

  return (
    <section
      className="daily-page work-page"
      data-debug={debugMode ? 'true' : 'false'}
      data-mobile-pane={mobilePane}
    >
      <div className="daily-toolbar work-toolbar-list">
        <div className="work-filters">
          <label className="work-search"><Search size={14} /><input aria-label={t('work.searchAria')} value={search} onChange={event => setSearch(event.target.value)} placeholder={t('work.searchAria')} /></label>
          <select
            aria-label={t('work.statusAria')}
            value={statusFilter}
            onChange={event => setStatusFilter(event.target.value as WorkStatusFilter)}
          >
            <option value="open">{t('work.filter.open')}</option>
            <option value="all">{t('work.filter.all')}</option>
            <option value="backlog">{t('work.status.backlog')}</option>
            <option value="ready">{t('work.status.ready')}</option>
            <option value="in_progress">{t('work.status.inProgress')}</option>
            <option value="blocked">{t('work.status.blocked')}</option>
            <option value="done">{t('work.status.done')}</option>
            <option value="cancelled">{t('work.status.cancelled')}</option>
          </select>
          <span>{t('work.count', { shown: visibleItems.length, total: list.data?.count ?? 0 })}</span>
        </div>
        <div className="daily-toolbar-actions">
          <label className="work-debug-toggle" title={t('work.debugTitle')}>
            <Bug size={14} aria-hidden />
            <input
              type="checkbox"
              checked={debugMode}
              onChange={event => setDebug(event.target.checked)}
              aria-label={t('work.debugLabel')}
            />
            <span>{t('work.debugLabel')}</span>
          </label>
          <button className="icon-btn" type="button" title={t('work.refreshTitle')} aria-label={t('work.refreshTitle')} onClick={refresh}>
            <RefreshCcw size={15} />
          </button>
          <button className="btn" type="button" onClick={() => setShowCreate(value => !value)}>
            {showCreate ? <X size={14} /> : <Plus size={14} />}{showCreate ? t('common.close') : t('work.newWork')}
          </button>
        </div>
      </div>

      {showCreate ? (
        <StructuredCreateForm
          onCreated={created => {
            setShowCreate(false);
            onSelectedWorkItemChange(created.id);
            refresh();
          }}
        />
      ) : null}

      <div className="work-split">
        <div className="work-list" aria-label={t('work.listAria')}>
          {list.isLoading ? <div className="daily-skeleton"><i /><i /><i /></div> : null}
          {list.error ? <div className="daily-error">{t('work.unavailable', { error: String(list.error) })}</div> : null}
          {!list.isLoading && !list.error && list.data?.results.length === 0 ? (
            <div className="daily-empty">
              <FileCheck2 size={22} />
              <strong>{t('work.emptyTitle')}</strong>
              <span>{statusFilter === 'open' ? t('work.emptyOpenHint') : t('work.emptyHint')}</span>
            </div>
          ) : null}
          {!list.isLoading && !list.error && list.data?.results.length !== 0 && visibleItems.length === 0 ? (
            <div className="daily-empty"><Search size={22} /><strong>{t('work.noMatchTitle')}</strong><span>{t('work.noMatchHint')}</span></div>
          ) : null}
          {visibleItems.map(candidate => (
            <button
              key={candidate.id}
              type="button"
              className="work-list-row"
              data-active={activeId === candidate.id}
              onClick={() => onSelectedWorkItemChange(candidate.id)}
            >
              <span className={`priority-mark ${candidate.priority.toLowerCase()}`}>{candidate.priority}</span>
              <span className="work-list-copy">
                <strong>{candidate.title}</strong>
                <small>{candidate.projectId} · {formatDate(candidate.updatedAt)}{debugMode ? ` · ${candidate.id}` : ''}</small>
              </span>
              <span className={`attention-state ${candidate.attentionState}`}>{attentionLabel(candidate.attentionState)}</span>
              <ChevronRight size={14} />
            </button>
          ))}
        </div>

        <aside className="work-detail">
          {!item ? <div className="daily-empty"><FileCheck2 size={22} /><strong>{t('work.selectTitle')}</strong><span>{t('work.selectHint')}</span></div> : (
            <>
              <header className="work-detail-head">
                <button
                  type="button"
                  className="work-mobile-back ghost-btn"
                  onClick={() => onSelectedWorkItemChange(null)}
                  aria-label={t('common.back')}
                >
                  <ChevronRight size={16} className="work-mobile-back-icon" aria-hidden />
                  {t('common.back')}
                </button>
                <div className="work-detail-title">
                  <span className="eyebrow">{item.projectId} / {item.priority}</span>
                  <h2>{item.title}</h2>
                  <p>{item.goal}</p>
                </div>
                <span className={`attention-state ${item.attentionState}`}>{attentionLabel(item.attentionState)}</span>
              </header>

              <OutcomeCard item={item} />

              <div className="work-action-strip" data-testid="work-action-strip">
                {availableActions?.startWork ? (
                  <button
                    className={primary === 'startWork' ? 'btn work-primary-cta' : 'ghost-btn'}
                    type="button"
                    title={availableActions.startWork.effect}
                    onClick={() => onStartWork(item)}
                  >
                    <Play size={14} /> {availableActions.startWork.label}
                  </button>
                ) : null}
                {availableActions?.approvePlan ? (
                  <button
                    className={primary === 'approvePlan' ? 'btn work-primary-cta' : 'ghost-btn'}
                    type="button"
                    title={availableActions.approvePlan.effect}
                    disabled={approve.isPending}
                    onClick={() => approve.mutate(availableActions.approvePlan!)}
                  >
                    <Check size={14} /> {approve.isPending ? t('work.approving') : availableActions.approvePlan.label}
                  </button>
                ) : null}
                {availableActions?.runVerification ? (
                  <button
                    className={primary === 'runVerification' ? 'btn work-primary-cta' : 'ghost-btn'}
                    type="button"
                    title={availableActions.runVerification.effect}
                    disabled={verify.isPending}
                    onClick={() => verify.mutate(availableActions.runVerification!)}
                  >
                    <ShieldCheck size={14} /> {verify.isPending ? t('work.runningChecks') : availableActions.runVerification.label}
                  </button>
                ) : null}
                {availableActions?.continueSession ? (
                  <button
                    className={primary === 'continueSession' ? 'btn work-primary-cta' : 'ghost-btn'}
                    type="button"
                    title={availableActions.continueSession.effect}
                    onClick={() => onOpenSession(availableActions.continueSession!.payload.sessionId)}
                  >
                    <MessageSquare size={14} /> {availableActions.continueSession.label}
                  </button>
                ) : null}
                {availableActions?.inspectRun ? (
                  <button
                    className="ghost-btn"
                    type="button"
                    title={availableActions.inspectRun.effect}
                    onClick={() => onOpenRun(availableActions.inspectRun!.payload.runSpecId)}
                  >
                    <FileCheck2 size={14} /> {availableActions.inspectRun.label}
                  </button>
                ) : null}
              </div>
              {availableActions?.approvePlan ? (
                <label className="approval-reason"><span>{t('work.approvalReasonLabel')}</span><input value={approvalReason} onChange={event => setApprovalReason(event.target.value)} placeholder={t('work.approvalReasonPlaceholder')} /></label>
              ) : null}
              {approve.error || verify.error ? <div className="daily-error">{friendlyWorkError(approve.error ?? verify.error)}</div> : null}

              <WorkReviewPanel
                item={item}
                pending={review.isPending}
                error={review.error}
                onDecision={(decision, reason, dirtyPaths) => review.mutate({ decision, reason, dirtyPaths })}
              />

              <PlanReview contract={runContract} debugMode={debugMode} />
              <ContractSection title={t('work.contract.editableSurfaces')} items={runContract?.editableSurfaces ?? []} empty={t('work.contract.noWritableScope')} />
              <ContractSection title={t('work.contract.requiredChecks')} items={runContract?.requiredChecks ?? []} empty={t('work.contract.noChecks')} />
              <ContractSection title={t('work.contract.stopConditions')} items={runContract?.stopConditions ?? []} empty={t('work.contract.noStopConditions')} />

              <details
                className="work-technical"
                open={techOpen || debugMode}
                onToggle={event => setTechOpen((event.target as HTMLDetailsElement).open)}
                data-testid="work-technical-details"
              >
                <summary className="work-technical-summary">
                  <span>{t('work.tech.summary')}</span>
                  <small>{t('work.tech.hint')}</small>
                </summary>
                <TechnicalEvidence item={item} runContract={runContract} />
              </details>
            </>
          )}
        </aside>
      </div>
    </section>
  );
}

function TechnicalEvidence({ item, runContract }: { item: WorkItemProjection; runContract?: RunContractDraft }) {
  const { t } = useI18n();
  return (
    <div className="work-technical-body">
      <div className="work-evidence-grid">
        {item.feedAnalysis ? (
          <>
            <EvidenceBlock label={t('work.ev.dispatch')}>
              <FactLine label={t('work.fact.status')} value={item.feedAnalysis.dispatchStatus} tone={item.feedAnalysis.dispatchStatus === 'failed' ? 'danger' : 'info'} />
              <FactLine label={t('work.fact.source')} value={item.feedAnalysis.sourceSystem} />
              <FactLine label={t('work.fact.job')} value={item.feedAnalysis.sourceJobId} />
              <FactLine label={t('work.fact.delivery')} value={item.feedAnalysis.deliveryMode} />
            </EvidenceBlock>
            <EvidenceBlock label={t('work.ev.losExecution')}>
              <FactLine label={t('work.fact.run')} value={item.evidence.runSpecStatus ?? t('work.notLinked')} />
              <FactLine label={t('work.fact.task')} value={item.evidence.taskRunStatus ?? t('work.notLinked')} />
              <FactLine label={t('work.fact.runSpec')} value={item.evidence.latestRunSpecId ?? t('common.none')} />
              <FactLine label={t('work.fact.taskRun')} value={item.evidence.latestTaskRunId ?? t('common.none')} />
            </EvidenceBlock>
            <EvidenceBlock label={t('work.ev.validatedResult')}>
              <FactLine label={t('work.fact.available')} value={item.feedAnalysis.resultAvailable ? t('work.yes') : t('work.no')} tone={item.feedAnalysis.resultAvailable ? 'ok' : 'warn'} />
              <FactLine label={t('work.fact.errorCode')} value={item.feedAnalysis.errorCode ?? t('common.none')} tone={item.feedAnalysis.errorCode ? 'danger' : undefined} />
              <FactLine label={t('work.fact.updated')} value={formatDate(item.feedAnalysis.updatedAt)} />
            </EvidenceBlock>
            <EvidenceBlock label={t('work.ev.callback')}>
              <FactLine label={t('work.fact.status')} value={item.feedAnalysis.callback.latestStatus.replaceAll('_', ' ')} tone={item.feedAnalysis.callback.deadLetterCount ? 'danger' : item.feedAnalysis.callback.deliveredCount ? 'ok' : undefined} />
              <FactLine label={t('work.fact.events')} value={String(item.feedAnalysis.callback.eventCount)} />
              <FactLine label={t('work.fact.delivered')} value={String(item.feedAnalysis.callback.deliveredCount)} />
              <FactLine label={t('work.fact.deadLetters')} value={String(item.feedAnalysis.callback.deadLetterCount)} tone={item.feedAnalysis.callback.deadLetterCount ? 'danger' : undefined} />
              <FactLine label={t('work.fact.latency')} value={item.feedAnalysis.callback.latestLatencyMs === undefined ? t('work.na') : `${item.feedAnalysis.callback.latestLatencyMs} ms`} />
            </EvidenceBlock>
          </>
        ) : null}
        <EvidenceBlock label={t('work.ev.contract')}>
          <FactLine label={t('work.fact.mode')} value={String(runContract?.mode ?? t('common.unknown'))} />
          <FactLine label={t('work.fact.tools')} value={String(runContract?.toolMode ?? 'read-only')} />
          <FactLine label={t('work.fact.phase')} value={String(runContract?.phase ?? 'created')} />
          <FactLine label={t('work.fact.status')} value={item.status} />
        </EvidenceBlock>
        <EvidenceBlock label={t('work.ev.verification')}>
          <FactLine label={t('work.fact.passed')} value={String(item.evidence.verificationSucceeded)} tone="ok" />
          <FactLine label={t('work.fact.skipped')} value={String(item.evidence.verificationSkipped)} />
          <FactLine label={t('work.fact.pending')} value={String(item.evidence.verificationPending)} tone="warn" />
          <FactLine label={t('work.fact.failed')} value={String(item.evidence.verificationFailed)} tone="danger" />
          <FactLine label={t('work.fact.required')} value={String(item.evidence.verificationRequired)} />
        </EvidenceBlock>
      </div>
      <Lineage item={item} />
    </div>
  );
}

function EvidenceBlock({ label, children }: { label: string; children: ReactNode }) {
  return <section className="evidence-block"><h3>{label}</h3>{children}</section>;
}

function FactLine({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return <div className={`work-fact ${tone ?? ''}`}><span>{label}</span><strong>{value}</strong></div>;
}

function ContractSection({ title, items, empty }: { title: string; items: string[]; empty: string }) {
  return <section className="contract-section"><h3>{title}</h3>{items.length ? <ol>{items.map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}</ol> : <p>{empty}</p>}</section>;
}

function PlanReview({ contract, debugMode }: { contract?: RunContractDraft; debugMode: boolean }) {
  const { t } = useI18n();
  const plan = contract?.plan ?? [];
  const verifications = contract?.verifications ?? [];
  return <section className="contract-section plan-review">
    <div className="contract-section-heading"><h3>{t('work.plan.title')}</h3><span>{contract?.planRevision ? t('work.plan.revision', { n: contract.planRevision }) : t('work.plan.draft')}</span></div>
    {plan.length === 0 ? <p>{t('work.plan.none')}</p> : <ol className="plan-step-list">
      {plan.map((step, index) => <li key={`${step.id ?? 'step'}-${index}`} className="plan-step">
        <div className="plan-step-title">
          <strong>{step.title ?? step.id ?? t('work.plan.stepFallback', { n: index + 1 })}</strong>
          {debugMode ? <span>{step.id ?? `step-${index + 1}`}</span> : null}
        </div>
        <p>{step.description ?? t('work.plan.noDescription')}</p>
        <dl className="plan-step-facts">
          <div><dt>{t('work.plan.dependsOn')}</dt><dd>{step.dependsOnIds?.length ? step.dependsOnIds.join(', ') : t('common.none')}</dd></div>
          <div><dt>{t('work.plan.writableScope')}</dt><dd>{step.editableSurfaces?.length ? step.editableSurfaces.join(', ') : t('work.plan.noScopeDeclared')}</dd></div>
          <div><dt>{t('work.plan.doneWhen')}</dt><dd>{step.completionCriteria ?? t('work.plan.noCriterion')}</dd></div>
        </dl>
      </li>)}
    </ol>}
    <div className="plan-verification-block">
      <h4>{t('work.plan.verificationMapping')}</h4>
      {verifications.length === 0 ? <p>{t('work.plan.noMapping')}</p> : <ul>{verifications.map(requirement => <li key={requirement.id}><strong>{requirement.id}</strong><span>{requirement.description}</span>{requirement.command ? <code>{requirement.command}</code> : null}</li>)}</ul>}
    </div>
    {contract?.planHistory?.length ? <div className="plan-history"><h4>{t('work.plan.revisionHistory')}</h4><ol>{contract.planHistory.map(snapshot => <li key={snapshot.revision}><strong>{t('work.plan.revision', { n: snapshot.revision })}</strong><span>{snapshot.reason ?? t('work.plan.superseded')}</span><time>{formatDate(snapshot.supersededAt)}</time></li>)}</ol></div> : null}
  </section>;
}

function Lineage({ item }: { item: WorkItemProjection }) {
  const { t } = useI18n();
  return <section className="contract-section lineage-section"><h3>{t('work.lineage.title')}</h3><dl><div><dt>{t('work.lineage.workItem')}</dt><dd>{item.id}</dd></div><div><dt>{t('work.lineage.runSpec')}</dt><dd>{item.evidence.latestRunSpecId ?? t('common.none')}</dd></div><div><dt>{t('work.lineage.taskRun')}</dt><dd>{item.evidence.latestTaskRunId ?? t('common.none')}</dd></div><div><dt>{t('work.lineage.session')}</dt><dd>{item.evidence.latestSessionId ?? t('common.none')}</dd></div></dl></section>;
}

function runContractFromInspect(data: RuntimeInspect | undefined): RunContractDraft | undefined {
  return data?.nodes.find(node => node.kind === 'run_spec')?.record.runContract;
}
