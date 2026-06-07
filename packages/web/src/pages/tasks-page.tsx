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
    <section className="panel-grid detail-grid">
      <div className="panel">
        <div className="panel-head">
          <div>
            <h2>Tasks</h2>
            <p>Scheduler records above chat sessions. Cancel is available only for active tasks.</p>
          </div>
          <div className="toolbar">
            <select value={statusFilter} onChange={event => setStatusFilter(event.target.value)}>
              <option value="">all status</option>
              <option value="queued">queued</option>
              <option value="running">running</option>
              <option value="succeeded">succeeded</option>
              <option value="failed">failed</option>
              <option value="cancelled">cancelled</option>
            </select>
            <button className={`ghost-btn ${showRunSpecs ? 'active' : ''}`} type="button" onClick={() => setShowRunSpecs(prev => !prev)}>
              <GitGraph size={14} /> run specs
            </button>
            <RefreshQueryButton queryKey={['tasks']} />
          </div>
        </div>
        <DataTable
          loading={tasks.isLoading}
          empty="No tasks yet."
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
              <span>{task.provider ?? 'default'} / {task.model ?? 'model?'}</span>
              <span>{task.nodeId ?? 'local'}</span>
              <span>{formatDate(task.updatedAt)}</span>
              <button className="tiny-btn" type="button" onClick={() => setSelectedTaskId(task.id)}>
                <Search size={12} /> inspect
              </button>
              <button className="tiny-btn" type="button" disabled={!['queued', 'running'].includes(task.status) || cancel.isPending} onClick={() => cancel.mutate(task.id)}>
                cancel
              </button>
            </div>
          )}
        />
        {showRunSpecs ? (
          <div className="section-divider">
            <div className="panel-head compact">
              <h2>Run Specs</h2>
              <RefreshQueryButton queryKey={['runs']} />
            </div>
            <DataTable
              loading={runSpecs.isLoading}
              empty="No run specs found."
              rows={runSpecs.data ?? []}
              renderRow={run => (
                <div className="record-row" key={run.id}>
                  <span className="row-title">{run.id}</span>
                  <span className={`status-text ${run.status}`}>{run.status}</span>
                  <span>session: {run.sessionId.slice(0, 12)}...</span>
                  <span>{formatDate(run.updatedAt)}</span>
                  <button className="tiny-btn" type="button" onClick={() => setSelectedTaskId(run.taskRunId ?? null)}>
                    <Search size={12} /> task
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
    return <aside className="panel inspector"><EmptyText text="Select a task to inspect run evidence and recovery state." /></aside>;
  }

  return (
    <aside className="panel inspector">
      <div className="panel-head compact">
        <h2>Task Run</h2>
        <span className={`status-text ${task.status}`}>{task.status}</span>
      </div>
      <span className="mono-chip">{task.id}</span>
      <div className="fact-list compact-facts">
        <Fact label="run spec" value={runSpecId ?? 'none'} />
        <Fact label="graph" value={graphId ?? 'none'} />
        <Fact label="session" value={task.sessionId} />
        <Fact label="trace" value={task.traceId} />
        <Fact label="attempt" value={String(task.attempt)} />
        <Fact label="node" value={task.nodeId ?? 'local'} />
        <Fact label="heartbeat" value={task.heartbeatAt ? formatDate(task.heartbeatAt) : 'none'} />
        {task.leaseExpiresAt ? <Fact label="lease expires" value={formatDate(task.leaseExpiresAt)} /> : null}
      </div>
      <div className="inline-actions">
        <button className="ghost-btn" type="button" disabled={!runSpecId || inspect.isPending} onClick={() => runSpecId && inspect.mutate(runSpecId)}>
          <Search size={14} /> inspect
        </button>
        <button className="ghost-btn" type="button" disabled={!runSpecId || recover.isPending} onClick={() => runSpecId && recover.mutate(runSpecId)}>
          <Database size={14} /> recover
        </button>
        <button className="ghost-btn" type="button" disabled={!runSpecId || verify.isPending} onClick={() => runSpecId && verify.mutate(runSpecId)}>
          <Send size={14} /> verify
        </button>
        <button className="ghost-btn" type="button" disabled={!graphId || agentGraph.isPending || agentGraphCompletion.isPending} onClick={() => { if (graphId) { agentGraph.mutate(graphId); agentGraphCompletion.mutate(graphId); } }}>
          <GitGraph size={14} /> graph
        </button>
      </div>
      {runState.data ? (
        <div className="fact-list compact-facts">
          <Fact label="phase" value={runState.data.phase} />
          <Fact label="next action" value={runState.data.action} />
          <Fact label="tasks" value={`${runState.data.counts.taskRuns.total ?? 0} total / ${(runState.data.counts.taskRuns.queued ?? 0) + (runState.data.counts.taskRuns.running ?? 0)} active`} />
          <Fact label="verification" value={`${runState.data.counts.verificationRecords.total ?? 0} total / ${runState.data.ids.pendingVerificationRecordIds.length + runState.data.ids.failedVerificationRecordIds.length} blocked`} />
        </div>
      ) : null}
      {runState.data?.blockers.length ? (
        <div className="json-block">
          <strong>Run State Blockers</strong>
          <pre>{runState.data.blockers.map(blocker => `${blocker.kind}: ${blocker.message}${blocker.ids.length ? ` [${blocker.ids.join(', ')}]` : ''}`).join('\n')}</pre>
        </div>
      ) : null}
      {graphCompletion ? <AgentGraphReadModel graph={agentGraph.data} completion={graphCompletion} /> : null}
      {latestResult ? (
        <div className="json-block">
          <strong>Run Operation Result</strong>
          <pre>{JSON.stringify(latestResult, null, 2)}</pre>
        </div>
      ) : (
        !graphCompletion ? <EmptyText text={runSpecId ? 'No run operation loaded.' : 'Task has no run spec link.'} /> : null
      )}
    </aside>
  );
}

function AgentGraphReadModel({ graph, completion }: { graph?: AgentTaskGraph; completion: AgentTaskGraphCompletion }) {
  const attempts = graph
    ? Object.entries(graph.attemptsByTaskId)
      .flatMap(([, items]) => items)
      .sort((a, b) => `${a.taskId}:${a.attempt}`.localeCompare(`${b.taskId}:${b.attempt}`))
    : [];

  return (
    <div className="graph-read-model">
      <div className="panel-head compact">
        <h2>Agent Task Graph</h2>
        <span className={`status-text ${completion.status}`}>{completion.status}</span>
      </div>
      <span className="mono-chip">{completion.graphId}</span>
      <div className="fact-list compact-facts">
        <Fact label="complete" value={completion.canComplete ? 'yes' : 'no'} />
        <Fact label="tasks" value={`${completion.counts.total} total / ${completion.counts.running} running`} />
        <Fact label="queued" value={String(completion.counts.queued)} />
        <Fact label="succeeded" value={String(completion.counts.succeeded)} />
        <Fact label="failed" value={String(completion.counts.failed + completion.counts.cancelled)} />
        <Fact label="verifier" value={`${completion.counts.succeededVerifier}/${completion.counts.verifier} succeeded`} />
      </div>
      <div className="json-block">
        <strong>Graph Completion</strong>
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
        <div className="json-block">
          <strong>Graph Tasks</strong>
          <pre>{graph.tasks.map(task => `${task.id} | ${task.role} | ${task.status} | attempts ${attempts.filter(attempt => attempt.taskId === task.id).length}/${task.maxAttempts}`).join('\n') || 'none'}</pre>
        </div>
      ) : null}
      {attempts.length > 0 ? (
        <div className="json-block">
          <strong>Attempt Evidence</strong>
          <pre>{attempts.map(attempt => `${attempt.taskId} #${attempt.attempt} ${attempt.status}${attempt.taskRunId ? ` taskRun=${attempt.taskRunId}` : ''}${attempt.verificationRecordId ? ` verification=${attempt.verificationRecordId}` : ''}${attempt.toolCallStateIds.length ? ` tools=${attempt.toolCallStateIds.join(',')}` : ''}`).join('\n')}</pre>
        </div>
      ) : null}
    </div>
  );
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

