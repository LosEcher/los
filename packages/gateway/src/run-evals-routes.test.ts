import test from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig } from '@los/infra/config';
import { closeDb, getDb, initDb } from '@los/infra/db';
import { createRunSpec } from '@los/agent';
import { createServer } from './server.js';

test('run eval routes record and list quality metrics', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);

  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const runSpecId = `run-eval-route-${suffix}`;
  const sessionId = `session-run-eval-route-${suffix}`;
  const id = `run-eval-route-record-${suffix}`;
  const app = await createServer({
    serviceId: `gateway-run-eval-route-test-${suffix}`,
    bindUrl: 'http://127.0.0.1:0',
    publicUrl: 'http://127.0.0.1:0',
    hostLabel: 'test',
  });

  try {
    await createRunSpec({
      id: runSpecId,
      sessionId,
      prompt: 'record eval route',
      workspaceRoot: process.cwd(),
      toolMode: 'project-write',
      maxLoops: 1,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/run-evals',
      payload: {
        id,
        runSpecId,
        sessionId,
        provider: 'deepseek',
        model: 'deepseek-v4-pro',
        success: false,
        latencyMs: 2500,
        retryCount: 1,
        toolErrorCount: 2,
        verificationStatus: 'failed',
        modelCost: 0.12,
        userFeedback: 'route test feedback',
        failureClass: 'tool_error',
        summary: { source: 'route-test' },
      },
    });
    assert.equal(response.statusCode, 201);
    const recorded = response.json().eval;
    assert.equal(recorded.id, id);
    assert.equal(recorded.runSpecId, runSpecId);
    assert.equal(recorded.success, false);
    assert.equal(recorded.toolErrorCount, 2);
    assert.equal(recorded.failureClass, 'tool_error');

    const listed = await app.inject({
      method: 'GET',
      url: `/run-evals?runSpecId=${encodeURIComponent(runSpecId)}&success=false`,
    });
    assert.equal(listed.statusCode, 200);
    const body = listed.json();
    assert.equal(body.count, 1);
    assert.equal(body.evals[0].id, id);

    const summary = await app.inject({
      method: 'GET',
      url: `/run-evals/summary?runSpecId=${encodeURIComponent(runSpecId)}`,
    });
    assert.equal(summary.statusCode, 200);
    const summaryBody = summary.json();
    assert.equal(summaryBody.totals.count, 1);
    assert.equal(summaryBody.totals.failureCount, 1);
    assert.equal(summaryBody.byFailureClass[0].key, 'tool_error');
    assert.equal(summaryBody.byVerificationStatus[0].key, 'failed');
    assert.equal(summaryBody.byProviderModel[0].key, 'deepseek:deepseek-v4-pro');

    const invalid = await app.inject({
      method: 'POST',
      url: '/run-evals',
      payload: {
        runSpecId,
      },
    });
    assert.equal(invalid.statusCode, 422);
    assert.match(invalid.json().error, /success is required/);
  } finally {
    await getDb().query('DELETE FROM run_evals WHERE run_spec_id = $1', [runSpecId]).catch(() => undefined);
    await getDb().query('DELETE FROM run_specs WHERE id = $1', [runSpecId]).catch(() => undefined);
    await app.close();
    await closeDb().catch(() => undefined);
  }
});
