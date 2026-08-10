import assert from 'node:assert/strict';
import test from 'node:test';

import { loadConfig } from '@los/infra/config';
import { closeDb, initDb } from '@los/infra/db';

import {
  _resetFleetHostCheckStoreForTests,
  DEFAULT_FLEET_HOST_TARGETS,
  parseHostCheckOutput,
  resolveFleetHostTargets,
  runFleetHostChecks,
  type FleetHostTarget,
} from './fleet-host-checks.js';
import { buildLinuxRemoteScript } from './fleet-host-check-ssh.js';

const sampleTarget: FleetHostTarget = {
  nodeId: 'node34-executor-1',
  sshHost: 'localnode34-r-t',
  platform: 'linux',
  healthPort: 8090,
  unitName: 'los-executor',
  minIntervalMs: 15 * 60_000,
};

test('resolveFleetHostTargets defaults and none/env', () => {
  assert.equal(resolveFleetHostTargets({}).length, DEFAULT_FLEET_HOST_TARGETS.length);
  assert.deepEqual(resolveFleetHostTargets({ LOS_FLEET_HOST_CHECKS: 'none' }), []);
  const parsed = resolveFleetHostTargets({
    LOS_FLEET_HOST_CHECKS: 'a=host-a:linux:8090,b=host-b:windows:8091:mytask',
  });
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0]?.nodeId, 'a');
  assert.equal(parsed[0]?.platform, 'linux');
  assert.equal(parsed[1]?.platform, 'windows');
  assert.equal(parsed[1]?.unitName, 'mytask');
});

test('parseHostCheckOutput classifies ok/failed/degraded', () => {
  const ok = parseHostCheckOutput(
    sampleTarget,
    [
      'UNIT=active',
      'HEALTH={"status":"ok","nodeId":"node34-executor-1"}',
      'LISTEN=0.0.0.0:8090',
      'MEM=9946 4700',
      'SWAP=6046 1000',
    ].join('\n'),
    '',
    0,
    12,
  );
  assert.equal(ok.status, 'ok');
  assert.equal(ok.healthOk, true);
  assert.equal(ok.memAvailableMb, 4700);
  assert.equal(ok.swapUsedMb, 1000);

  const failed = parseHostCheckOutput(
    sampleTarget,
    'UNIT=inactive\nHEALTH=curl: fail\nLISTEN=\nMEM=1 1\nSWAP=1 1\n',
    '',
    0,
    5,
  );
  assert.equal(failed.status, 'failed');

  const degraded = parseHostCheckOutput(
    sampleTarget,
    'UNIT=active\nHEALTH={"status":"ok"}\nLISTEN=\nMEM=1 1\nSWAP=1 1\n',
    '',
    0,
    5,
  );
  assert.equal(degraded.status, 'degraded');
  assert.equal(degraded.listenOk, false);
});

test('buildLinuxRemoteScript is bounded and mentions unit/port', () => {
  const script = buildLinuxRemoteScript(sampleTarget);
  assert.match(script, /los-executor/);
  assert.match(script, /8090/);
  assert.ok(!script.includes('; rm '));
});

test('runFleetHostChecks dry-run and cooldown with injected hostRunner', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  _resetFleetHostCheckStoreForTests();
  try {
    const db = (await import('@los/infra/db')).getDb();
    await db.exec('DROP TABLE IF EXISTS fleet_host_check_state');
    _resetFleetHostCheckStoreForTests();

    const targets: FleetHostTarget[] = [
      { ...sampleTarget, nodeId: 't1', sshHost: 'h1' },
      {
        nodeId: 't2',
        sshHost: 'h2',
        platform: 'linux',
        healthPort: 8091,
        unitName: 'los-executor',
        minIntervalMs: 60_000,
      },
    ];

    const dry = await runFleetHostChecks({
      dryRun: true,
      targets,
      quiet: true,
    });
    assert.equal(dry.results.every((r) => r.status === 'skipped'), true);
    assert.equal(dry.results[0]?.skippedReason, 'dry_run_plan');

    let calls = 0;
    const first = await runFleetHostChecks({
      force: true,
      targets,
      quiet: true,
      hostRunner: async (target) => {
        calls += 1;
        return {
          stdout: [
            'UNIT=active',
            'HEALTH={"status":"ok"}',
            `LISTEN=0.0.0.0:${target.healthPort}`,
            'MEM=1000 500',
            'SWAP=100 10',
            '',
          ].join('\n'),
          stderr: '',
          exitCode: 0,
        };
      },
    });
    assert.equal(calls, 2);
    assert.deepEqual(first.ok.sort(), ['t1', 't2']);

    // Immediate re-run without force → cooldown skip
    const second = await runFleetHostChecks({
      targets,
      quiet: true,
      hostRunner: async () => {
        calls += 1;
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    });
    assert.equal(second.skipped.length, 2);
    assert.equal(calls, 2); // hostRunner not called again
  } finally {
    await closeDb().catch(() => undefined);
  }
});
