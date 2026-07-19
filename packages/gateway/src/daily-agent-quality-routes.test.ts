import assert from 'node:assert/strict';
import test from 'node:test';

import Fastify from 'fastify';
import { getConfig } from '@los/infra/config';
import { getDb } from '@los/infra/db';

import { registerRequestContext } from './request-context.js';
import { registerDailyAgentQualityRoutes } from './routes/data/daily-agent-quality-routes.js';

test('daily agent quality routes capture idempotently and report a collecting baseline', async () => {
  const app = Fastify({ logger: false });
  registerRequestContext(app, getConfig());
  registerDailyAgentQualityRoutes(app);
  const projectId = `quality-route-${Date.now()}`;
  const headers = {
    'x-tenant-id': 'local',
    'x-project-id': projectId,
    'x-user-id': 'quality-test',
  };
  try {
    const first = await app.inject({
      method: 'POST', url: '/daily-agent-quality/capture', headers,
    });
    assert.equal(first.statusCode, 201);
    assert.equal(first.json().snapshot.projectId, projectId);
    assert.equal(first.json().evidenceWindow.status, 'collecting');

    const second = await app.inject({
      method: 'POST', url: '/daily-agent-quality/capture', headers,
    });
    assert.equal(second.statusCode, 201);
    assert.equal(second.json().snapshot.id, first.json().snapshot.id);

    const baseline = await app.inject({
      method: 'GET', url: '/daily-agent-quality/baseline?days=28', headers,
    });
    assert.equal(baseline.statusCode, 200);
    assert.equal(baseline.json().snapshots.length, 1);
    assert.equal(baseline.json().evidenceWindow.observedDays, 1);
    assert.equal(baseline.json().evidenceWindow.requiredDays, 28);
  } finally {
    await getDb().query('DELETE FROM daily_agent_quality_snapshots WHERE project_id=$1', [projectId]);
    await app.close();
  }
});
