import assert from 'node:assert/strict';
import test from 'node:test';

import { loadConfig } from '@los/infra/config';
import { closeDb, initDb } from '@los/infra/db';

import {
  _resetNodeMaintenancePolicyStoreForTests,
  deleteNodeMaintenancePolicy,
  isNodeInMaintenance,
  loadNodeMaintenancePoliciesBatch,
  loadNodeMaintenancePolicy,
  upsertNodeMaintenancePolicy,
  type NodeMaintenancePolicy,
} from './node-maintenance-policy.js';

test('isNodeInMaintenance: pure window boundary checks', () => {
  const start = '2026-08-20T02:00:00.000Z';
  const end = '2026-08-20T03:00:00.000Z';
  const policy: NodeMaintenancePolicy = {
    nodeId: 'node34-executor-1',
    windows: [{ start, end }],
    updatedAt: '2026-08-19T00:00:00.000Z',
  };

  assert.equal(isNodeInMaintenance('node34-executor-1', Date.parse('2026-08-20T02:30:00.000Z'), policy), true);
  // Inclusive boundaries: exactly at start and exactly at end are in-window.
  assert.equal(isNodeInMaintenance('node34-executor-1', Date.parse(start), policy), true);
  assert.equal(isNodeInMaintenance('node34-executor-1', Date.parse(end), policy), true);
  // 1ms before start / 1ms after end are outside.
  assert.equal(isNodeInMaintenance('node34-executor-1', Date.parse('2026-08-20T01:59:59.999Z'), policy), false);
  assert.equal(isNodeInMaintenance('node34-executor-1', Date.parse('2026-08-20T03:00:00.001Z'), policy), false);
  // Null / empty policy is never in maintenance.
  assert.equal(isNodeInMaintenance('node34-executor-1', Date.parse('2026-08-20T02:30:00.000Z'), null), false);
  assert.equal(
    isNodeInMaintenance('node34-executor-1', Date.parse('2026-08-20T02:30:00.000Z'), {
      nodeId: 'node34-executor-1',
      windows: [],
      updatedAt: 'x',
    }),
    false,
  );
  // Multiple windows: any hit is enough.
  const multi: NodeMaintenancePolicy = {
    nodeId: 'n',
    windows: [
      { start: '2026-08-19T02:00:00.000Z', end: '2026-08-19T03:00:00.000Z' },
      { start, end },
    ],
    updatedAt: 'x',
  };
  assert.equal(isNodeInMaintenance('n', Date.parse('2026-08-19T02:30:00.000Z'), multi), true);
});

test('node_maintenance_policy store round-trips; Zod rejects invalid windows', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  _resetNodeMaintenancePolicyStoreForTests();
  try {
    const db = (await import('@los/infra/db')).getDb();
    await db.exec('DROP TABLE IF EXISTS node_maintenance_policy');
    _resetNodeMaintenancePolicyStoreForTests();

    assert.equal(await loadNodeMaintenancePolicy('node34-executor-1'), null);

    const saved = await upsertNodeMaintenancePolicy('node34-executor-1', {
      windows: [{ start: '2026-08-20T02:00:00.000Z', end: '2026-08-20T03:00:00.000Z' }],
    }, { source: 'test' });
    assert.equal(saved.windows.length, 1);
    assert.equal(saved.nodeId, 'node34-executor-1');

    const loaded = await loadNodeMaintenancePolicy('node34-executor-1');
    assert.equal(loaded?.windows[0]?.start, '2026-08-20T02:00:00.000Z');

    // Batch load: absent nodes map to null.
    const batch = await loadNodeMaintenancePoliciesBatch(['node34-executor-1', 'other']);
    assert.ok(batch['node34-executor-1']);
    assert.equal(batch.other, null);

    // Replace windows wholesale.
    await upsertNodeMaintenancePolicy('node34-executor-1', {
      windows: [{ start: '2026-08-21T02:00:00.000Z', end: '2026-08-21T03:00:00.000Z' }],
    }, { source: 'test' });
    const replaced = await loadNodeMaintenancePolicy('node34-executor-1');
    assert.equal(replaced?.windows.length, 1);
    assert.equal(replaced?.windows[0]?.start, '2026-08-21T02:00:00.000Z');

    // Invalid windows rejected fail-closed.
    await assert.rejects(() =>
      upsertNodeMaintenancePolicy('node34-executor-1', {
        windows: [{ start: 'not-a-date', end: '2026-08-21T03:00:00.000Z' }],
      }),
    );
    await assert.rejects(() =>
      upsertNodeMaintenancePolicy('node34-executor-1', {
        windows: [{ start: '2026-08-21T04:00:00.000Z', end: '2026-08-21T03:00:00.000Z' }],
      }),
    );

    assert.equal(await deleteNodeMaintenancePolicy('node34-executor-1', { source: 'test' }), true);
    assert.equal(await deleteNodeMaintenancePolicy('node34-executor-1', { source: 'test' }), false);
    assert.equal(await loadNodeMaintenancePolicy('node34-executor-1'), null);
  } finally {
    await closeDb();
  }
});
