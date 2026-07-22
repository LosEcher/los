import { useState, type Dispatch, type SetStateAction } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { GitMerge, Play, Plus, Search, Square, Trash2 } from 'lucide-react';
import {
  getJson,
  postJson,
  type AgentTaskGraph,
  type GovernedAgentTaskGraphResponse,
} from '../api';
import { EmptyText, Fact, Field } from '../ui';

type WorkerDraft = { title: string; surfaces: string };

const INITIAL_WORKERS: WorkerDraft[] = [
  { title: '', surfaces: '' },
  { title: '', surfaces: '' },
];

export function AgentGraphControl() {
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState(false);
  const [graphId, setGraphId] = useState('');
  const [runSpecId, setRunSpecId] = useState('');
  const [integrationOwner, setIntegrationOwner] = useState('local');
  const [workers, setWorkers] = useState<WorkerDraft[]>(INITIAL_WORKERS);
  const [verifierTitle, setVerifierTitle] = useState('Verify required checks and worker output');

  const graph = useQuery({
    queryKey: ['governed-agent-graph', graphId],
    queryFn: () => getJson<AgentTaskGraph>(`/agent-graphs/${graphId}/watch`),
    enabled: Boolean(graphId),
    refetchInterval: query => query.state.data?.control?.status === 'active' ? 2_000 : false,
  });
  const create = useMutation({
    mutationFn: () => postJson<GovernedAgentTaskGraphResponse>('/agent-graphs', {
      runSpecId,
      integrationOwner,
      maxParallelTasks: workers.length,
      workers: workers.map((worker, index) => ({
        title: worker.title || `Worker ${index + 1}`,
        editableSurfaces: splitSurfaces(worker.surfaces),
      })),
      verifier: { title: verifierTitle },
    }),
    onSuccess: response => {
      setGraphId(response.control.graphId);
      queryClient.setQueryData(['governed-agent-graph', response.control.graphId], {
        ...response.graph,
        control: response.control,
      });
    },
  });
  const run = useGraphAction(graphId, 'run');
  const cancel = useGraphAction(graphId, 'cancel', { reason: 'cancelled_from_tasks_page' });
  const integrate = useGraphAction(graphId, 'integrate', { note: 'integrated_from_tasks_page' });
  const current = graph.data;
  const control = current?.control;
  const active = control?.status === 'active';

  return (
    <div className="governed-graph-control">
      <div className="governed-graph-bar">
        <div className="governed-graph-title">
          <GitMerge size={15} />
          <strong>Governed Graph</strong>
          {control ? <span className={`status-text ${control.integrationStatus}`}>{control.integrationStatus}</span> : null}
        </div>
        <button className={`ghost-btn ${expanded ? 'active' : ''}`} type="button" onClick={() => setExpanded(value => !value)}>
          <Plus size={14} /> {expanded ? 'close' : 'create / open'}
        </button>
      </div>

      {expanded ? (
        <div className="governed-graph-form">
          <div className="governed-graph-open">
            <Field label="Graph id">
              <input value={graphId} onChange={event => setGraphId(event.target.value.trim())} placeholder="graph-..." />
            </Field>
            <button className="ghost-btn" type="button" disabled={!graphId} onClick={() => graph.refetch()}>
              <Search size={14} /> inspect
            </button>
          </div>
          <div className="field-grid governed-graph-fields">
            <Field label="Approved run spec">
              <input value={runSpecId} onChange={event => setRunSpecId(event.target.value)} placeholder="run-..." />
            </Field>
            <Field label="Integration owner">
              <input value={integrationOwner} onChange={event => setIntegrationOwner(event.target.value)} />
            </Field>
          </div>
          <div className="governed-worker-list">
            {workers.map((worker, index) => (
              <div className="governed-worker-row" key={index}>
                <span className="worker-index">{index + 1}</span>
                <input
                  aria-label={`Worker ${index + 1} title`}
                  value={worker.title}
                  onChange={event => updateWorker(index, 'title', event.target.value, setWorkers)}
                  placeholder="Worker title"
                />
                <input
                  aria-label={`Worker ${index + 1} editable surfaces`}
                  value={worker.surfaces}
                  onChange={event => updateWorker(index, 'surfaces', event.target.value, setWorkers)}
                  placeholder="packages/agent/src/..."
                />
                <button
                  className="icon-btn"
                  type="button"
                  aria-label={`Remove worker ${index + 1}`}
                  title="Remove worker"
                  disabled={workers.length <= 2}
                  onClick={() => setWorkers(items => items.filter((_, itemIndex) => itemIndex !== index))}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
          <div className="governed-graph-create-row">
            <button
              className="ghost-btn"
              type="button"
              disabled={workers.length >= 4}
              onClick={() => setWorkers(items => [...items, { title: '', surfaces: '' }])}
            >
              <Plus size={14} /> worker
            </button>
            <Field label="Verifier">
              <input value={verifierTitle} onChange={event => setVerifierTitle(event.target.value)} />
            </Field>
            <button
              className="primary-btn"
              type="button"
              disabled={!runSpecId || !integrationOwner || workers.some(worker => splitSurfaces(worker.surfaces).length === 0) || create.isPending}
              onClick={() => create.mutate()}
            >
              <Plus size={14} /> create graph
            </button>
          </div>
          {create.error ? <p className="form-error">{create.error.message}</p> : null}
        </div>
      ) : null}

      {current ? (
        <div className="governed-graph-watch">
          <div className="governed-graph-facts">
            <Fact label="graph" value={current.graphId} />
            <Fact label="owner" value={control?.integrationOwner ?? 'legacy graph'} />
            <Fact label="tasks" value={`${current.completion.counts.succeeded}/${current.completion.counts.total} succeeded`} />
            <Fact label="verifier" value={`${current.completion.counts.succeededVerifier}/${current.completion.counts.verifier}`} />
          </div>
          <div className="inline-actions governed-graph-actions">
            <button className="ghost-btn" type="button" disabled={!active || run.isPending} onClick={() => run.mutate()}>
              <Play size={14} /> run
            </button>
            <button className="ghost-btn danger" type="button" disabled={!active || cancel.isPending} onClick={() => cancel.mutate()}>
              <Square size={14} /> cancel
            </button>
            <button className="ghost-btn" type="button" disabled={control?.integrationStatus !== 'ready' || integrate.isPending} onClick={() => integrate.mutate()}>
              <GitMerge size={14} /> integrate
            </button>
          </div>
          <div className="governed-task-lines">
            {current.tasks.map(task => (
              <div className="governed-task-line" key={task.id}>
                <span className={`status-dot ${task.status}`} aria-hidden="true" />
                <span>{task.title}</span>
                <span>{task.role}</span>
                <span>{task.status}</span>
              </div>
            ))}
          </div>
          {graph.error || run.error || cancel.error || integrate.error ? (
            <p className="form-error">{(graph.error ?? run.error ?? cancel.error ?? integrate.error)?.message}</p>
          ) : null}
        </div>
      ) : graphId && !graph.isLoading ? <EmptyText text="Graph evidence is unavailable." /> : null}
    </div>
  );
}

function useGraphAction(graphId: string, action: 'run' | 'cancel' | 'integrate', body: Record<string, unknown> = {}) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => postJson<GovernedAgentTaskGraphResponse>(`/agent-graphs/${graphId}/${action}`, body),
    onSuccess: response => queryClient.setQueryData(['governed-agent-graph', graphId], {
      ...response.graph,
      control: response.control,
    }),
  });
}

function splitSurfaces(value: string): string[] {
  return [...new Set(value.split(',').map(item => item.trim()).filter(Boolean))];
}

function updateWorker(
  index: number,
  key: keyof WorkerDraft,
  value: string,
  setWorkers: Dispatch<SetStateAction<WorkerDraft[]>>,
) {
  setWorkers(items => items.map((item, itemIndex) => itemIndex === index ? { ...item, [key]: value } : item));
}
