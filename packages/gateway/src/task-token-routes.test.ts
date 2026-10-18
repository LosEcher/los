import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { loadConfig, setConfig } from '@los/infra/config';
import { registerRequestContext } from './request-context.js';
import authMiddleware from './auth-middleware.js';
import { registerTaskRoutes, type TaskRouteDependencies } from './routes/orchestration/task-routes.js';
import { mintTaskToken } from './task-token.js';

const SECRET = 'route-test-task-token-secret';

interface TaskRow {
  id: string;
  sessionId: string;
  traceId: string;
  workspaceRoot: string;
  toolMode: string;
  status: string;
  attempt: number;
  promptPreview: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  leaseVersion: number;
  nodeId?: string;
  heartbeatAt?: string;
  leaseExpiresAt?: string;
}

function makeTask(overrides: Partial<TaskRow> = {}): TaskRow {
  const now = new Date().toISOString();
  return {
    id: 'task-a',
    sessionId: 'session-1',
    traceId: 'trace-1',
    workspaceRoot: '/tmp/workspace',
    toolMode: 'read-only',
    status: 'running',
    attempt: 1,
    promptPreview: 'p',
    metadata: {},
    createdAt: now,
    updatedAt: now,
    leaseVersion: 3,
    nodeId: 'node-1',
    leaseExpiresAt: new Date(Date.now() + 30_000).toISOString(),
    ...overrides,
  };
}

interface HarnessOptions {
  secret?: string;
  task?: TaskRow | null;
  heartbeatResult?: TaskRow | null;
  authEnabled?: boolean;
}

async function buildHarness(options: HarnessOptions = {}) {
  const base = await loadConfig();
  const config = structuredClone(base);
  config.auth.enabled = options.authEnabled ?? false;
  if (config.auth.enabled) config.auth.operatorToken = 'route-test-operator';
  setConfig(config);

  const task = options.task === undefined ? makeTask() : options.task;
  const calls: Array<{ id: string; nodeId: string; leaseVersion: number; leaseMs?: number }> = [];

  const deps = {
    acknowledgeDeadLetterEvent: async () => null,
    appendSessionEvent: async () => ({ id: 1 }),
    cancelScheduledTask: () => false,
    ensureTaskRunStore: async () => {},
    heartbeatTaskRun: async (id: string, input: { nodeId: string; leaseVersion: number; leaseMs?: number }) => {
      calls.push({ id, ...input });
      if (options.heartbeatResult !== undefined) return options.heartbeatResult;
      if (!task) return null;
      return {
        ...task,
        heartbeatAt: new Date().toISOString(),
        leaseExpiresAt: new Date(Date.now() + (input.leaseMs ?? 30_000)).toISOString(),
      };
    },
    listDeadLetterEvents: async () => [],
    listServiceInstances: async () => [],
    listTaskRuns: async () => [],
    listTaskRunsByStatus: async () => [],
    loadTaskRun: async (id: string) => (task && task.id === id ? task : null),
    requestCancellation: async () => {},
    requeueDeadLetterEvent: async () => ({ status: 'not_found', reason: 'not found' }),
    summarizeDeadLetterEvents: async () => ({ total: 0, byReason: {}, byResolution: {}, recentEvent: null }),
    taskTokenSecret: () => (options.secret === undefined ? SECRET : options.secret),
    transitionExecutionState: async () => ({}),
    updateTaskRunFields: async () => ({}),
  } as unknown as TaskRouteDependencies;

  const app = Fastify({ logger: false });
  registerRequestContext(app, config);
  await authMiddleware(app, { config });
  registerTaskRoutes(app, deps);
  return { app, calls, task };
}

test('mint issues a token bound to the task row; heartbeat renews with the DB node id', async () => {
  const { app, calls } = await buildHarness();

  try {
    const minted = await app.inject({ method: 'POST', url: '/tasks/task-a/token', payload: {} });
    assert.equal(minted.statusCode, 200);
    const mintedBody = minted.json();
    assert.equal(mintedBody.ok, true);
    assert.equal(mintedBody.taskRunId, 'task-a');
    assert.equal(mintedBody.leaseVersion, 3);
    assert.equal(typeof mintedBody.token, 'string');
    assert.equal(new Date(mintedBody.expiresAt).getTime() > Date.now(), true);

    // A forged body nodeId must not override the node recorded on the task row.
    const beat = await app.inject({
      method: 'POST',
      url: '/tasks/task-a/heartbeat',
      headers: { 'x-los-task-token': mintedBody.token },
      payload: { nodeId: 'attacker-node', leaseMs: 45_000 },
    });
    assert.equal(beat.statusCode, 200);
    assert.equal(beat.json().taskRunId, 'task-a');
    assert.deepEqual(calls, [{ id: 'task-a', nodeId: 'node-1', leaseVersion: 3, leaseMs: 45_000 }]);
  } finally {
    await app.close();
  }
});

test('expired token ⇒ 401 even when a valid operator credential is also present (no fallback)', async () => {
  const { app, calls } = await buildHarness({ authEnabled: true });
  const expired = mintTaskToken({
    taskRunId: 'task-a',
    leaseVersion: 3,
    secret: SECRET,
    ttlSeconds: 60,
    now: 1_000,
  });

  try {
    const withoutToken = await app.inject({ method: 'POST', url: '/tasks/task-a/heartbeat', payload: {} });
    assert.equal(withoutToken.statusCode, 401);

    const withExpired = await app.inject({
      method: 'POST',
      url: '/tasks/task-a/heartbeat',
      headers: {
        'x-los-task-token': expired.token,
        'x-los-operator-token': 'route-test-operator',
      },
      payload: {},
    });
    assert.equal(withExpired.statusCode, 401);
    assert.deepEqual(withExpired.json(), { error: 'invalid_task_token', reason: 'expired' });
    assert.deepEqual(calls, [], 'an invalid token must not touch the lease');
  } finally {
    await app.close();
  }
});

test("[C2] task A's token cannot heartbeat task B — 403 before any DB write", async () => {
  const taskB = makeTask({ id: 'task-b', nodeId: 'node-2' });
  // loadTaskRun resolves both ids so the scope check is what rejects the request.
  const { app, calls } = await buildHarness({ task: taskB });

  try {
    const mintedA = mintTaskToken({
      taskRunId: 'task-a',
      leaseVersion: 3,
      secret: SECRET,
      now: Math.floor(Date.now() / 1000),
    });
    const res = await app.inject({
      method: 'POST',
      url: '/tasks/task-b/heartbeat',
      headers: { 'x-los-task-token': mintedA.token },
      payload: {},
    });
    assert.equal(res.statusCode, 403);
    assert.deepEqual(res.json(), { error: 'task_token_scope_mismatch' });
    assert.deepEqual(calls, [], 'a scoped-out token must not renew any lease');
  } finally {
    await app.close();
  }
});

test('stale lease version ⇒ 409 lease_lost_or_expired, never a 200 retry', async () => {
  const { app } = await buildHarness({ heartbeatResult: null });
  try {
    const minted = await app.inject({ method: 'POST', url: '/tasks/task-a/token', payload: {} });
    const res = await app.inject({
      method: 'POST',
      url: '/tasks/task-a/heartbeat',
      headers: { 'x-los-task-token': minted.json().token },
      payload: {},
    });
    assert.equal(res.statusCode, 409);
    assert.deepEqual(res.json(), { error: 'lease_lost_or_expired', taskRunId: 'task-a' });
  } finally {
    await app.close();
  }
});

test('mint fails closed without a secret and refuses terminal/unknown tasks', async () => {
  const noSecret = await buildHarness({ secret: '' });
  try {
    const res = await noSecret.app.inject({ method: 'POST', url: '/tasks/task-a/token', payload: {} });
    assert.equal(res.statusCode, 503);
    assert.deepEqual(res.json(), { error: 'task_token_secret_not_configured' });

    const beat = await noSecret.app.inject({ method: 'POST', url: '/tasks/task-a/heartbeat', payload: {} });
    assert.equal(beat.statusCode, 503);
  } finally {
    await noSecret.app.close();
  }

  const terminal = await buildHarness({ task: makeTask({ status: 'succeeded' }) });
  try {
    const res = await terminal.app.inject({ method: 'POST', url: '/tasks/task-a/token', payload: {} });
    assert.equal(res.statusCode, 409);
    assert.deepEqual(res.json(), { error: 'task_not_active', status: 'succeeded' });
  } finally {
    await terminal.app.close();
  }

  const missing = await buildHarness({ task: null });
  try {
    const res = await missing.app.inject({ method: 'POST', url: '/tasks/missing/token', payload: {} });
    assert.equal(res.statusCode, 404);
  } finally {
    await missing.app.close();
  }
});

test('ttlSeconds and leaseMs are validated with named bounds instead of silently clamped', async () => {
  const { app } = await buildHarness();
  try {
    for (const ttlSeconds of [0, 59, 3_601, 1.5, '600']) {
      const res = await app.inject({ method: 'POST', url: '/tasks/task-a/token', payload: { ttlSeconds } });
      assert.equal(res.statusCode, 400, `ttlSeconds=${String(ttlSeconds)} must be rejected`);
      assert.match(res.json().error, /ttlSeconds must be an integer between 60 and 3600/);
    }
    const minted = await app.inject({ method: 'POST', url: '/tasks/task-a/token', payload: { ttlSeconds: 120 } });
    for (const leaseMs of [999, 600_001, 1.5]) {
      const res = await app.inject({
        method: 'POST',
        url: '/tasks/task-a/heartbeat',
        headers: { 'x-los-task-token': minted.json().token },
        payload: { leaseMs },
      });
      assert.equal(res.statusCode, 400, `leaseMs=${String(leaseMs)} must be rejected`);
    }
  } finally {
    await app.close();
  }
});
