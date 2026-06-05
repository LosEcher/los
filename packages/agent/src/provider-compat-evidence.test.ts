import test from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig } from '@los/infra/config';
import { closeDb, getDb, initDb } from '@los/infra/db';
import {
  ensureProviderCompatEvidenceStore,
  listLatestProviderCompatEvidence,
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

    const latest = await listLatestProviderCompatEvidence();
    const loaded = latest.find(item => item.provider === provider && item.model === 'model-a');
    assert.equal(loaded?.probeId, 'read-context');
    assert.equal(loaded?.decision, 'verified_advisory');
  } finally {
    await getDb().query('DELETE FROM provider_compat_evidence WHERE provider = $1', [provider]).catch(() => undefined);
    await closeDb().catch(() => undefined);
  }
});
