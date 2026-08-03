import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
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
  getCurrentProjectId,
  getJson,
  postJson,
  type CreateWorkItemPayload,
  type RunContractDraft,
  type TodoStatus,
  type WorkItemMode,
  type WorkItemProjection,
  type WorkItemListResponse,
} from '../api/index.js';
import { formatDate } from '../ui.js';
import { useI18n } from '../i18n';
import { WorkReviewPanel } from './work-review-panel.js';
import { NextStepGuide, attentionLabel, friendlyWorkError } from './work-guidance.js';

type WorkFormState = {
  projectId: string;
  title: string;
  goal: string;
  description: string;
  mode: WorkItemMode;
  toolMode: 'read-only' | 'project-write';
  priority: 'P0' | 'P1' | 'P2' | 'P3';
  editableSurfaces: string;
  nonGoals: string;
  requiredChecks: string;
  stopConditions: string;
  evidenceRequired: string;
};

type RuntimeInspect = {
  nodes: Array<{ kind: string; record: { runContract?: RunContractDraft } }>;
};

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
  const [status, setStatus] = useState<TodoStatus | ''>('');
  const [search, setSearch] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [approvalReason, setApprovalReason] = useState('');
  const list = useQuery({
    queryKey: ['work-items', status],
    queryFn: () => getJson<WorkItemListResponse>(`/work-items?limit=100${status ? `&status=${status}` : ''}`),
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

  useEffect(() => {
    if (selectedWorkItemId && !list.isLoading) void detail.refetch();
  }, [selectedWorkItemId]);

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

  return (
    <section className="daily-page work-page">
      <div className="daily-toolbar">
        <div className="work-filters">
          <label className="work-search"><Search size={14} /><input aria-label={t('work.searchAria')} value={search} onChange={event => setSearch(event.target.value)} placeholder={t('work.searchAria')} /></label>
          <select aria-label={t('work.statusAria')} value={status} onChange={event => setStatus(event.target.value as TodoStatus | '')}>
            <option value="">{t('work.filter.all')}</option>
            <option value="backlog">{t('work.status.backlog')}</option>
            <option value="ready">{t('work.status.ready')}</option>
            <option value="in_progress">{t('work.status.inProgress')}</option>
            <option value="blocked">{t('work.status.blocked')}</option>
            <option value="done">{t('work.status.done')}</option>
          </select>
          <span>{t('work.count', { shown: visibleItems.length, total: list.data?.count ?? 0 })}</span>
        </div>
        <div className="daily-toolbar-actions">
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
            <div className="daily-empty"><FileCheck2 size={22} /><strong>{t('work.emptyTitle')}</strong><span>{t('work.emptyHint')}</span></div>
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
              <span className="work-list-copy"><strong>{candidate.title}</strong><small>{candidate.projectId} · {formatDate(candidate.updatedAt)}</small></span>
              <span className={`attention-state ${candidate.attentionState}`}>{attentionLabel(candidate.attentionState)}</span>
              <ChevronRight size={14} />
            </button>
          ))}
        </div>

        <aside className="work-detail">
          {!item ? <div className="daily-empty"><FileCheck2 size={22} /><strong>{t('work.selectTitle')}</strong><span>{t('work.selectHint')}</span></div> : (
            <>
              <header className="work-detail-head">
                <div><span className="eyebrow">{item.projectId} / {item.priority}</span><h2>{item.title}</h2><p>{item.goal}</p></div>
                <span className={`attention-state ${item.attentionState}`}>{attentionLabel(item.attentionState)}</span>
              </header>

              <NextStepGuide item={item} />

              <div className="work-action-strip">
                {availableActions?.startWork ? <button className="btn" type="button" title={availableActions.startWork.effect} onClick={() => onStartWork(item)}><Play size={14} /> {availableActions.startWork.label}</button> : null}
                {availableActions?.approvePlan ? (
                  <button className="btn" type="button" title={availableActions.approvePlan.effect} disabled={approve.isPending} onClick={() => approve.mutate(availableActions.approvePlan!)}><Check size={14} /> {approve.isPending ? t('work.approving') : availableActions.approvePlan.label}</button>
                ) : null}
                {availableActions?.runVerification ? (
                  <button className="btn" type="button" title={availableActions.runVerification.effect} disabled={verify.isPending} onClick={() => verify.mutate(availableActions.runVerification!)}><ShieldCheck size={14} /> {verify.isPending ? t('work.runningChecks') : availableActions.runVerification.label}</button>
                ) : null}
                {availableActions?.inspectRun ? <button className="ghost-btn" type="button" title={availableActions.inspectRun.effect} onClick={() => onOpenRun(availableActions.inspectRun!.payload.runSpecId)}><FileCheck2 size={14} /> {availableActions.inspectRun.label}</button> : null}
                {availableActions?.continueSession ? <button className="ghost-btn" type="button" title={availableActions.continueSession.effect} onClick={() => onOpenSession(availableActions.continueSession!.payload.sessionId)}><MessageSquare size={14} /> {availableActions.continueSession.label}</button> : null}
              </div>
              {availableActions?.approvePlan ? (
                <label className="approval-reason"><span>{t('work.approvalReasonLabel')}</span><input value={approvalReason} onChange={event => setApprovalReason(event.target.value)} placeholder={t('work.approvalReasonPlaceholder')} /></label>
              ) : null}
              {approve.error || verify.error ? <div className="daily-error">{friendlyWorkError(approve.error ?? verify.error)}</div> : null}

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

              <WorkReviewPanel
                item={item}
                pending={review.isPending}
                error={review.error}
                onDecision={(decision, reason, dirtyPaths) => review.mutate({ decision, reason, dirtyPaths })}
              />

              <PlanReview contract={runContract} />
              <ContractSection title={t('work.contract.editableSurfaces')} items={runContract?.editableSurfaces ?? []} empty={t('work.contract.noWritableScope')} />
              <ContractSection title={t('work.contract.requiredChecks')} items={runContract?.requiredChecks ?? []} empty={t('work.contract.noChecks')} />
              <ContractSection title={t('work.contract.stopConditions')} items={runContract?.stopConditions ?? []} empty={t('work.contract.noStopConditions')} />
              <Lineage item={item} />
            </>
          )}
        </aside>
      </div>
    </section>
  );
}

function StructuredCreateForm({ onCreated }: { onCreated: (item: WorkItemProjection) => void }) {
  const { t } = useI18n();
  const [form, setForm] = useState<WorkFormState>(() => initialForm());
  const create = useMutation({
    mutationFn: () => postJson<WorkItemProjection>('/work-items', buildCreateWorkItemPayload(form)),
    onSuccess: onCreated,
  });
  const set = <K extends keyof WorkFormState>(key: K, value: WorkFormState[K]) => setForm(current => ({ ...current, [key]: value }));
  const submit = (event: FormEvent) => { event.preventDefault(); if (form.goal.trim()) create.mutate(); };
  return (
    <form className="work-create" onSubmit={submit}>
      <div className="work-create-lead">
        <label><span>{t('work.form.goal')}</span><textarea rows={3} required value={form.goal} onChange={event => set('goal', event.target.value)} placeholder={t('work.form.goalPlaceholder')} /></label>
        <label><span>{t('work.form.title')}</span><input value={form.title} onChange={event => set('title', event.target.value)} placeholder={t('work.form.titlePlaceholder')} /></label>
        <label><span>{t('work.form.description')}</span><textarea rows={2} value={form.description} onChange={event => set('description', event.target.value)} placeholder={t('work.form.descriptionPlaceholder')} /></label>
      </div>
      <div className="work-create-contract">
        <div className="work-create-controls">
          <label><span>{t('work.form.project')}</span><input required value={form.projectId} onChange={event => set('projectId', event.target.value)} /></label>
          <label><span>{t('work.form.mode')}</span><select value={form.mode} onChange={event => set('mode', event.target.value as WorkItemMode)}><option value="execution">{t('work.mode.execution')}</option><option value="audit">{t('work.mode.audit')}</option><option value="governance">{t('work.mode.governance')}</option><option value="closeout">{t('work.mode.closeout')}</option><option value="feed-analysis-ingress">{t('work.mode.feedAnalysis')}</option></select></label>
          <label><span>{t('work.form.tools')}</span><select value={form.toolMode} onChange={event => set('toolMode', event.target.value as WorkFormState['toolMode'])}><option value="read-only">{t('work.toolMode.readOnly')}</option><option value="project-write">{t('work.toolMode.projectWrite')}</option></select></label>
          <label><span>{t('work.form.priority')}</span><select value={form.priority} onChange={event => set('priority', event.target.value as WorkFormState['priority'])}><option>P0</option><option>P1</option><option>P2</option><option>P3</option></select></label>
        </div>
        <div className="work-create-lists">
          <LineField label={t('work.contract.editableSurfaces')} value={form.editableSurfaces} onChange={value => set('editableSurfaces', value)} placeholder={t('work.form.editableSurfacesPlaceholder')} />
          <LineField label={t('work.contract.requiredChecks')} value={form.requiredChecks} onChange={value => set('requiredChecks', value)} placeholder={t('work.form.requiredChecksPlaceholder')} />
          <LineField label={t('work.contract.stopConditions')} value={form.stopConditions} onChange={value => set('stopConditions', value)} placeholder={t('work.form.stopConditionsPlaceholder')} />
          <LineField label={t('work.form.evidenceRequired')} value={form.evidenceRequired} onChange={value => set('evidenceRequired', value)} placeholder={t('work.form.evidenceRequiredPlaceholder')} />
          <LineField label={t('work.form.nonGoals')} value={form.nonGoals} onChange={value => set('nonGoals', value)} placeholder={t('work.form.nonGoalsPlaceholder')} />
        </div>
        <div className="work-create-submit"><span>{t('work.form.draftNote')}</span><button className="btn" type="submit" disabled={create.isPending || !form.goal.trim()}><Plus size={14} /> {create.isPending ? t('work.creating') : t('work.createWork')}</button></div>
        {create.error ? <div className="daily-error">{t('work.createFailed', { error: String(create.error) })}</div> : null}
      </div>
    </form>
  );
}

function LineField({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (value: string) => void; placeholder: string }) {
  return <label><span>{label}</span><textarea rows={3} value={value} onChange={event => onChange(event.target.value)} placeholder={placeholder} /></label>;
}

function EvidenceBlock({ label, children }: { label: string; children: React.ReactNode }) {
  return <section className="evidence-block"><h3>{label}</h3>{children}</section>;
}

function FactLine({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return <div className={`work-fact ${tone ?? ''}`}><span>{label}</span><strong>{value}</strong></div>;
}

function ContractSection({ title, items, empty }: { title: string; items: string[]; empty: string }) {
  return <section className="contract-section"><h3>{title}</h3>{items.length ? <ol>{items.map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}</ol> : <p>{empty}</p>}</section>;
}

function PlanReview({ contract }: { contract?: RunContractDraft }) {
  const { t } = useI18n();
  const plan = contract?.plan ?? [];
  const verifications = contract?.verifications ?? [];
  return <section className="contract-section plan-review">
    <div className="contract-section-heading"><h3>{t('work.plan.title')}</h3><span>{contract?.planRevision ? t('work.plan.revision', { n: contract.planRevision }) : t('work.plan.draft')}</span></div>
    {plan.length === 0 ? <p>{t('work.plan.none')}</p> : <ol className="plan-step-list">
      {plan.map((step, index) => <li key={`${step.id ?? 'step'}-${index}`} className="plan-step">
        <div className="plan-step-title"><strong>{step.title ?? step.id ?? t('work.plan.stepFallback', { n: index + 1 })}</strong><span>{step.id ?? `step-${index + 1}`}</span></div>
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

export function buildCreateWorkItemPayload(form: WorkFormState): CreateWorkItemPayload {
  return {
    projectId: form.projectId.trim(), title: form.title.trim() || undefined, goal: form.goal.trim(), description: form.description.trim() || undefined,
    mode: form.mode, toolMode: form.toolMode, priority: form.priority,
    editableSurfaces: lines(form.editableSurfaces), nonGoals: lines(form.nonGoals), requiredChecks: lines(form.requiredChecks),
    stopConditions: lines(form.stopConditions), evidenceRequired: lines(form.evidenceRequired),
  };
}

function initialForm(): WorkFormState {
  return { projectId: getCurrentProjectId() ?? 'los', title: '', goal: '', description: '', mode: 'execution', toolMode: 'project-write', priority: 'P2', editableSurfaces: '', nonGoals: '', requiredChecks: '', stopConditions: '', evidenceRequired: '' };
}

function lines(value: string): string[] {
  return [...new Set(value.split('\n').map(line => line.trim()).filter(Boolean))];
}

function runContractFromInspect(data: RuntimeInspect | undefined): RunContractDraft | undefined {
  return data?.nodes.find(node => node.kind === 'run_spec')?.record.runContract;
}
