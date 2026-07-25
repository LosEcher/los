import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import type { ExecutionExperimentRecord } from '@los/agent';
import { loadConfig } from '@los/infra/config';
import { registerExecutionExperimentRoutes } from './routes/orchestration/execution-experiment-routes.js';

test('execution experiment routes keep draft creation separate from operator approval', async () => {
  await loadConfig();
  const records = new Map<string, ExecutionExperimentRecord>();
  const app = Fastify({ logger: false });
  registerExecutionExperimentRoutes(app, {
    async createExecutionExperiment(input) {
      const now = new Date().toISOString();
      const record: ExecutionExperimentRecord = {
        ...input,
        status: 'draft',
        createdAt: now,
        updatedAt: now,
      };
      records.set(record.id, record);
      return record;
    },
    async loadExecutionExperiment(id) {
      return records.get(id) ?? null;
    },
    async approveExecutionExperiment(id, actor) {
      const current = records.get(id);
      if (!current) throw new Error(`Execution experiment not found: ${id}`);
      const approved = {
        ...current,
        status: 'approved' as const,
        approvedBy: actor,
        updatedAt: new Date().toISOString(),
      };
      records.set(id, approved);
      return approved;
    },
  });
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
  }
});
