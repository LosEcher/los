import { type FormEvent, useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { GitBranchPlus, RefreshCcw, Send } from 'lucide-react';
import {
  getJson,
  patchJson,
  postJson,
  type TodoItem,
  type TodoKind,
  type TodoPayload,
  type TodoPriority,
  type TodoStatus,
} from './api';
import {
  DataTable,
  Definition,
  EmptyText,
  Fact,
  Field,
  formatDate,
} from './ui';
import { useI18n } from './i18n';

const TODO_STATUSES: TodoStatus[] = ['backlog', 'ready', 'in_progress', 'blocked', 'done', 'cancelled'];
const TODO_KINDS: TodoKind[] = ['problem', 'solution', 'plan', 'phase', 'task', 'batch'];
const TODO_PRIORITIES: TodoPriority[] = ['P0', 'P1', 'P2', 'P3'];
const LINK_FILTERS = ['sessionId', 'taskRunId', 'traceId', 'requestId', 'stageId', 'source', 'batchKey'] as const;
type LinkFilter = typeof LINK_FILTERS[number];

export function TodosPage({
  selectedTodoId,
  onTodoSelect,
  onRunTodo,
  onSelectSession,
}: {
  selectedTodoId: string | null;
  onTodoSelect: (id: string) => void;
  onRunTodo: (todo: TodoItem) => void;
  onSelectSession: (id: string) => void;
}) {
  const queryClient = useQueryClient();
  const { t } = useI18n();
  const [status, setStatus] = useState('');
  const [kind, setKind] = useState('');
  const [includeArchived, setIncludeArchived] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(selectedTodoId);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<TodoPriority>('P1');
  const [newKind, setNewKind] = useState<TodoKind>('task');
  const [dependsOn, setDependsOn] = useState('');
  const [linkFilter, setLinkFilter] = useState<LinkFilter>('sessionId');
  const [linkValue, setLinkValue] = useState('');

  const query = new URLSearchParams();
  if (status) query.set('status', status);
  if (kind) query.set('kind', kind);
  if (linkValue.trim()) query.set(linkFilter, linkValue.trim());
  if (includeArchived) query.set('includeArchived', 'true');
  query.set('limit', '200');

  const todos = useQuery({
    queryKey: ['todos', status, kind, includeArchived],
    queryFn: () => getJson<TodoItem[]>(`/todos?${query.toString()}`),
    refetchInterval: 10_000,
  });

  const selected = (todos.data ?? []).find(todo => todo.id === selectedId) ?? todos.data?.[0] ?? null;
  const counts = summarizeTodos(todos.data ?? []);

  useEffect(() => {
    if (selectedTodoId) setSelectedId(selectedTodoId);
  }, [selectedTodoId]);

  const create = useMutation({
    mutationFn: (payload: TodoPayload) => postJson<TodoItem>('/todos', payload),
    onSuccess: async (todo) => {
      setTitle('');
      setDescription('');
      setDependsOn('');
      setSelectedId(todo.id);
      onTodoSelect(todo.id);
      await queryClient.invalidateQueries({ queryKey: ['todos'] });
    },
  });
  const update = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Partial<TodoItem> }) => patchJson<TodoItem>(`/todos/${id}`, body),
    onSuccess: async (todo) => {
      setSelectedId(todo.id);
      onTodoSelect(todo.id);
      await queryClient.invalidateQueries({ queryKey: ['todos'] });
    },
  });
  const seed = useMutation({
    mutationFn: () => postJson('/todos/seed', {}),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['todos'] }),
  });

  function createTodo(event: FormEvent) {
    event.preventDefault();
    if (!title.trim()) return;
    create.mutate({
      title,
      description,
      kind: newKind,
      priority,
      status: 'backlog',
      tenantId: 'local',
      projectId: 'los',
      source: 'web-console',
      dependsOnIds: parseTodoIds(dependsOn),
      metadata: {
        dispatchReady: false,
        planningSurface: 'todos',
      },
    });
  }

  return (
    <section className="panel-grid todo-grid">
      <div className="panel">
        <div className="panel-head">
          <div>
            <h2>{t('assets.todo.title')}</h2>
            <p>{t('assets.todo.subtitle')}</p>
          </div>
          <div className="toolbar">
            <select value={status} onChange={event => setStatus(event.target.value)}>
              <option value="">{t('assets.todo.allStatus')}</option>
              {TODO_STATUSES.map(item => <option key={item} value={item}>{item}</option>)}
            </select>
            <select value={kind} onChange={event => setKind(event.target.value)}>
              <option value="">{t('assets.todo.allKinds')}</option>
              {TODO_KINDS.map(item => <option key={item} value={item}>{item}</option>)}
            </select>
            <select value={linkFilter} onChange={event => setLinkFilter(event.target.value as LinkFilter)}>
              {LINK_FILTERS.map(item => <option key={item} value={item}>{item}</option>)}
            </select>
            <input value={linkValue} onChange={event => setLinkValue(event.target.value)} placeholder={t('assets.todo.linkValuePh')} />
            <label className="toolbar-toggle">
              <input type="checkbox" checked={includeArchived} onChange={event => setIncludeArchived(event.target.checked)} />
              {t('assets.label.archived')}
            </label>
            <button className="ghost-btn" type="button" onClick={() => seed.mutate()} disabled={seed.isPending}>
              <RefreshCcw size={14} /> {t('assets.todo.seed')}
            </button>
          </div>
        </div>

        <div className="todo-summary">
          <Fact label={t('assets.label.ready')} value={String(counts.ready)} />
          <Fact label={t('assets.label.active')} value={String(counts.inProgress)} />
          <Fact label={t('assets.label.blocked')} value={String(counts.blocked)} />
          <Fact label={t('assets.label.archived')} value={String(counts.archived)} />
          <Fact label={t('assets.label.deps')} value={String(counts.withDependencies)} />
        </div>

        <DataTable
          loading={todos.isLoading}
          empty={t('assets.todo.emptyList')}
          rows={todos.data ?? []}
          renderRow={todo => (
            <button
              type="button"
              className="record-row todo-row"
              data-active={selected?.id === todo.id}
              onClick={() => {
                setSelectedId(todo.id);
                onTodoSelect(todo.id);
              }}
            >
              <span className="todo-main">
                <strong>{todo.title}</strong>
                <em>{todo.tenantId}/{todo.projectId} · {todo.stageId ?? t('assets.todo.noStage')} · {todo.source}{todo.archivedAt ? ` ${t('assets.todo.rowArchived', { date: formatDate(todo.archivedAt) })}` : ''}</em>
              </span>
              <span className={`priority-text ${todo.priority}`}>{todo.priority}</span>
              <span className={`status-text ${todo.status}`}>{todo.status}</span>
              <span>{todo.kind}</span>
              <span>{formatDate(todo.updatedAt)}</span>
            </button>
          )}
        />
      </div>

      <aside className="panel inspector">
        <div className="panel-head compact">
          <h2>{t('assets.todo.detailTitle')}</h2>
          {selected ? <span className="mono-chip">{selected.id}</span> : null}
        </div>
        {selected ? (
          <>
            <div className="todo-detail">
              <h3>{selected.title}</h3>
              <p>{selected.description || t('assets.todo.noDescription')}</p>
              <div className="fact-list compact-facts">
                <Fact label={t('assets.label.tenant')} value={selected.tenantId} />
                <Fact label={t('assets.label.project')} value={selected.projectId} />
                <Fact label={t('assets.label.stage')} value={selected.stageId ?? t('common.none')} />
                <Fact label={t('assets.label.trace')} value={selected.traceId ?? t('assets.todo.notLinked')} />
                <Fact label={t('assets.label.request')} value={selected.requestId ?? t('assets.todo.notLinked')} />
                <Fact label={t('assets.label.task')} value={selected.taskRunId ?? t('assets.todo.notDispatched')} />
                <Fact label={t('assets.label.dependsOn')} value={selected.dependsOnIds.join(', ') || t('common.none')} />
                <Fact label={t('assets.label.blockedBy')} value={selected.blockedByIds.join(', ') || t('common.none')} />
                <Fact label={t('assets.label.archive')} value={selected.archivedAt ? t('assets.todo.archiveValue', { date: formatDate(selected.archivedAt), reason: selected.archiveReason ?? t('assets.label.archived') }) : t('assets.label.active')} />
              </div>
              <div className="todo-actions">
                <button className="tiny-btn" type="button" onClick={() => onRunTodo(selected)}>
                  <Send size={12} /> {t('assets.todo.run')}
                </button>
                <button className="tiny-btn" type="button" disabled={!selected.sessionId} onClick={() => selected.sessionId && onSelectSession(selected.sessionId)}>
                  {t('assets.label.session')}
                </button>
                <button className="tiny-btn" type="button" onClick={() => update.mutate({ id: selected.id, body: { status: 'ready' } })}>{t('assets.label.ready')}</button>
                <button className="tiny-btn" type="button" onClick={() => update.mutate({ id: selected.id, body: { status: 'in_progress' } })}>{t('assets.todo.start')}</button>
                <button className="tiny-btn" type="button" onClick={() => update.mutate({ id: selected.id, body: { status: 'blocked' } })}>{t('assets.todo.block')}</button>
                <button className="tiny-btn" type="button" onClick={() => update.mutate({ id: selected.id, body: { status: 'done' } })}>{t('assets.todo.done')}</button>
                <button className="tiny-btn" type="button" onClick={() => postJson(`/todos/${selected.id}/reopen`, {}).then(() => queryClient.invalidateQueries({ queryKey: ['todos'] }))}>{t('assets.todo.reopen')}</button>
                <button className="tiny-btn" type="button" onClick={() => postJson(`/todos/${selected.id}/cancel`, { reason: 'cancelled_from_todos_page' }).then(() => queryClient.invalidateQueries({ queryKey: ['todos'] }))}>{t('common.cancel')}</button>
                {selected.archivedAt ? (
                  <button className="tiny-btn" type="button" onClick={() => postJson(`/todos/${selected.id}/unarchive`, {}).then(() => queryClient.invalidateQueries({ queryKey: ['todos'] }))}>{t('assets.todo.unarchive')}</button>
                ) : (
                  <button className="tiny-btn" type="button" onClick={() => postJson(`/todos/${selected.id}/archive`, { reason: 'archived_from_todos_page' }).then(() => queryClient.invalidateQueries({ queryKey: ['todos'] }))}>{t('assets.label.archive')}</button>
                )}
              </div>
            </div>
            <div className="definition-list">
              <Definition term={t('assets.todo.defDispatch')} text={t('assets.todo.defDispatchText')} />
              <Definition term={t('assets.todo.defReopen')} text={t('assets.todo.defReopenText')} />
              <Definition term={t('assets.todo.defBatch')} text={t('assets.todo.defBatchText')} />
              <Definition term={t('assets.todo.defArchive')} text={t('assets.todo.defArchiveText')} />
            </div>
          </>
        ) : (
          <EmptyText text={t('assets.todo.selectHint')} />
        )}

        <form className="stack-form todo-create" onSubmit={createTodo}>
          <div className="panel-head compact"><h2>{t('assets.todo.addTitle')}</h2></div>
          <Field label={t('assets.label.title')}>
            <input value={title} onChange={event => setTitle(event.target.value)} placeholder={t('assets.todo.titlePh')} />
          </Field>
          <Field label={t('assets.label.description')}>
            <textarea value={description} onChange={event => setDescription(event.target.value)} rows={4} placeholder={t('assets.todo.descriptionPh')} />
          </Field>
          <Field label={t('assets.label.dependsOn')}>
            <input value={dependsOn} onChange={event => setDependsOn(event.target.value)} placeholder={t('assets.todo.dependsOnPh')} />
          </Field>
          <div className="two-col">
            <Field label={t('assets.label.kind')}>
              <select value={newKind} onChange={event => setNewKind(event.target.value as TodoKind)}>
                {TODO_KINDS.map(item => <option key={item} value={item}>{item}</option>)}
              </select>
            </Field>
            <Field label={t('assets.label.priority')}>
              <select value={priority} onChange={event => setPriority(event.target.value as TodoPriority)}>
                {TODO_PRIORITIES.map(item => <option key={item} value={item}>{item}</option>)}
              </select>
            </Field>
          </div>
          <button className="primary-btn" type="submit" disabled={!title.trim() || create.isPending}>
            <GitBranchPlus size={14} /> {t('assets.todo.addTodo')}
          </button>
        </form>
      </aside>
    </section>
  );
}

function summarizeTodos(todos: TodoItem[]) {
  return {
    ready: todos.filter(todo => todo.status === 'ready').length,
    inProgress: todos.filter(todo => todo.status === 'in_progress').length,
    blocked: todos.filter(todo => todo.status === 'blocked').length,
    archived: todos.filter(todo => Boolean(todo.archivedAt)).length,
    withDependencies: todos.filter(todo => todo.dependsOnIds.length > 0 || todo.blockedByIds.length > 0).length,
  };
}

function parseTodoIds(value: string): string[] {
  return Array.from(new Set(value.split(',').map(item => item.trim()).filter(Boolean)));
}
