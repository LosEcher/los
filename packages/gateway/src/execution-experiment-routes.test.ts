import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { closeDb, initDb } from '@los/infra/db';
import { loadConfig } from '@los/infra/config';
import { ensureExecutionExperimentStore } from '@los/agent/execution-experiments';
import { registerExecutionExperimentRoutes } from './routes/orchestration/execution-experiment-routes.js';

test('execution experiment routes keep draft creation separate from operator approval', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  await ensureExecutionExperimentStore();
  const app = Fastify({ logger: false });
  registerExecutionExperimentRoutes(app);
  const id = `route-experiment-${Date.now()}`;
  try {
    const created = await app.inject({
      method: 'POST', url: '/execution-experiments', payload: {
        id,
        source: { sessionId: 'source-session', runSpecId: 'source-run', eventCursor: 4, evidenceHash: 'sha256:route' },
        configDiff: [{ path: 'model', value: 'candidate-model' }],
      },
    });
    assert.equal(created.statusCode, 201);
    assert.equal(created.json().experiment.status, 'draft');

    const fetched = await app.inject({ method: 'GET', url: `/execution-experiments/${id}` });
    assert.equal(fetched.statusCode, 200);
    assert.equal(fetched.json().experiment.source.evidenceHash, 'sha256:route');

    const approved = await app.inject({ method: 'POST', url: `/execution-experiments/${id}/approve` });
    assert.equal(approved.statusCode, 200);
    assert.equal(approved.json().experiment.status, 'approved');
  } finally {
    await app.close();
    const { getDb } = await import('@los/infra/db');
    await getDb().query('DELETE FROM execution_experiments WHERE id = $1', [id]).catch(() => undefined);
    await closeDb().catch(() => undefined);
  }
});
