import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '@los/infra/config';
import { initDb, closeDb, getDb } from '@los/infra/db';

import { runGovernanceSweepLoop } from './governance-wake.js';
import { ensureSessionEventStore, listSessionEvents } from './session-events.js';
import { ensureGovernanceJobStore } from './governance-jobs-schema.js';

test('runGovernanceSweepLoop with zero due jobs does not write sweep session events', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  await ensureGovernanceJobStore();
  await ensureSessionEventStore();

  // Push every active job far into the future so none are due.
  await getDb().query(
    `UPDATE governance_jobs
     SET next_run_at = now() + interval '7 days'
     WHERE status = 'active'`,
  ).catch(() => undefined);

  const before = await getDb().query<{ cnt: string }>(
    `SELECT COUNT(*)::text AS cnt FROM session_events
     WHERE type IN ('governance.sweep.started', 'governance.sweep.completed')`,
  );
  const beforeCount = Number(before.rows[0]?.cnt ?? 0);

  const result = await runGovernanceSweepLoop({ dryRun: true });
  assert.equal(result.jobsRun, 0);
  assert.equal('drift' in result, false, 'no-due fallback must not scan stale drift baselines');

  const after = await getDb().query<{ cnt: string }>(
    `SELECT COUNT(*)::text AS cnt FROM session_events
     WHERE type IN ('governance.sweep.started', 'governance.sweep.completed')`,
  );
  const afterCount = Number(after.rows[0]?.cnt ?? 0);

  assert.equal(
    afterCount,
    beforeCount,
    `noop sweep must not append governance.sweep.* events (before=${beforeCount} after=${afterCount})`,
  );

  // Sanity: list API still works (no throw).
  await listSessionEvents('gov-sweep-noop-probe', 10);

  await closeDb().catch(() => undefined);
});
