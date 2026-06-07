import test from 'node:test';
import assert from 'node:assert/strict';

import { recordProviderCompatEvidence } from '@los/agent';
import { loadConfig } from '@los/infra/config';
import { closeDb, getDb, initDb } from '@los/infra/db';
import { createServer } from './server.js';

test('provider compat evidence route exposes bounded operator evidence', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);

  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const provider = `provider-route-${suffix}`;
  const app = await createServer({
    serviceId: `provider-compat-route-test-${suffix}`,
    bindUrl: 'http://127.0.0.1:0',
    publicUrl: 'http://127.0.0.1:0',
    hostLabel: 'test',
  });

  try {
    await recordProviderCompatEvidence({
      id: `provider-compat-route-${suffix}`,
      provider,
      model: 'model-a',
      probeId: 'read-context',
      targetLabel: `${provider}:model-a`,
      decision: 'verified_advisory',
      passed: true,
      sessionId: `session-${suffix}`,
      taskRunId: `task-${suffix}`,
      runSpecId: `run-${suffix}`,
      traceId: `trace-${suffix}`,
      requestId: `request-${suffix}`,
      nodeId: `node-${suffix}`,
      totalTokens: 123,
      summary: {
        completed: true,
        cancelled: false,
        reasoningObserved: true,
        toolCalls: ['list_directory', 'read_file'],
        toolResultCount: 2,
        failedToolResultCount: 0,
        deniedToolCount: 0,
        failures: ['this should be short enough'],
        rawTranscript: 'must not be exposed',
      },
    });

    const response = await app.inject({
      method: 'GET',
      url: `/providers/compat-evidence?provider=${encodeURIComponent(provider)}`,
    });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.count, 1);
    assert.equal(body.evidence[0].id, `provider-compat-route-${suffix}`);
    assert.equal(body.evidence[0].decision, 'verified_advisory');
    assert.equal(body.evidence[0].passed, true);
    assert.equal(body.evidence[0].sessionId, `session-${suffix}`);
    assert.equal(body.evidence[0].taskRunId, `task-${suffix}`);
    assert.equal(body.evidence[0].runSpecId, `run-${suffix}`);
    assert.equal(body.evidence[0].totalTokens, 123);
    assert.deepEqual(body.evidence[0].summary.toolCalls, ['list_directory', 'read_file']);
    assert.equal(body.evidence[0].summary.rawTranscript, undefined);
  } finally {
    await getDb().query('DELETE FROM provider_compat_evidence WHERE provider = $1', [provider]).catch(() => undefined);
    await app.close();
    await closeDb().catch(() => undefined);
  }
});
