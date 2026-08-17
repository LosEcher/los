import assert from 'node:assert/strict';
import test from 'node:test';

import { loadConfig } from '@los/infra/config';
import { closeDb, initDb } from '@los/infra/db';

import {
  _resetFleetRepairConfigStoreForTests,
  clearFleetRepairConfig,
  loadFleetRepairConfig,
  resolveGlobalRepairConfig,
  upsertFleetRepairConfig,
} from './fleet-repair-config.js';
import type { GlobalRepairConfig } from './node-recovery-policy.js';

const defaults: GlobalRepairConfig = {
  autoRepair: false,
  repairCooldownMs: 30 * 60_000,
  repairMaxConsecutiveFailures: 3,
  restartUnhealthy: false,
  quorumThreshold: 0.5,
};

test('resolveGlobalRepairConfig: DB > env > defaults chain', async () => {
  const envOnly = await resolveGlobalRepairConfig(
    { LOS_FLEET_AUTO_REPAIR: 'true', LOS_FLEET_REPAIR_COOLDOWN_MS: '60000' },
    defaults,
  );
  assert.equal(envOnly.autoRepair, true);
  assert.equal(envOnly.repairCooldownMs, 60_000);
  assert.equal(envOnly.quorumThreshold, 0.5); // from defaults

  const invalidEnv = await resolveGlobalRepairConfig(
    { LOS_FLEET_AUTO_REPAIR: 'maybe' },
    defaults,
  );
  assert.equal(invalidEnv.autoRepair, false); // invalid env ignored → default
});

test('upsert/load/clear global config round-trips with audit; Zod rejects invalid', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  _resetFleetRepairConfigStoreForTests();
  try {
    const db = (await import('@los/infra/db')).getDb();
    await db.exec('DROP TABLE IF EXISTS fleet_repair_config');
    _resetFleetRepairConfigStoreForTests();

    assert.equal(await loadFleetRepairConfig(), null);

    const saved = await upsertFleetRepairConfig(
      { autoRepair: true, cooldownMs: 600_000 },
      { source: 'test' },
    );
    assert.equal(saved.autoRepair, true);
    assert.equal(saved.cooldownMs, 600_000);
    assert.equal(saved.maxConsecutiveFailures, null);

    // DB now overrides env
    const resolved = await resolveGlobalRepairConfig(
      { LOS_FLEET_AUTO_REPAIR: 'false' },
      defaults,
    );
    assert.equal(resolved.autoRepair, true); // DB wins over env

    // Partial update keeps untouched fields
    const updated = await upsertFleetRepairConfig({ restartUnhealthy: true });
    assert.equal(updated.restartUnhealthy, true);
    assert.equal(updated.cooldownMs, 600_000);

    // Audit event was written for mutations
    const events = await db.query(
      `SELECT type FROM session_events
        WHERE type = 'ops.config_changed' AND session_id = 'ops:config:fleet_repair_config'
        ORDER BY id DESC LIMIT 1`,
    );
    assert.equal(events.rows.length, 1);

    // Zod fail-closed: invalid quorum threshold is rejected, nothing written
    await assert.rejects(
      upsertFleetRepairConfig({ quorumThreshold: 1.5 }),
      /quorumThreshold/,
    );

    assert.equal(await clearFleetRepairConfig({ source: 'test' }), true);
    assert.equal(await loadFleetRepairConfig(), null);
    // env fallback after clear
    const afterClear = await resolveGlobalRepairConfig(
      { LOS_FLEET_AUTO_REPAIR: 'true' },
      defaults,
    );
    assert.equal(afterClear.autoRepair, true);
  } finally {
    await closeDb().catch(() => undefined);
  }
});
