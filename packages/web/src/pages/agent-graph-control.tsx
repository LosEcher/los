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
import { useI18n } from '../i18n';

type WorkerDraft = { title: string; surfaces: string };

const INITIAL_WORKERS: WorkerDraft[] = [
  { title: '', surfaces: '' },
  { title: '', surfaces: '' },
];

export function AgentGraphControl() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState(false);
  const [graphId, setGraphId] = useState('');
  const [runSpecId, setRunSpecId] = useState('');
  const [workers, setWorkers] = useState<WorkerDraft[]>(INITIAL_WORKERS);
  const [verifierTitle, setVerifierTitle] = useState(() => t('ops.graph.verifierTitleDefault'));

  const graph = useQuery({
    queryKey: ['governed-agent-graph', graphId],
    queryFn: () => getJson<AgentTaskGraph>(`/agent-graphs/${graphId}/watch`),
    enabled: Boolean(graphId),
    refetchInterval: query => query.state.data?.control?.status === 'active' ? 2_000 : false,
  });
  const create = useMutation({
    mutationFn: () => postJson<GovernedAgentTaskGraphResponse>('/agent-graphs', {
      runSpecId,
      maxParallelTasks: workers.length,
      workers: workers.map((worker, index) => ({
        title: worker.title || t('ops.graph.workerDefaultTitle', { index: index + 1 }),
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
          <div><strong>{t('ops.graph.title')}</strong><small>{t('ops.graph.subtitle')}</small></div>
          {control ? <span className={`status-text ${control.integrationStatus}`}>{graphStatusLabel(control.integrationStatus, t)}</span> : null}
        </div>
        <button className={`ghost-btn ${expanded ? 'active' : ''}`} type="button" onClick={() => setExpanded(value => !value)}>
          <Plus size={14} /> {expanded ? t('common.close') : t('ops.graph.openOrCreate')}
        </button>
      </div>

      {expanded ? (
        <div className="governed-graph-form">
          <div className="governed-graph-open">
            <Field label={t('ops.graph.openExistingLabel')}>
              <input value={graphId} onChange={event => setGraphId(event.target.value.trim())} placeholder={t('ops.graph.graphIdPlaceholder')} />
            </Field>
            <button className="ghost-btn" type="button" disabled={!graphId} onClick={() => graph.refetch()}>
              <Search size={14} /> {t('ops.graph.openGraphButton')}
            </button>
          </div>
          <p className="governed-graph-help">{t('ops.graph.helpIntro')} <b>integrate</b> {t('ops.graph.helpTail')}</p>
          <Field label={t('ops.graph.runSpecLabel')}>
            <input value={runSpecId} onChange={event => setRunSpecId(event.target.value)} placeholder="run-..." />
          </Field>
          <div className="governed-worker-list">
            {workers.map((worker, index) => (
              <div className="governed-worker-row" key={index}>
                <span className="worker-index">{index + 1}</span>
                <input
                  aria-label={t('ops.graph.workerTitleAria', { index: index + 1 })}
                  value={worker.title}
                  onChange={event => updateWorker(index, 'title', event.target.value, setWorkers)}
                  placeholder={t('ops.graph.workerTitlePlaceholder')}
                />
                <input
                  aria-label={t('ops.graph.workerSurfacesAria', { index: index + 1 })}
                  value={worker.surfaces}
                  onChange={event => updateWorker(index, 'surfaces', event.target.value, setWorkers)}
                  placeholder="packages/agent/src/..."
                />
                <button
                  className="icon-btn"
                  type="button"
                  aria-label={t('ops.graph.removeWorkerAria', { index: index + 1 })}
                  title={t('ops.graph.removeWorkerTitle')}
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
              <Plus size={14} /> {t('ops.graph.addWorkerButton')}
            </button>
            <Field label={t('ops.graph.verifierLabel')}>
              <input value={verifierTitle} onChange={event => setVerifierTitle(event.target.value)} />
            </Field>
            <button
              className="primary-btn"
              type="button"
              disabled={!runSpecId || workers.some(worker => splitSurfaces(worker.surfaces).length === 0) || create.isPending}
              onClick={() => create.mutate()}
            >
              <Plus size={14} /> {t('ops.graph.createGraphButton')}
            </button>
          </div>
          {create.error ? <p className="form-error">{create.error.message}</p> : null}
        </div>
      ) : null}

      {current ? (
        <div className="governed-graph-watch">
          <div className="governed-graph-facts">
            <Fact label={t('ops.tasks.factGraph')} value={current.graphId} />
            <Fact label={t('ops.graph.factOwner')} value={control?.integrationOwner ?? t('ops.graph.legacyGraph')} />
            <Fact label={t('ops.graph.factWorkerProgress')} value={t('ops.graph.workerProgressValue', { succeeded: current.completion.counts.succeeded, total: current.completion.counts.total })} />
            <Fact label={t('ops.graph.factVerifier')} value={t('ops.graph.verifierPassedValue', { succeeded: current.completion.counts.succeededVerifier, total: current.completion.counts.verifier })} />
          </div>
          <div className="inline-actions governed-graph-actions">
            <button className="ghost-btn" type="button" disabled={!active || run.isPending} onClick={() => run.mutate()}>
              <Play size={14} /> {t('ops.graph.runWorkersButton')}
            </button>
            <button className="ghost-btn danger" type="button" disabled={!active || cancel.isPending} onClick={() => cancel.mutate()}>
              <Square size={14} /> {t('ops.graph.stopGraphButton')}
            </button>
            <button className="ghost-btn" type="button" disabled={control?.integrationStatus !== 'ready' || integrate.isPending} onClick={() => integrate.mutate()}>
              <GitMerge size={14} /> {t('ops.graph.confirmIntegrationButton')}
            </button>
          </div>
          <div className="governed-task-lines">
            {current.tasks.map(task => (
              <div className="governed-task-line" key={task.id}>
                <span className={`status-dot ${task.status}`} aria-hidden="true" />
                <span>{task.title}</span>
                <span>{roleLabel(task.role, t)}</span>
                <span>{taskStatusLabel(task.status, t)}</span>
              </div>
            ))}
          </div>
          {graph.error || run.error || cancel.error || integrate.error ? (
            <p className="form-error">{(graph.error ?? run.error ?? cancel.error ?? integrate.error)?.message}</p>
          ) : null}
        </div>
      ) : graphId && !graph.isLoading ? <EmptyText text={t('ops.graph.evidenceUnavailable')} /> : null}
    </div>
  );
}

function graphStatusLabel(status: string, t: (key: string) => string): string {
  switch (status) {
    case 'pending_verification': return t('ops.graph.integrationWaiting');
    case 'ready': return t('ops.graph.integrationReady');
    case 'integrated': return t('ops.graph.integrationConfirmed');
    case 'cancelled': return t('ops.graph.integrationCancelled');
    default: return status.replaceAll('_', ' ');
  }
}

function roleLabel(role: string, t: (key: string) => string): string {
  if (role === 'executor') return t('ops.graph.roleWorker');
  if (role === 'verifier') return t('ops.graph.roleVerifier');
  return role;
}

function taskStatusLabel(status: string, t: (key: string) => string): string {
  if (status === 'succeeded') return t('ops.graph.statusPassed');
  if (status === 'queued') return t('ops.graph.statusWaiting');
  if (status === 'running') return t('ops.graph.statusWorking');
  return status;
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
