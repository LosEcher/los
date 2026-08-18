import assert from 'node:assert/strict';
import test from 'node:test';

import { loadConfig } from '@los/infra/config';
import { closeDb, initDb } from '@los/infra/db';

import {
  _resetNodeRecoveryPolicyStoreForTests,
  loadNodeRecoveryPolicy,
  resolveRepairConfig,
  upsertNodeRecoveryPolicy,
  type GlobalRepairConfig,
  type NodeRecoveryPolicy,
} from './node-recovery-policy.js';

const globalCfg: GlobalRepairConfig = {
  autoRepair: false,
  repairCooldownMs: 30 * 60_000,
  repairMaxConsecutiveFailures: 3,
  restartUnhealthy: false,
  quorumThreshold: 0.5,
};

const policy = (over: Partial<NodeRecoveryPolicy>): NodeRecoveryPolicy => ({
  nodeId: 'n1',
  supervisor: 'nssm',
  repairEnabled: null,
  cooldownMs: null,
  maxConsecutiveFailures: null,
  quorumThreshold: null,
  restartUnhealthy: null,
  updatedAt: '2026-08-17T00:00:00.000Z',
  ...over,
});

test('resolveRepairConfig: policy overrides global per field, null falls back', () => {
  // No policy → pure global
  assert.deepEqual(resolveRepairConfig(null, globalCfg), globalCfg);

  // Partial policy overrides only its own fields
  const partial = resolveRepairConfig(policy({ cooldownMs: 5000, restartUnhealthy: true }), globalCfg);
  assert.equal(partial.repairCooldownMs, 5000);
  assert.equal(partial.restartUnhealthy, true);
  assert.equal(partial.autoRepair, false); // from global
  assert.equal(partial.quorumThreshold, 0.5); // from global

  // repairEnabled=true flips global off→on
  const enabled = resolveRepairConfig(policy({ repairEnabled: true }), globalCfg);
  assert.equal(enabled.autoRepair, true);

  // repairEnabled=false is a hard kill switch even when global is on
  const killed = resolveRepairConfig(
    policy({ repairEnabled: false }),
    { ...globalCfg, autoRepair: true },
  );
  assert.equal(killed.autoRepair, false);
});

test('upsert/load node recovery policy round-trips through DB', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  _resetNodeRecoveryPolicyStoreForTests();
  try {
    const db = (await import('@los/infra/db')).getDb();
    await db.exec('DROP TABLE IF EXISTS node_recovery_policy');
    _resetNodeRecoveryPolicyStoreForTests();

    assert.equal(await loadNodeRecoveryPolicy('n1'), null);

    const saved = await upsertNodeRecoveryPolicy('n1', {
      supervisor: 'nssm',
      repairEnabled: true,
      cooldownMs: 600_000,
      restartUnhealthy: false,
    });
    assert.equal(saved.repairEnabled, true);
    assert.equal(saved.cooldownMs, 600_000);
    assert.equal(saved.supervisor, 'nssm');

    const loaded = await loadNodeRecoveryPolicy('n1');
    assert.equal(loaded?.nodeId, 'n1');
    assert.equal(loaded?.repairEnabled, true);
    assert.equal(loaded?.maxConsecutiveFailures, null);

    // Update (upsert) a field
    const updated = await upsertNodeRecoveryPolicy('n1', { maxConsecutiveFailures: 5 });
    assert.equal(updated.maxConsecutiveFailures, 5);
    assert.equal(updated.cooldownMs, 600_000); // untouched
  } finally {
    await closeDb().catch(() => undefined);
  }
});
