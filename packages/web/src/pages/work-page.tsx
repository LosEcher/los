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
import { WorkReviewPanel } from './work-review-panel.js';

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
  const [status, setStatus] = useState<TodoStatus | ''>('');
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
  const runSpecId = item?.evidence.latestRunSpecId;
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
  };
  const approve = useMutation({
    mutationFn: (id: string) => postJson(`/runs/${id}/approve`, {
      actor: 'web-console',
      reason: approvalReason.trim() || 'operator approved plan from Work',
    }),
    onSuccess: () => { setApprovalReason(''); refresh(); },
  });
  const verify = useMutation({
    mutationFn: (id: string) => postJson(`/runs/${id}/verify`, {}),
    onSuccess: refresh,
  });
  const review = useMutation({
    mutationFn: ({ decision, reason }: { decision: 'accepted' | 'revision_requested'; reason: string }) => postJson(`/work-items/${item!.id}/result-decision`, {
      decision,
      reason,
      closeoutReport: {
        dirtyPaths: [],
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
          <select aria-label="Work status" value={status} onChange={event => setStatus(event.target.value as TodoStatus | '')}>
            <option value="">all status</option>
            <option value="backlog">backlog</option>
            <option value="ready">ready</option>
            <option value="in_progress">in progress</option>
            <option value="blocked">blocked</option>
            <option value="done">done</option>
          </select>
          <span>{list.data?.count ?? 0} work items</span>
        </div>
        <div className="daily-toolbar-actions">
          <button className="icon-btn" type="button" title="Refresh work" aria-label="Refresh work" onClick={refresh}>
            <RefreshCcw size={15} />
          </button>
          <button className="btn" type="button" onClick={() => setShowCreate(value => !value)}>
            {showCreate ? <X size={14} /> : <Plus size={14} />}{showCreate ? 'Close' : 'New work'}
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
        <div className="work-list" aria-label="Work items">
          {list.isLoading ? <div className="daily-skeleton"><i /><i /><i /></div> : null}
          {list.error ? <div className="daily-error">Work unavailable: {String(list.error)}</div> : null}
          {!list.isLoading && !list.error && list.data?.results.length === 0 ? (
            <div className="daily-empty"><FileCheck2 size={22} /><strong>No work items</strong><span>Create a structured target to begin.</span></div>
          ) : null}
          {list.data?.results.map(candidate => (
            <button
              key={candidate.id}
              type="button"
              className="work-list-row"
              data-active={activeId === candidate.id}
              onClick={() => onSelectedWorkItemChange(candidate.id)}
            >
              <span className={`priority-mark ${candidate.priority.toLowerCase()}`}>{candidate.priority}</span>
              <span className="work-list-copy"><strong>{candidate.title}</strong><small>{candidate.projectId} · {formatDate(candidate.updatedAt)}</small></span>
              <span className={`attention-state ${candidate.attentionState}`}>{candidate.attentionState.replaceAll('_', ' ')}</span>
              <ChevronRight size={14} />
            </button>
          ))}
        </div>

        <aside className="work-detail">
          {!item ? <div className="daily-empty"><FileCheck2 size={22} /><strong>Select work</strong><span>Contract, lineage, and verification evidence appear here.</span></div> : (
            <>
              <header className="work-detail-head">
                <div><span className="eyebrow">{item.projectId} / {item.priority}</span><h2>{item.title}</h2><p>{item.goal}</p></div>
                <span className={`attention-state ${item.attentionState}`}>{item.attentionState.replaceAll('_', ' ')}</span>
              </header>

              <div className="work-action-strip">
                {item.nextAction === 'start' ? <button className="btn" type="button" onClick={() => onStartWork(item)}><Play size={14} /> Start in Chat</button> : null}
                {item.nextAction === 'review_plan' && runSpecId ? (
                  <button className="btn" type="button" disabled={approve.isPending} onClick={() => approve.mutate(runSpecId)}><Check size={14} /> {approve.isPending ? 'Approving' : 'Approve plan'}</button>
                ) : null}
                {item.nextAction === 'inspect_verification' && runSpecId ? (
                  <button className="btn" type="button" disabled={verify.isPending} onClick={() => verify.mutate(runSpecId)}><ShieldCheck size={14} /> {verify.isPending ? 'Running checks' : 'Run checks'}</button>
                ) : null}
                {runSpecId ? <button className="ghost-btn" type="button" onClick={() => onOpenRun(runSpecId)}><FileCheck2 size={14} /> Run evidence</button> : null}
                {item.evidence.latestSessionId ? <button className="ghost-btn" type="button" onClick={() => onOpenSession(item.evidence.latestSessionId!)}><MessageSquare size={14} /> Continue</button> : null}
              </div>
              {item.nextAction === 'review_plan' ? (
                <label className="approval-reason"><span>Approval reason</span><input value={approvalReason} onChange={event => setApprovalReason(event.target.value)} placeholder="Decision context for the audit trail" /></label>
              ) : null}
              {approve.error || verify.error ? <div className="daily-error">{String(approve.error ?? verify.error)}</div> : null}

              <div className="work-evidence-grid">
                {item.feedAnalysis ? (
                  <>
                    <EvidenceBlock label="Dispatch">
                      <FactLine label="status" value={item.feedAnalysis.dispatchStatus} tone={item.feedAnalysis.dispatchStatus === 'failed' ? 'danger' : 'info'} />
                      <FactLine label="source" value={item.feedAnalysis.sourceSystem} />
                      <FactLine label="job" value={item.feedAnalysis.sourceJobId} />
                      <FactLine label="delivery" value={item.feedAnalysis.deliveryMode} />
                    </EvidenceBlock>
                    <EvidenceBlock label="LOS execution">
                      <FactLine label="run" value={item.evidence.runSpecStatus ?? 'not linked'} />
                      <FactLine label="task" value={item.evidence.taskRunStatus ?? 'not linked'} />
                      <FactLine label="run spec" value={item.evidence.latestRunSpecId ?? 'none'} />
                      <FactLine label="task run" value={item.evidence.latestTaskRunId ?? 'none'} />
                    </EvidenceBlock>
                    <EvidenceBlock label="Validated result">
                      <FactLine label="available" value={item.feedAnalysis.resultAvailable ? 'yes' : 'no'} tone={item.feedAnalysis.resultAvailable ? 'ok' : 'warn'} />
                      <FactLine label="error code" value={item.feedAnalysis.errorCode ?? 'none'} tone={item.feedAnalysis.errorCode ? 'danger' : undefined} />
                      <FactLine label="updated" value={formatDate(item.feedAnalysis.updatedAt)} />
                    </EvidenceBlock>
                    <EvidenceBlock label="Callback">
                      <FactLine label="status" value={item.feedAnalysis.callback.latestStatus.replaceAll('_', ' ')} tone={item.feedAnalysis.callback.deadLetterCount ? 'danger' : item.feedAnalysis.callback.deliveredCount ? 'ok' : undefined} />
                      <FactLine label="events" value={String(item.feedAnalysis.callback.eventCount)} />
                      <FactLine label="delivered" value={String(item.feedAnalysis.callback.deliveredCount)} />
                      <FactLine label="dead letters" value={String(item.feedAnalysis.callback.deadLetterCount)} tone={item.feedAnalysis.callback.deadLetterCount ? 'danger' : undefined} />
                      <FactLine label="latency" value={item.feedAnalysis.callback.latestLatencyMs === undefined ? 'n/a' : `${item.feedAnalysis.callback.latestLatencyMs} ms`} />
                    </EvidenceBlock>
                  </>
                ) : null}
                <EvidenceBlock label="Contract">
                  <FactLine label="mode" value={String(runContract?.mode ?? 'unknown')} />
                  <FactLine label="tools" value={String(runContract?.toolMode ?? 'read-only')} />
                  <FactLine label="phase" value={String(runContract?.phase ?? 'created')} />
                  <FactLine label="status" value={item.status} />
                </EvidenceBlock>
                <EvidenceBlock label="Verification">
                  <FactLine label="passed" value={String(item.evidence.verificationSucceeded)} tone="ok" />
                  <FactLine label="skipped" value={String(item.evidence.verificationSkipped)} />
                  <FactLine label="pending" value={String(item.evidence.verificationPending)} tone="warn" />
                  <FactLine label="failed" value={String(item.evidence.verificationFailed)} tone="danger" />
                  <FactLine label="required" value={String(item.evidence.verificationRequired)} />
                </EvidenceBlock>
              </div>

              <WorkReviewPanel
                item={item}
                pending={review.isPending}
                error={review.error}
                onDecision={(decision, reason) => review.mutate({ decision, reason })}
              />

              <PlanReview contract={runContract} />
              <ContractSection title="Editable surfaces" items={runContract?.editableSurfaces ?? []} empty="No writable scope declared." />
              <ContractSection title="Required checks" items={runContract?.requiredChecks ?? []} empty="No checks declared." />
              <ContractSection title="Stop conditions" items={runContract?.stopConditions ?? []} empty="No stop conditions declared." />
              <Lineage item={item} />
            </>
          )}
        </aside>
      </div>
    </section>
  );
}

function StructuredCreateForm({ onCreated }: { onCreated: (item: WorkItemProjection) => void }) {
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
        <label><span>Goal</span><textarea rows={3} required value={form.goal} onChange={event => set('goal', event.target.value)} placeholder="What outcome should the agent produce?" /></label>
        <label><span>Title</span><input value={form.title} onChange={event => set('title', event.target.value)} placeholder="Optional short label" /></label>
        <label><span>Description</span><textarea rows={2} value={form.description} onChange={event => set('description', event.target.value)} placeholder="Context that belongs with this work item" /></label>
      </div>
      <div className="work-create-contract">
        <div className="work-create-controls">
          <label><span>Project</span><input required value={form.projectId} onChange={event => set('projectId', event.target.value)} /></label>
          <label><span>Mode</span><select value={form.mode} onChange={event => set('mode', event.target.value as WorkItemMode)}><option value="execution">execution</option><option value="audit">audit</option><option value="governance">governance</option><option value="closeout">closeout</option><option value="feed-analysis-ingress">feed analysis</option></select></label>
          <label><span>Tools</span><select value={form.toolMode} onChange={event => set('toolMode', event.target.value as WorkFormState['toolMode'])}><option value="read-only">read only</option><option value="project-write">project write</option></select></label>
          <label><span>Priority</span><select value={form.priority} onChange={event => set('priority', event.target.value as WorkFormState['priority'])}><option>P0</option><option>P1</option><option>P2</option><option>P3</option></select></label>
        </div>
        <div className="work-create-lists">
          <LineField label="Editable surfaces" value={form.editableSurfaces} onChange={value => set('editableSurfaces', value)} placeholder="One path per line" />
          <LineField label="Required checks" value={form.requiredChecks} onChange={value => set('requiredChecks', value)} placeholder="One command per line" />
          <LineField label="Stop conditions" value={form.stopConditions} onChange={value => set('stopConditions', value)} placeholder="When the agent must pause" />
          <LineField label="Evidence required" value={form.evidenceRequired} onChange={value => set('evidenceRequired', value)} placeholder="Evidence needed for completion" />
          <LineField label="Non-goals" value={form.nonGoals} onChange={value => set('nonGoals', value)} placeholder="Explicitly out of scope" />
        </div>
        <div className="work-create-submit"><span>Creates a draft only. Execution starts after operator action.</span><button className="btn" type="submit" disabled={create.isPending || !form.goal.trim()}><Plus size={14} /> {create.isPending ? 'Creating' : 'Create work'}</button></div>
        {create.error ? <div className="daily-error">Create failed: {String(create.error)}</div> : null}
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
  const plan = contract?.plan ?? [];
  const verifications = contract?.verifications ?? [];
  return <section className="contract-section plan-review">
    <div className="contract-section-heading"><h3>Plan review</h3><span>{contract?.planRevision ? `revision ${contract.planRevision}` : 'draft'}</span></div>
    {plan.length === 0 ? <p>No persisted plan yet.</p> : <ol className="plan-step-list">
      {plan.map((step, index) => <li key={`${step.id ?? 'step'}-${index}`} className="plan-step">
        <div className="plan-step-title"><strong>{step.title ?? step.id ?? `Step ${index + 1}`}</strong><span>{step.id ?? `step-${index + 1}`}</span></div>
        <p>{step.description ?? 'No description recorded.'}</p>
        <dl className="plan-step-facts">
          <div><dt>depends on</dt><dd>{step.dependsOnIds?.length ? step.dependsOnIds.join(', ') : 'none'}</dd></div>
          <div><dt>writable scope</dt><dd>{step.editableSurfaces?.length ? step.editableSurfaces.join(', ') : 'none declared'}</dd></div>
          <div><dt>done when</dt><dd>{step.completionCriteria ?? 'No completion criterion recorded.'}</dd></div>
        </dl>
      </li>)}
    </ol>}
    <div className="plan-verification-block">
      <h4>Verification mapping</h4>
      {verifications.length === 0 ? <p>No step-level verification mapping recorded.</p> : <ul>{verifications.map(requirement => <li key={requirement.id}><strong>{requirement.id}</strong><span>{requirement.description}</span>{requirement.command ? <code>{requirement.command}</code> : null}</li>)}</ul>}
    </div>
    {contract?.planHistory?.length ? <div className="plan-history"><h4>Revision history</h4><ol>{contract.planHistory.map(snapshot => <li key={snapshot.revision}><strong>revision {snapshot.revision}</strong><span>{snapshot.reason ?? 'superseded plan'}</span><time>{formatDate(snapshot.supersededAt)}</time></li>)}</ol></div> : null}
  </section>;
}

function Lineage({ item }: { item: WorkItemProjection }) {
  return <section className="contract-section lineage-section"><h3>Lineage</h3><dl><div><dt>work item</dt><dd>{item.id}</dd></div><div><dt>run spec</dt><dd>{item.evidence.latestRunSpecId ?? 'none'}</dd></div><div><dt>task run</dt><dd>{item.evidence.latestTaskRunId ?? 'none'}</dd></div><div><dt>session</dt><dd>{item.evidence.latestSessionId ?? 'none'}</dd></div></dl></section>;
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
