import { useState, useMemo, type ChangeEvent } from 'react';
import { metadataText } from '../chat-helpers.js';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Archive,
  Copy,
  Database,
  FileText,
  GitGraph,
  Layers,
  RotateCcw,
  Search,
  Send,
  SlidersHorizontal,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import {
  deleteJson,
  getJson,
  patchJson,
  postJson,
  type AgentTaskGraph,
  type AgentTaskGraphCompletion,
  type AgentTaskGraphTask,
  type AgentTaskGraphEdge,
  type MemoryObservation,
  type MemoryResponse,
  type MemoryStats,
  type ProviderDiscovery,
  type ProviderDiscoveryProvider,
  type ProviderModelsResponse,
  type ProviderReadiness,
  type RunSpec,
  type SessionDetail,
  type SessionEvent,
  type SessionEventsResponse,
  type SessionObservability,
  type SessionSummary,
  type TaskRun,
  type TodoItem,
} from '../api';
import {
  DataTable,
  Definition,
  EmptyText,
  Fact,
  Field,
  formatDate,
  formatTime,
  RefreshQueryButton,
  StatusPill,
} from '../ui';
import { AgentGraphControl } from './agent-graph-control.js';
import { useI18n } from '../i18n';

type RunStateProjection = {
  phase: string;
  action: string;
  blockers: Array<{ kind: string; message: string; ids: string[] }>;
  counts: {
    taskRuns: Record<string, number>;
    verificationRecords: Record<string, number>;
  };
  ids: {
    failedVerificationRecordIds: string[];
    pendingVerificationRecordIds: string[];
  };
};
export function TasksPage({ onSelectSession }: { onSelectSession: (id: string) => void }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [showRunSpecs, setShowRunSpecs] = useState(false);
  const [statusFilter, setStatusFilter] = useState('');
  const tasks = useQuery({
    queryKey: ['tasks', statusFilter],
    queryFn: () => {
      const params = new URLSearchParams();
      if (statusFilter) params.set('status', statusFilter);
      return getJson<TaskRun[]>(`/tasks?${params.toString()}`);
    },
    refetchInterval: 8_000,
  });
  const runSpecs = useQuery({
    queryKey: ['runs'],
    queryFn: () => getJson<RunSpec[]>('/runs'),
    refetchInterval: 10_000,
    enabled: showRunSpecs,
  });
  const selectedTask = (tasks.data ?? []).find(task => task.id === selectedTaskId) ?? null;
  const cancel = useMutation({
    mutationFn: (id: string) => postJson(`/tasks/${id}/cancel`, { reason: 'cancelled_from_tasks_page' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['tasks'] }),
  });

  return (
    <section className="panel-grid detail-grid ops-page">
      <div className="panel">
        <div className="panel-head">
          <div>
            <h2>{t('ops.tasks.title')}</h2>
            <p>{t('ops.tasks.subtitle')}</p>
          </div>
          <div className="toolbar">
            <select className="filter-select" value={statusFilter} onChange={event => setStatusFilter(event.target.value)}>
              <option value="">{t('ops.tasks.filterAllStatus')}</option>
              <option value="queued">{t('ops.tasks.statusQueued')}</option>
              <option value="running">{t('ops.tasks.statusRunning')}</option>
              <option value="succeeded">{t('ops.tasks.statusSucceeded')}</option>
              <option value="failed">{t('ops.tasks.statusFailed')}</option>
              <option value="cancelled">{t('ops.tasks.statusCancelled')}</option>
            </select>
            <button className={`ghost-btn ${showRunSpecs ? 'active' : ''}`} type="button" onClick={() => setShowRunSpecs(prev => !prev)}>
              <GitGraph size={14} /> {t('ops.tasks.runSpecsButton')}
            </button>
            <RefreshQueryButton queryKey={['tasks']} />
          </div>
        </div>
        <AgentGraphControl />
        <DataTable
          loading={tasks.isLoading}
          empty={t('ops.tasks.empty')}
          rows={tasks.data ?? []}
          renderRow={task => (
            <div className="record-row task-row" data-active={selectedTaskId === task.id}>
              <div className="task-main">
                <button type="button" className="link-cell" onClick={() => onSelectSession(task.sessionId)}>
                  {task.id}
                </button>
                <span>{task.promptPreview}</span>
              </div>
              <span className={`status-text ${task.status}`}>{task.status}</span>
              <span>{task.toolMode}</span>
              <span>{task.provider ?? t('ops.tasks.fallbackDefault')} / {task.model ?? t('ops.tasks.fallbackModel')}</span>
              <span>{task.nodeId ?? t('ops.tasks.fallbackLocal')}</span>
              <span>{formatDate(task.updatedAt)}</span>
              <button className="tiny-btn" type="button" onClick={() => setSelectedTaskId(task.id)}>
                <Search size={12} /> {t('ops.tasks.inspect')}
              </button>
              <button className="tiny-btn" type="button" disabled={!['queued', 'running'].includes(task.status) || cancel.isPending} onClick={() => cancel.mutate(task.id)}>
                {t('common.cancel')}
              </button>
            </div>
          )}
        />
        {showRunSpecs ? (
          <div className="section-divider">
            <div className="panel-head compact">
              <h2>{t('ops.runSpecs.title')}</h2>
              <RefreshQueryButton queryKey={['runs']} />
            </div>
            <DataTable
              loading={runSpecs.isLoading}
              empty={t('ops.runSpecs.empty')}
              rows={runSpecs.data ?? []}
              renderRow={run => (
                <div className="record-row" key={run.id}>
                  <span className="row-title">{run.id}</span>
                  <span className={`status-text ${run.status}`}>{run.status}</span>
                  <span>{t('ops.tasks.sessionShort', { sessionId: run.sessionId.slice(0, 12) })}</span>
                  <span>{formatDate(run.updatedAt)}</span>
                  <button className="tiny-btn" type="button" onClick={() => setSelectedTaskId(run.taskRunId ?? null)}>
                    <Search size={12} /> {t('ops.tasks.taskButton')}
                  </button>
                </div>
              )}
            />
          </div>
        ) : null}
      </div>
      <TaskRunInspector task={selectedTask} />
    </section>
  );
}

function TaskRunInspector({ task }: { task: TaskRun | null }) {
  const { t } = useI18n();
  const inspect = useMutation({
    mutationFn: (runSpecId: string) => getJson(`/runs/${runSpecId}/inspect`),
  });
  const recover = useMutation({
    mutationFn: (runSpecId: string) => postJson(`/runs/${runSpecId}/recover`, {}),
  });
  const verify = useMutation({
    mutationFn: (runSpecId: string) => postJson(`/runs/${runSpecId}/verify`, {}),
  });
  const agentGraph = useMutation({
    mutationFn: (graphId: string) => getJson<AgentTaskGraph>(`/agent-graphs/${graphId}`),
  });
  const agentGraphCompletion = useMutation({
    mutationFn: (graphId: string) => getJson<AgentTaskGraphCompletion>(`/agent-graphs/${graphId}/completion`),
  });
  const runSpecId = task?.runSpecId;
  const graphId = task ? agentGraphIdForTask(task) : null;
  const runState = useQuery({
    queryKey: ['run-state', runSpecId],
    queryFn: () => getJson<RunStateProjection>(`/runs/${runSpecId}/state`),
    enabled: Boolean(runSpecId),
    refetchInterval: 10_000,
  });
  const latestResult = verify.data ?? recover.data ?? inspect.data;
  const graphCompletion = agentGraph.data?.completion ?? agentGraphCompletion.data;

  if (!task) {
    return <aside className="panel inspector"><EmptyText text={t('ops.tasks.inspectorEmpty')} /></aside>;
  }

  return (
    <aside className="panel inspector">
      <div className="panel-head compact">
        <h2>{t('ops.tasks.inspectorTitle')}</h2>
        <span className={`status-text ${task.status}`}>{task.status}</span>
      </div>
      <span className="mono-chip">{task.id}</span>
      <div className="fact-list compact-facts">
        <Fact label={t('ops.tasks.factRunSpec')} value={runSpecId ?? t('common.none')} />
        <Fact label={t('ops.tasks.factGraph')} value={graphId ?? t('common.none')} />
        <Fact label={t('ops.tasks.factSession')} value={task.sessionId} />
        <Fact label={t('ops.tasks.factTrace')} value={task.traceId} />
        <Fact label={t('ops.tasks.factAttempt')} value={String(task.attempt)} />
        <Fact label={t('ops.tasks.factNode')} value={task.nodeId ?? t('ops.tasks.fallbackLocal')} />
        <Fact label={t('ops.tasks.factHeartbeat')} value={task.heartbeatAt ? formatDate(task.heartbeatAt) : t('common.none')} />
        {task.leaseExpiresAt ? <Fact label={t('ops.tasks.factLeaseExpires')} value={formatDate(task.leaseExpiresAt)} /> : null}
      </div>
      <div className="inline-actions">
        <button className="ghost-btn" type="button" disabled={!runSpecId || inspect.isPending} onClick={() => runSpecId && inspect.mutate(runSpecId)}>
          <Search size={14} /> {t('ops.tasks.inspect')}
        </button>
        <button className="ghost-btn" type="button" disabled={!runSpecId || recover.isPending} onClick={() => runSpecId && recover.mutate(runSpecId)}>
          <Database size={14} /> {t('ops.tasks.recover')}
        </button>
        <button className="ghost-btn" type="button" disabled={!runSpecId || verify.isPending} onClick={() => runSpecId && verify.mutate(runSpecId)}>
          <Send size={14} /> {t('ops.tasks.verify')}
        </button>
        <button className="ghost-btn" type="button" disabled={!graphId || agentGraph.isPending || agentGraphCompletion.isPending} onClick={() => { if (graphId) { agentGraph.mutate(graphId); agentGraphCompletion.mutate(graphId); } }}>
          <GitGraph size={14} /> {t('ops.tasks.graphButton')}
        </button>
      </div>
      {runState.data ? (
        <div className="fact-list compact-facts">
          <Fact label={t('ops.tasks.factPhase')} value={runState.data.phase} />
          <Fact label={t('ops.tasks.factNextAction')} value={runState.data.action} />
          <Fact label={t('ops.tasks.factTasks')} value={t('ops.tasks.factTasksValue', { total: runState.data.counts.taskRuns.total ?? 0, active: (runState.data.counts.taskRuns.queued ?? 0) + (runState.data.counts.taskRuns.running ?? 0) })} />
          <Fact label={t('ops.tasks.factVerification')} value={t('ops.tasks.factVerificationValue', { total: runState.data.counts.verificationRecords.total ?? 0, blocked: runState.data.ids.pendingVerificationRecordIds.length + runState.data.ids.failedVerificationRecordIds.length })} />
        </div>
      ) : null}
      {runState.data?.blockers.length ? (
        <div className="json-block">
          <strong>{t('ops.tasks.blockersTitle')}</strong>
          <pre>{(runState.data.blockers ?? []).map(blocker => `${blocker.kind}: ${blocker.message}${blocker.ids.length ? ` [${blocker.ids.join(', ')}]` : ''}`).join('\n')}</pre>
        </div>
      ) : null}
      {graphCompletion ? <AgentGraphReadModel graph={agentGraph.data} completion={graphCompletion} /> : null}
      {latestResult ? (
        <div className="json-block">
          <strong>{t('ops.tasks.operationResultTitle')}</strong>
          <pre>{JSON.stringify(latestResult, null, 2)}</pre>
        </div>
      ) : (
        !graphCompletion ? <EmptyText text={runSpecId ? t('ops.tasks.noOperationLoaded') : t('ops.tasks.noRunSpecLink')} /> : null
      )}
    </aside>
  );
}

function AgentGraphReadModel({ graph, completion }: { graph?: AgentTaskGraph; completion: AgentTaskGraphCompletion }) {
  const { t } = useI18n();
  const attempts = graph
    ? Object.entries(graph.attemptsByTaskId ?? {})
      .flatMap(([, items]) => items)
      .sort((a, b) => `${a.taskId}:${a.attempt}`.localeCompare(`${b.taskId}:${b.attempt}`))
    : [];

  return (
    <div className="graph-read-model">
      <div className="panel-head compact">
        <h2>{t('ops.tasks.agentGraphTitle')}</h2>
        <span className={`status-text ${completion.status}`}>{completion.status}</span>
      </div>
      <span className="mono-chip">{completion.graphId}</span>
      <div className="fact-list compact-facts">
        <Fact label={t('ops.tasks.factComplete')} value={completion.canComplete ? t('ops.tasks.yes') : t('ops.tasks.no')} />
        <Fact label={t('ops.tasks.factTasks')} value={t('ops.tasks.graphTasksValue', { total: completion.counts.total, running: completion.counts.running })} />
        <Fact label={t('ops.tasks.factQueued')} value={String(completion.counts.queued)} />
        <Fact label={t('ops.tasks.factSucceeded')} value={String(completion.counts.succeeded)} />
        <Fact label={t('ops.tasks.factFailed')} value={String(completion.counts.failed + completion.counts.cancelled)} />
        <Fact label={t('ops.tasks.factVerifier')} value={t('ops.tasks.graphVerifierValue', { succeeded: completion.counts.succeededVerifier, total: completion.counts.verifier })} />
      </div>
      <div className="json-block">
        <strong>{t('ops.tasks.graphCompletionTitle')}</strong>
        <pre>{[
          `reason: ${completion.reason}`,
          completion.blockReason ? `blockReason: ${completion.blockReason}` : '',
          `ready: ${formatIdList(completion.readyTaskIds)}`,
          `waiting: ${formatIdList(completion.waitingTaskIds)}`,
          `running: ${formatIdList(completion.runningTaskIds)}`,
          `blocked: ${formatIdList(completion.blockedTaskIds)}`,
          `failed: ${formatIdList([...completion.failedTaskIds, ...completion.failedVerifierTaskIds])}`,
          `verifier: ${formatIdList(completion.verifierTaskIds)}`,
        ].filter(Boolean).join('\n')}</pre>
      </div>
      {graph ? (
        <>
        <div className="json-block">
          <strong>{t('ops.tasks.dependencyTreeTitle')}</strong>
          <pre>{buildDependencyTree(graph.tasks ?? [], graph.edges ?? [], t)}</pre>
        </div>
        <div className="json-block">
          <strong>{t('ops.tasks.graphTasksTitle')}</strong>
          <pre>{(graph.tasks ?? []).map(task => `${task.id} | ${task.role} | ${task.status} | attempts ${attempts.filter(attempt => attempt.taskId === task.id).length}/${task.maxAttempts}`).join('\n') || 'none'}</pre>
        </div>
        </>
      ) : null}
      {attempts.length > 0 ? (
        <div className="json-block">
          <strong>{t('ops.tasks.attemptEvidenceTitle')}</strong>
          <pre>{attempts.map(attempt => `${attempt.taskId} #${attempt.attempt} ${attempt.status}${attempt.taskRunId ? ` taskRun=${attempt.taskRunId}` : ''}${attempt.verificationRecordId ? ` verification=${attempt.verificationRecordId}` : ''}${attempt.toolCallStateIds.length ? ` tools=${attempt.toolCallStateIds.join(',')}` : ''}`).join('\n')}</pre>
        </div>
      ) : null}
    </div>
  );
}


function buildDependencyTree(
  tasks: AgentTaskGraphTask[],
  edges: AgentTaskGraphEdge[],
  tr: (key: string, vars?: Record<string, string | number>) => string,
): string {
  if (edges.length === 0) return tr('ops.tasks.noDependencies');
  const taskMap = new Map(tasks.map(t => [t.id, t]));
  const children = new Map<string, string[]>();
  const parents = new Set<string>();
  for (const edge of edges) {
    const list = children.get(edge.dependsOnTaskId) ?? [];
    list.push(edge.taskId);
    children.set(edge.dependsOnTaskId, list);
    parents.add(edge.taskId);
  }
  const roots = tasks.filter(t => !parents.has(t.id));
  const lines: string[] = [];
  function render(id: string, indent: number) {
    const task = taskMap.get(id);
    const prefix = '  '.repeat(indent) + (indent > 0 ? '↳ ' : '');
    lines.push(`${prefix}${id} ${task ? `[${task.role}] ${task.status}` : ''}`);
    for (const child of (children.get(id) ?? [])) render(child, indent + 1);
  }
  for (const root of roots) render(root.id, 0);
  const rendered = new Set<string>();
  function collect(id: string) { rendered.add(id); for (const c of children.get(id) ?? []) collect(c); }
  for (const root of roots) collect(root.id);
  const unrendered = tasks.filter(t => !rendered.has(t.id));
  if (unrendered.length > 0) lines.push(tr('ops.tasks.orphanedLine', { ids: unrendered.map(t => t.id).join(', ') }));
  return lines.join('\n');
}

function agentGraphIdForTask(task: TaskRun): string | null {
  const metadata = task.metadata ?? {};
  const nestedGraph = metadata.graph && typeof metadata.graph === 'object' && !Array.isArray(metadata.graph)
    ? (metadata.graph as Record<string, unknown>).id
    : undefined;
  return [
    metadata.graphId,
    metadata.agentGraphId,
    metadata.agentTaskGraphId,
    nestedGraph,
  ].map(metadataText).find(Boolean) ?? null;
}

function formatIdList(ids: string[]): string {
  return ids.length > 0 ? ids.join(', ') : 'none';
}

type CompactionRecord = {
  id: string;
  sessionId: string;
  summary: Record<string, unknown>;
  observedPatterns: Record<string, unknown>[];
  proceduralCandidates: Record<string, unknown>[];
  confidence: number;
  evidenceCount: number;
  createdBy?: string;
  createdAt: string;
};
