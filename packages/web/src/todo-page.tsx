import { type FormEvent, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { GitBranchPlus, RefreshCcw } from 'lucide-react';
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

const TODO_STATUSES: TodoStatus[] = ['backlog', 'ready', 'in_progress', 'blocked', 'done', 'cancelled'];
const TODO_KINDS: TodoKind[] = ['problem', 'solution', 'plan', 'phase', 'task', 'batch'];
const TODO_PRIORITIES: TodoPriority[] = ['P0', 'P1', 'P2', 'P3'];

export function TodosPage() {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState('');
  const [kind, setKind] = useState('');
  const [includeArchived, setIncludeArchived] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<TodoPriority>('P1');
  const [newKind, setNewKind] = useState<TodoKind>('task');
  const [dependsOn, setDependsOn] = useState('');

  const query = new URLSearchParams();
  if (status) query.set('status', status);
  if (kind) query.set('kind', kind);
  if (includeArchived) query.set('includeArchived', 'true');
  query.set('limit', '200');

  const todos = useQuery({
    queryKey: ['todos', status, kind, includeArchived],
    queryFn: () => getJson<TodoItem[]>(`/todos?${query.toString()}`),
    refetchInterval: 10_000,
  });

  const selected = (todos.data ?? []).find(todo => todo.id === selectedId) ?? todos.data?.[0] ?? null;
  const counts = summarizeTodos(todos.data ?? []);

  const create = useMutation({
    mutationFn: (payload: TodoPayload) => postJson<TodoItem>('/todos', payload),
    onSuccess: async (todo) => {
      setTitle('');
      setDescription('');
      setDependsOn('');
      setSelectedId(todo.id);
      await queryClient.invalidateQueries({ queryKey: ['todos'] });
    },
  });
  const update = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Partial<TodoItem> }) => patchJson<TodoItem>(`/todos/${id}`, body),
    onSuccess: async (todo) => {
      setSelectedId(todo.id);
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
            <h2>Todos</h2>
            <p>Tenant/project planning ledger before agent dispatch.</p>
          </div>
          <div className="toolbar">
            <select value={status} onChange={event => setStatus(event.target.value)}>
              <option value="">all status</option>
              {TODO_STATUSES.map(item => <option key={item} value={item}>{item}</option>)}
            </select>
            <select value={kind} onChange={event => setKind(event.target.value)}>
              <option value="">all kinds</option>
              {TODO_KINDS.map(item => <option key={item} value={item}>{item}</option>)}
            </select>
            <label className="toolbar-toggle">
              <input type="checkbox" checked={includeArchived} onChange={event => setIncludeArchived(event.target.checked)} />
              archived
            </label>
            <button className="ghost-btn" type="button" onClick={() => seed.mutate()} disabled={seed.isPending}>
              <RefreshCcw size={14} /> seed
            </button>
          </div>
        </div>

        <div className="todo-summary">
          <Fact label="ready" value={String(counts.ready)} />
          <Fact label="active" value={String(counts.inProgress)} />
          <Fact label="blocked" value={String(counts.blocked)} />
          <Fact label="archived" value={String(counts.archived)} />
          <Fact label="deps" value={String(counts.withDependencies)} />
        </div>

        <DataTable
          loading={todos.isLoading}
          empty="No todos found."
          rows={todos.data ?? []}
          renderRow={todo => (
            <button
              type="button"
              className="record-row todo-row"
              data-active={selected?.id === todo.id}
              onClick={() => setSelectedId(todo.id)}
            >
              <span className="todo-main">
                <strong>{todo.title}</strong>
                <em>{todo.tenantId}/{todo.projectId} · {todo.stageId ?? 'no-stage'} · {todo.source}{todo.archivedAt ? ` · archived ${formatDate(todo.archivedAt)}` : ''}</em>
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
          <h2>Todo Detail</h2>
          {selected ? <span className="mono-chip">{selected.id}</span> : null}
        </div>
        {selected ? (
          <>
            <div className="todo-detail">
              <h3>{selected.title}</h3>
              <p>{selected.description || 'No description'}</p>
              <div className="fact-list compact-facts">
                <Fact label="tenant" value={selected.tenantId} />
                <Fact label="project" value={selected.projectId} />
                <Fact label="stage" value={selected.stageId ?? 'none'} />
                <Fact label="trace" value={selected.traceId ?? 'not linked'} />
                <Fact label="request" value={selected.requestId ?? 'not linked'} />
                <Fact label="task" value={selected.taskRunId ?? 'not dispatched'} />
                <Fact label="depends on" value={selected.dependsOnIds.join(', ') || 'none'} />
                <Fact label="blocked by" value={selected.blockedByIds.join(', ') || 'none'} />
                <Fact label="archive" value={selected.archivedAt ? `${formatDate(selected.archivedAt)} · ${selected.archiveReason ?? 'archived'}` : 'active'} />
              </div>
              <div className="todo-actions">
                <button className="tiny-btn" type="button" onClick={() => update.mutate({ id: selected.id, body: { status: 'ready' } })}>ready</button>
                <button className="tiny-btn" type="button" onClick={() => update.mutate({ id: selected.id, body: { status: 'in_progress' } })}>start</button>
                <button className="tiny-btn" type="button" onClick={() => update.mutate({ id: selected.id, body: { status: 'blocked' } })}>block</button>
                <button className="tiny-btn" type="button" onClick={() => update.mutate({ id: selected.id, body: { status: 'done' } })}>done</button>
                <button className="tiny-btn" type="button" onClick={() => postJson(`/todos/${selected.id}/reopen`, {}).then(() => queryClient.invalidateQueries({ queryKey: ['todos'] }))}>reopen</button>
                <button className="tiny-btn" type="button" onClick={() => postJson(`/todos/${selected.id}/cancel`, { reason: 'cancelled_from_todos_page' }).then(() => queryClient.invalidateQueries({ queryKey: ['todos'] }))}>cancel</button>
                {selected.archivedAt ? (
                  <button className="tiny-btn" type="button" onClick={() => postJson(`/todos/${selected.id}/unarchive`, {}).then(() => queryClient.invalidateQueries({ queryKey: ['todos'] }))}>unarchive</button>
                ) : (
                  <button className="tiny-btn" type="button" onClick={() => postJson(`/todos/${selected.id}/archive`, { reason: 'archived_from_todos_page' }).then(() => queryClient.invalidateQueries({ queryKey: ['todos'] }))}>archive</button>
                )}
              </div>
            </div>
            <div className="definition-list">
              <Definition term="dispatch rule" text="Only ready task/batch todos should create scheduler task runs later." />
              <Definition term="reopen rule" text="Done or cancelled items return to ready, preserving trace and history fields." />
              <Definition term="batch rule" text="Batch todos group several task todos by stageId or batchKey." />
              <Definition term="archive rule" text="Archived todos leave the active work set but keep tenant/project/trace evidence." />
            </div>
          </>
        ) : (
          <EmptyText text="Select a todo to inspect dispatch context." />
        )}

        <form className="stack-form todo-create" onSubmit={createTodo}>
          <div className="panel-head compact"><h2>Add Todo</h2></div>
          <Field label="title">
            <input value={title} onChange={event => setTitle(event.target.value)} placeholder="dispatchable planning item" />
          </Field>
          <Field label="description">
            <textarea value={description} onChange={event => setDescription(event.target.value)} rows={4} placeholder="problem, solution, acceptance criteria" />
          </Field>
          <Field label="depends on">
            <input value={dependsOn} onChange={event => setDependsOn(event.target.value)} placeholder="comma-separated todo ids" />
          </Field>
          <div className="two-col">
            <Field label="kind">
              <select value={newKind} onChange={event => setNewKind(event.target.value as TodoKind)}>
                {TODO_KINDS.map(item => <option key={item} value={item}>{item}</option>)}
              </select>
            </Field>
            <Field label="priority">
              <select value={priority} onChange={event => setPriority(event.target.value as TodoPriority)}>
                {TODO_PRIORITIES.map(item => <option key={item} value={item}>{item}</option>)}
              </select>
            </Field>
          </div>
          <button className="primary-btn" type="submit" disabled={!title.trim() || create.isPending}>
            <GitBranchPlus size={14} /> add todo
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
