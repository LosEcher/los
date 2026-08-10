import assert from 'node:assert/strict';
import test from 'node:test';

import { loadConfig } from '@los/infra/config';
import { closeDb, initDb } from '@los/infra/db';

import { getRuntimeHealth } from './runtime-health.js';

test('getRuntimeHealth returns L1 board with policy markers', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  try {
    const report = await getRuntimeHealth();
    assert.equal(report.evidenceClass, 'los_runtime');
    assert.ok(report.generatedAt);
    assert.ok(['ok', 'degraded', 'critical'].includes(report.overall));
    assert.ok(Array.isArray(report.blockers));
    assert.ok(Array.isArray(report.warnings));
    assert.ok(typeof report.services.total === 'number');
    assert.ok(typeof report.executors.total === 'number');
    assert.ok(Array.isArray(report.fleet.namedIds));
    assert.ok(report.fleet.namedIds.length >= 1);
    assert.ok(typeof report.fleet.healthy === 'number');
    assert.ok(Array.isArray(report.fleet.attentionNodeIds));
    assert.ok(typeof report.schedules.enabled === 'number');
    assert.ok(typeof report.governance.active === 'number');
    assert.equal(report.policy.controlPlane, 'gateway_embedded_timers');
    assert.equal(report.policy.noMainGaDaemon, true);
    assert.equal(report.policy.upgradePath, 'drain_restart_ready_smoke');
  } finally {
    await closeDb().catch(() => undefined);
  }
});
