import test from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig } from '@los/infra/config';
import { closeDb, getDb, initDb } from '@los/infra/db';
import {
  ensureProviderCompatEvidenceStore,
  listProviderCompatEvidence,
  listLatestProviderCompatEvidence,
  recordProviderCompatEvidence,
  recordProviderCompatEvidenceFromSummary,
} from './provider-compat-evidence.js';

test('provider compat evidence records verified advisory summaries', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  const provider = `provider-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    await ensureProviderCompatEvidenceStore();
    const record = await recordProviderCompatEvidenceFromSummary({
      specId: `${provider}:model-a/read-context`,
      provider,
      model: 'model-a',
      probeId: 'read-context',
      sessionId: 'session-provider-evidence',
      taskRunId: 'task-provider-evidence',
      runSpecId: 'run-provider-evidence',
      traceId: 'trace-provider-evidence',
      requestId: 'request-provider-evidence',
      nodeId: 'node-provider-evidence',
      reasoningObserved: false,
      toolCalls: ['list_directory', 'read_file'],
      toolResultCount: 2,
      failedToolResultCount: 0,
      deniedToolCount: 0,
      totalTokens: 42,
      completed: true,
      cancelled: false,
      passed: true,
      failures: [],
    });

    assert.equal(record.decision, 'verified_advisory');
    assert.equal(record.passed, true);
    assert.equal(record.totalTokens, 42);
    assert.equal(record.taskRunId, 'task-provider-evidence');
    assert.equal(record.runSpecId, 'run-provider-evidence');
    assert.equal(record.traceId, 'trace-provider-evidence');
    assert.equal(record.requestId, 'request-provider-evidence');
    assert.equal(record.nodeId, 'node-provider-evidence');

    const latest = await listLatestProviderCompatEvidence();
    const loaded = latest.find(item => item.provider === provider && item.model === 'model-a');
    assert.equal(loaded?.probeId, 'read-context');
    assert.equal(loaded?.decision, 'verified_advisory');
    assert.equal(loaded?.taskRunId, 'task-provider-evidence');

    await recordProviderCompatEvidence({
      id: `${provider}-model-b-read-context`,
      provider,
      model: 'model-b',
      probeId: 'read-context',
      decision: 'advisory',
      passed: false,
      totalTokens: 7,
      summary: { failures: ['missing expected tool call'] },
    });

    const history = await listProviderCompatEvidence({ provider, limit: 10 });
    assert.equal(history.length, 2);
    assert.ok(history.some(item => item.model === 'model-a' && item.passed));
    assert.ok(history.some(item => item.model === 'model-b' && !item.passed));

    const modelA = await listProviderCompatEvidence({ provider, model: 'model-a' });
    assert.deepEqual(modelA.map(item => item.model), ['model-a']);
  } finally {
    await getDb().query('DELETE FROM provider_compat_evidence WHERE provider = $1', [provider]).catch(() => undefined);
    await closeDb().catch(() => undefined);
  }
});
