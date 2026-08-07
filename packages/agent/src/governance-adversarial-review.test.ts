import test from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig } from '@los/infra/config';
import { closeDb, getDb, initDb } from '@los/infra/db';
import { runAdversarialReviewAudit } from './governance-adversarial-review.js';
import { ensureProviderCallTelemetryStore } from './providers/telemetry.js';
import type { GovernanceJob } from './governance-jobs-types.js';

function makeJob(module: string): GovernanceJob {
  return {
    id: `adv-test-${module}-${Date.now()}`,
    jobType: 'adversarial_review',
    cadence: 'daily',
    status: 'active',
    config: { module },
    tenantId: 'adversarial-test',
    projectId: 'adversarial-test',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    consecutiveNoOps: 0,
    consecutiveFailures: 0,
    circuitState: 'closed',
  };
}

test('adversarial provider_ready_vs_usable check runs without SQL errors', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);

  try {
    await ensureProviderCallTelemetryStore();
    await getDb().query(
      `DELETE FROM provider_call_telemetry WHERE trace_id LIKE 'adversarial-test-%'`,
    ).catch(() => undefined);

    // Insert a call for one provider so the ready-vs-usable list is non-trivial.
    await getDb().query(
      `INSERT INTO provider_call_telemetry (trace_id, session_id, provider, model, endpoint, status, duration_ms)
       VALUES ('adversarial-test-1', 'adv-session', 'deepseek', 'v4-flash', '/chat/completions', 200, 100)`,
    );

    const summary = await runAdversarialReviewAudit(makeJob('providers'), { now: new Date() });
    assert.equal(summary.module, 'providers');
    assert.equal(typeof summary.findingCount, 'number');
    const findings = summary.findings as Array<{ dimension: string }>;
    // deepseek has a call; the other 6 known providers must appear as findings
    // (or none at all if telemetry data from other tests covers them — the
    // hard assertion is that the check completes without a SQL error).
    assert.ok(Array.isArray(findings));
    assert.ok(findings.every(f => f.dimension === 'provider_ready_vs_usable'));
    assert.ok(findings.length <= 7);
    assert.ok(!findings.some(f => f.dimension !== 'provider_ready_vs_usable'));
  } finally {
    await getDb().query(
      `DELETE FROM provider_call_telemetry WHERE trace_id LIKE 'adversarial-test-%'`,
    ).catch(() => undefined);
    await closeDb().catch(() => undefined);
  }
});
