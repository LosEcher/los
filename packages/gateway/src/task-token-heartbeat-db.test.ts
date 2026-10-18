import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';

import { loadConfig, setConfig } from '@los/infra/config';
import { createTaskRun, loadTaskRun } from '@los/agent/task-runs';
import { registerRequestContext } from './request-context.js';
import { registerTaskRoutes } from './routes/orchestration/task-routes.js';
import { mintTaskToken } from './task-token.js';

/**
 * 走真库（`los_test`）验证 C1/C2 的**落库效果**：路由层单测把 heartbeat 换成了假件，
 * 这里用默认依赖接到 `heartbeatTaskRun` 的 SQL fence，证明令牌真的续到租约上、
 * 且换代令牌真的被 SQL 拒掉。
 */
const SECRET = 'db-test-task-token-secret';

test('task token renews the real lease and a stale lease version is fenced out', async () => {
  const base = await loadConfig();
  const config = structuredClone(base);
  config.auth.enabled = false;
  config.executor.taskTokenSecret = SECRET;
  setConfig(config);

  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const taskRunId = `task-token-db-${suffix}`;
  const sessionId = `task-token-db-session-${suffix}`;

  const app = Fastify({ logger: false });
  registerRequestContext(app, config);
  registerTaskRoutes(app);

  try {
    await createTaskRun({
      id: taskRunId,
      sessionId,
      traceId: `trace-${suffix}`,
      workspaceRoot: '/tmp/task-token-db',
      toolMode: 'read-only',
      status: 'running',
      nodeId: 'node-db-test',
      leaseVersion: 4,
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      promptPreview: 'token lease test',
    });

    const minted = await app.inject({ method: 'POST', url: `/tasks/${taskRunId}/token`, payload: {} });
    assert.equal(minted.statusCode, 200);
    const mintedBody = minted.json();
    assert.equal(mintedBody.leaseVersion, 4);

    const beat = await app.inject({
      method: 'POST',
      url: `/tasks/${taskRunId}/heartbeat`,
      headers: { 'x-los-task-token': mintedBody.token },
      payload: { leaseMs: 45_000 },
    });
    assert.equal(beat.statusCode, 200, JSON.stringify(beat.json()));
    assert.equal(beat.json().leaseVersion, 4);

    const persisted = await loadTaskRun(taskRunId);
    assert.ok(persisted, 'task row must still exist');
    assert.ok(persisted.heartbeatAt, 'heartbeat_at must be written by the SQL fence');
    assert.ok(persisted.leaseExpiresAt, 'lease_expires_at must be extended');
    assert.equal(persisted.leaseVersion, 4);

    // A token minted for an older lease generation must not renew generation 4.
    const stale = mintTaskToken({
      taskRunId,
      leaseVersion: 3,
      secret: SECRET,
      now: Math.floor(Date.now() / 1000),
    });
    const staleBeat = await app.inject({
      method: 'POST',
      url: `/tasks/${taskRunId}/heartbeat`,
      headers: { 'x-los-task-token': stale.token },
      payload: {},
    });
    assert.equal(staleBeat.statusCode, 409);
    assert.deepEqual(staleBeat.json(), { error: 'lease_lost_or_expired', taskRunId });
  } finally {
    await app.close();
  }
});
