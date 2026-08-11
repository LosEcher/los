import test from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig } from '@los/infra/config';
import { closeDb, getDb, initDb } from '@los/infra/db';
import {
  ensureLanguageContractSnapshotStore,
  runLanguageAudit,
} from './governance-language-audit.js';
import type { GovernanceJob } from './governance-jobs-types.js';
import { ensureRunSpecStore, createRunSpec } from './run-specs.js';
import { ensureSessionEventStore, appendSessionEvent } from './session-events.js';

function makeJob(overrides: Partial<GovernanceJob> = {}): GovernanceJob {
  return {
    id: `lang-audit-test-${Date.now()}`,
    jobType: 'language_audit',
    cadence: 'weekly',
    status: 'active',
    config: {
      lookbackDays: 30,
      sampleLimit: 40,
      minTextChars: 20,
      minSamplesForThresholds: 3,
      promoteAfterCleanRuns: 99,
      autoPromoteCadence: false,
    },
    tenantId: 'language-audit-test',
    projectId: 'language-audit-test',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    consecutiveNoOps: 0,
    consecutiveFailures: 0,
    circuitState: 'closed',
    ...overrides,
  };
}

test('language audit scores run_spec results and model.response previews', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);

  const sessionId = `lang-audit-session-${Date.now()}`;
  try {
    await ensureLanguageContractSnapshotStore();
    await ensureRunSpecStore();
    await ensureSessionEventStore();

    const run = await createRunSpec({
      id: `run-lang-audit-${Date.now()}`,
      sessionId,
      prompt: 'language audit fixture',
      provider: 'test',
      model: 'test-model',
      workspaceRoot: process.cwd(),
      toolMode: 'read-only',
      tenantId: 'language-audit-test',
      projectId: 'language-audit-test',
    });

    await getDb().query(
      `UPDATE run_specs SET result_json = $2::jsonb, status = 'succeeded', updated_at = now()
       WHERE id = $1`,
      [
        run.id,
        JSON.stringify({
          text: 'Let me spawn agents. Everything is fixed and shipped with no checks.',
          status: 'completed',
        }),
      ],
    );

    await appendSessionEvent({
      sessionId,
      type: 'model.response',
      source: 'los',
      tenantId: 'language-audit-test',
      projectId: 'language-audit-test',
      payload: {
        textPreview: 'Gateway healthy [E] curl /health 200. Residual: RSS unchecked [I].',
        textLength: 70,
        provider: 'test',
      },
    });

    const summary = await runLanguageAudit(makeJob(), { now: new Date(), dryRun: false });
    assert.equal(typeof summary.sampleCount, 'number');
    assert.ok((summary.sampleCount as number) >= 1, 'expected at least one sample');
    assert.ok(Array.isArray(summary.findings));
    assert.equal(summary.contractVersion, '1.0.0');

    const snap = await getDb().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM language_contract_snapshots
       WHERE created_at > now() - interval '5 minutes'`,
    );
    assert.ok(Number(snap.rows[0]?.n ?? 0) >= 1, 'snapshot row should be written');
  } finally {
    await getDb().query(`DELETE FROM run_specs WHERE session_id = $1`, [sessionId]).catch(() => undefined);
    await getDb().query(`DELETE FROM session_events WHERE session_id = $1`, [sessionId]).catch(() => undefined);
    await getDb().query(
      `DELETE FROM language_contract_snapshots WHERE created_at > now() - interval '1 hour'`,
    ).catch(() => undefined);
    await closeDb().catch(() => undefined);
  }
});
