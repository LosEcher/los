import assert from 'node:assert/strict';
import test from 'node:test';

import { loadConfig } from '@los/infra/config';
import { closeDb, initDb } from '@los/infra/db';

import {
  _resetFleetAlertConfigStoreForTests,
  clearFleetAlertConfig,
  loadFleetAlertConfig,
  resolveFleetAlertConfig,
  upsertFleetAlertConfig,
} from './fleet-alert-config.js';

const defaults = { consecutiveTicks: 2, cooldownMs: 30 * 60_000 };

test('resolveFleetAlertConfig: DB > env > defaults chain', async () => {
  const envOnly = await resolveFleetAlertConfig(
    { LOS_FLEET_ALERT_CONSECUTIVE_TICKS: '5', LOS_FLEET_ALERT_COOLDOWN_MS: '600000' },
    defaults,
  );
  assert.equal(envOnly.consecutiveTicks, 5);
  assert.equal(envOnly.cooldownMs, 600_000);

  const invalidEnv = await resolveFleetAlertConfig(
    { LOS_FLEET_ALERT_CONSECUTIVE_TICKS: '0', LOS_FLEET_ALERT_COOLDOWN_MS: '-1' },
    defaults,
  );
  assert.equal(invalidEnv.consecutiveTicks, 2); // invalid → default
  assert.equal(invalidEnv.cooldownMs, 30 * 60_000);

  const pureDefaults = await resolveFleetAlertConfig({}, defaults);
  assert.deepEqual(pureDefaults, defaults);
});

test('upsert/load/clear alert config round-trips with audit; Zod rejects invalid', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  _resetFleetAlertConfigStoreForTests();
  try {
    const db = (await import('@los/infra/db')).getDb();
    await db.exec('DROP TABLE IF EXISTS fleet_alert_config');
    _resetFleetAlertConfigStoreForTests();

    assert.equal(await loadFleetAlertConfig(), null);

    const saved = await upsertFleetAlertConfig(
      { consecutiveTicks: 3, cooldownMs: 60_000 },
      { source: 'test' },
    );
    assert.equal(saved.consecutiveTicks, 3);
    assert.equal(saved.cooldownMs, 60_000);

    // DB overrides env
    const resolved = await resolveFleetAlertConfig(
      { LOS_FLEET_ALERT_CONSECUTIVE_TICKS: '9' },
      defaults,
    );
    assert.equal(resolved.consecutiveTicks, 3);

    // Partial update keeps untouched fields
    const updated = await upsertFleetAlertConfig({ cooldownMs: 120_000 });
    assert.equal(updated.cooldownMs, 120_000);
    assert.equal(updated.consecutiveTicks, 3);

    // Audit written
    const events = await db.query(
      `SELECT type FROM session_events
        WHERE type = 'ops.config_changed' AND session_id = 'ops:config:fleet_alert_config'
        ORDER BY id DESC LIMIT 1`,
    );
    assert.equal(events.rows.length, 1);

    // Zod fail-closed
    await assert.rejects(upsertFleetAlertConfig({ consecutiveTicks: 0 }), /consecutiveTicks/);

    assert.equal(await clearFleetAlertConfig({ source: 'test' }), true);
    assert.equal(await loadFleetAlertConfig(), null);
  } finally {
    await closeDb().catch(() => undefined);
  }
});
