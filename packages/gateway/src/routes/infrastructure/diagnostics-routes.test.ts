import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { loadConfig } from '@los/infra/config';
import { closeDb, getDb, initDb } from '@los/infra/db';
import { registerRequestContext } from '../../request-context.js';
import { registerDiagnosticsRoutes } from './diagnostics-routes.js';

type DbRow = Record<string, any>;

async function insertEvent(overrides: DbRow): Promise<number> {
  const row: DbRow = {
    session_id: 'diag-session',
    trace_id: 'diag-trace',
    request_id: 'req-diag',
    turn: 0,
    type: 'session.started',
    source: 'los',
    parent_event_id: null,
    visibility: 'public',
    payload_json: '{}',
    usage_json: '{}',
    ...overrides,
  };
  const res = await getDb().query<{ id: number }>(
    `INSERT INTO session_events
       (session_id, tenant_id, project_id, user_id, node_id, request_id, trace_id,
        turn, type, source, model, tool_name, cache_key, cache_hit,
        usage_json, payload_json, parent_event_id, visibility)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16::jsonb,$17,$18)
     RETURNING id`,
    [
      row.session_id, 'local', 'los', 'local-user', null, row.request_id, row.trace_id,
      row.turn, row.type, row.source, row.model ?? null, row.tool_name ?? null, null, null,
      row.usage_json, row.payload_json, row.parent_event_id, row.visibility,
    ],
  );
  return res.rows[0].id;
}

test('GET /diagnostics/:traceId aggregates events, task runs, todos, providers and builds span tree', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  const app = Fastify({ logger: false });
  registerRequestContext(app, config);
  registerDiagnosticsRoutes(app);
  const stamp = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const traceId = `diag-trace-${stamp}`;
  const sessionId = `diag-session-${stamp}`;
  try {
    const { ensureSessionEventStore } = await import('@los/agent/session-events');
    const { ensureTaskRunStore } = await import('@los/agent/task-runs');
    const { ensureProviderCallTelemetryStore } = await import('@los/agent/providers/telemetry');
    const { ensureTodoStore } = await import('@los/agent/todos');
    await Promise.all([
      ensureSessionEventStore(),
      ensureTaskRunStore(),
      ensureProviderCallTelemetryStore(),
      ensureTodoStore(),
    ]);

    // Span chain: root -> child -> grandchild
    const rootId = await insertEvent({ session_id: sessionId, trace_id: traceId, type: 'session.started', turn: 1 });
    const childId = await insertEvent({ session_id: sessionId, trace_id: traceId, type: 'model.turn.started', turn: 1, parent_event_id: rootId });
    await insertEvent({ session_id: sessionId, trace_id: traceId, type: 'model.response', turn: 1, parent_event_id: childId, model: 'fixture-model' });

    // Orphan node: parent id not present in this trace's events
    await insertEvent({ session_id: sessionId, trace_id: traceId, type: 'tool.call', turn: 1, parent_event_id: 999_999_999, tool_name: 'bash' });

    await getDb().query(
      `INSERT INTO task_runs (id, session_id, trace_id, workspace_root, tool_mode, status, started_at)
       VALUES ($1, $2, $3, '/tmp', 'read-only', 'succeeded', now())`,
      [`diag-task-${stamp}`, sessionId, traceId],
    );
    await getDb().query(
      `INSERT INTO provider_call_telemetry (trace_id, session_id, provider, model, endpoint, status, duration_ms)
       VALUES ($1, $2, 'deepseek', 'fixture-model', '/v1/chat', 200, 120)`,
      [traceId, sessionId],
    );
    await getDb().query(
      `INSERT INTO todos (id, tenant_id, project_id, title, kind, status, priority, trace_id, created_at, updated_at)
       VALUES ($1, 'local', 'los', 'diag todo', 'task', 'pending', 'P2', $2, now(), now())`,
      [`diag-todo-${stamp}`, traceId],
    );

    const response = await app.inject({ method: 'GET', url: `/diagnostics/${traceId}` });
    assert.equal(response.statusCode, 200, response.body);
    const body = JSON.parse(response.body);

    assert.equal(body.traceId, traceId);
    assert.equal(body.eventCount, 4);
    assert.equal(body.taskRuns.length, 1);
    assert.equal(body.taskRuns[0].id, `diag-task-${stamp}`);
    assert.equal(body.taskRuns[0].status, 'succeeded');
    assert.equal(body.todos.length, 1);
    assert.equal(body.todos[0].title, 'diag todo');
    assert.equal(body.providerCallCount, 1);
    assert.equal(body.providerCalls[0].provider, 'deepseek');

    // Span tree: one root (session.started) with one child (model.turn.started),
    // that child has one child (model.response); tool.call is an orphan root.
    const roots = body.spanTree;
    assert.equal(roots.length, 2, 'expected session.started root + orphan tool.call root');
    const main = roots.find((n: any) => n.type === 'session.started');
    assert.ok(main, 'session.started root present');
    assert.equal(main.orphan, false);
    assert.equal(main.children.length, 1);
    assert.equal(main.children[0].type, 'model.turn.started');
    assert.equal(main.children[0].children.length, 1);
    assert.equal(main.children[0].children[0].type, 'model.response');
    const orphan = roots.find((n: any) => n.type === 'tool.call');
    assert.ok(orphan, 'orphan tool.call root present');
    assert.equal(orphan.orphan, true);

    // Timeline merges events and provider calls.
    assert.ok(body.timeline.some((t: any) => t.source === 'provider'), 'timeline contains provider calls');
  } finally {
    await getDb().query(`DELETE FROM session_events WHERE trace_id = $1`, [traceId]).catch(() => undefined);
    await getDb().query(`DELETE FROM task_runs WHERE id = $1`, [`diag-task-${stamp}`]).catch(() => undefined);
    await getDb().query(`DELETE FROM provider_call_telemetry WHERE trace_id = $1`, [traceId]).catch(() => undefined);
    await getDb().query(`DELETE FROM todos WHERE id = $1`, [`diag-todo-${stamp}`]).catch(() => undefined);
    await closeDb().catch(() => undefined);
    await app.close();
  }
});
