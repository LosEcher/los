import assert from 'node:assert/strict';
import test from 'node:test';

import { loadConfig } from '@los/infra/config';
import { closeDb, initDb } from '@los/infra/db';

import {
  _resetFleetHostCheckStoreForTests,
  DEFAULT_FLEET_HOST_TARGETS,
  decideFleetHostRepair,
  measureFleetOfflineShare,
  parseHostCheckOutput,
  resolveFleetHostTargets,
  runFleetHostChecks,
  type FleetHostCheckResult,
  type FleetHostCheckRunOptions,
  type FleetHostTarget,
  type RepairDecisionContext,
} from './fleet-host-checks.js';
import {
  buildLinuxRemoteScript,
  buildLinuxRepairScript,
  buildWindowsRepairScript,
  parseRepairOutput,
} from './fleet-host-check-ssh.js';

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
      'DISK=62% 73400320',
    ].join('\n'),
    '',
    0,
    12,
  );
  assert.equal(ok.status, 'ok');
  assert.equal(ok.healthOk, true);
  assert.equal(ok.memAvailableMb, 4700);
  assert.equal(ok.swapUsedMb, 1000);
  assert.equal(ok.diskUsedPct, 62);
  assert.equal(ok.diskAvailableMb, 71680); // 73400320 KB / 1024

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

  // 磁盘高水位（≥90%）→ degraded；DISK=n/a（windows 侧）保持 ok 且字段 null
  const diskFull = parseHostCheckOutput(
    sampleTarget,
    'UNIT=active\nHEALTH={"status":"ok"}\nLISTEN=0.0.0.0:8090\nMEM=9946 4700\nSWAP=6046 1000\nDISK=93% 1048576\n',
    '',
    0,
    12,
  );
  assert.equal(diskFull.status, 'degraded');
  assert.equal(diskFull.diskUsedPct, 93);

  const diskNa = parseHostCheckOutput(
    { ...sampleTarget, platform: 'windows' },
    'UNIT=running\nHEALTH={"status":"ok"}\nLISTEN=n/a\nMEM=n/a\nSWAP=n/a\nDISK=n/a\n',
    '',
    0,
    12,
  );
  assert.equal(diskNa.diskUsedPct, null);
  assert.equal(diskNa.status, 'ok');
});

test('buildLinuxRemoteScript is bounded and mentions unit/port', () => {
  const script = buildLinuxRemoteScript(sampleTarget);
  assert.match(script, /los-executor/);
  assert.match(script, /8090/);
  assert.ok(!script.includes('; rm '));
});

test('repair scripts are idempotent and carry REPAIR_ markers', () => {
  const start = buildLinuxRepairScript(sampleTarget, 'start');
  assert.match(start, /systemctl is-active los-executor/);
  assert.match(start, /REPAIR_STATE=/);
  assert.match(start, /REPAIR_EXIT=/);

  const restart = buildLinuxRepairScript(sampleTarget, 'restart');
  assert.match(restart, /systemctl restart los-executor/);

  const winStart = buildWindowsRepairScript(
    { ...sampleTarget, platform: 'windows' },
    'start',
  );
  assert.match(winStart, /net start los-executor/);
  assert.match(winStart, /REPAIR_STATE=running/);
  assert.ok(!winStart.includes('; rm '));

  const parsed = parseRepairOutput('REPAIR_EXIT=0\nREPAIR_STATE=active');
  assert.equal(parsed.exitCode, 0);
  assert.equal(parsed.state, 'active');
});

test('decideFleetHostRepair gates by flag/health/cooldown/failures/quorum', () => {
  const ctx = (over: Partial<RepairDecisionContext> = {}): RepairDecisionContext => ({
    target: sampleTarget,
    check: {
      nodeId: sampleTarget.nodeId,
      sshHost: sampleTarget.sshHost,
      platform: 'linux',
      status: 'failed',
      durationMs: 5,
      unitActive: 'inactive',
      healthOk: false,
      detail: 'unit=inactive',
    } as FleetHostCheckResult,
    lastRepairAtMs: 0,
    repairFailures: 0,
    autoRepair: true,
    repairCooldownMs: 30 * 60_000,
    repairMaxConsecutiveFailures: 3,
    restartUnhealthy: false,
    nowMs: 1_000_000,
    offlineFleetShare: 0,
    ...over,
  });

  assert.equal(decideFleetHostRepair(ctx({ autoRepair: false })).skipReason, 'disabled');
  assert.equal(
    decideFleetHostRepair(ctx({ check: { ...ctx().check, status: 'ok' } })).skipReason,
    'healthy',
  );
  assert.equal(
    decideFleetHostRepair(ctx({ check: { ...ctx().check, unitActive: 'missing' } })).skipReason,
    'unit_missing',
  );
  assert.equal(
    decideFleetHostRepair(ctx({ lastRepairAtMs: 1_000_000 - 1000 })).skipReason,
    'repair_cooldown',
  );
  assert.equal(
    decideFleetHostRepair(ctx({ repairFailures: 3 })).skipReason,
    'consecutive_failures',
  );
  assert.equal(
    decideFleetHostRepair(ctx({ offlineFleetShare: 0.9 })).skipReason,
    'quorum_guard',
  );

  const start = decideFleetHostRepair(ctx());
  assert.equal(start.action, 'start');
  // Unit up but unhealthy: restart is opt-in; default skips.
  const unhealthy = ctx({ check: { ...ctx().check, unitActive: 'active', healthOk: false } });
  assert.equal(decideFleetHostRepair(unhealthy).skipReason, 'unhealthy_unit');
  assert.equal(
    decideFleetHostRepair(unhealthy).action,
    null,
  );
  assert.equal(
    decideFleetHostRepair(ctx({ restartUnhealthy: true, check: unhealthy.check })).action,
    'restart',
  );
});

test('measureFleetOfflineShare computes registry offline share and fails open', async () => {
  const nodes = [
    { nodeId: 'a', status: 'online' },
    { nodeId: 'b', status: 'offline' },
    { nodeId: 'c', status: 'offline' },
    { nodeId: 'x', status: 'online' }, // not in fleet
  ];
  const share = await measureFleetOfflineShare(['a', 'b', 'c'], async () => nodes);
  assert.equal(share, 2 / 3);
  const empty = await measureFleetOfflineShare([], async () => nodes);
  assert.equal(empty, 0);
  const broken = await measureFleetOfflineShare(['a', 'b'], async () => {
    throw new Error('db down');
  });
  assert.equal(broken, 0); // fail open
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

test('runFleetHostChecks auto-repair: executes, counts failures, respects cooldown and quorum', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  _resetFleetHostCheckStoreForTests();
  try {
    const db = (await import('@los/infra/db')).getDb();
    await db.exec('DROP TABLE IF EXISTS fleet_host_check_state');
    _resetFleetHostCheckStoreForTests();

    const target: FleetHostTarget = {
      ...sampleTarget,
      nodeId: 'r1',
      sshHost: 'h1',
      minIntervalMs: 60_000,
    };
    const failingHost: FleetHostCheckRunOptions['hostRunner'] = async () => ({
      stdout: 'UNIT=inactive\nHEALTH=curl: fail\nLISTEN=\nMEM=1 1\nSWAP=1 1\n',
      stderr: '',
      exitCode: 0,
    });
    const okRepair = async () => ({
      stdout: 'REPAIR_EXIT=0\nREPAIR_STATE=active',
      stderr: '',
      exitCode: 0,
    });

    // 1. autoRepair disabled -> no repair call
    let repairs = 0;
    const r1 = await runFleetHostChecks({
      force: true,
      targets: [target],
      quiet: true,
      autoRepair: false,
      hostRunner: failingHost,
      repairRunner: async () => { repairs += 1; return okRepair(); },
    });
    assert.equal(r1.failed.length, 1);
    assert.equal(repairs, 0);
    assert.equal(r1.repairs[0]?.outcome, 'skipped');
    assert.equal(r1.repairs[0]?.skipReason, 'disabled');

    // 2. autoRepair enabled -> start action, outcome repaired, failures reset
    repairs = 0;
    const r2 = await runFleetHostChecks({
      force: true,
      targets: [target],
      autoRepair: true,
      hostRunner: failingHost,
      repairRunner: async () => { repairs += 1; return okRepair(); },
    });
    assert.equal(repairs, 1);
    assert.equal(r2.repairs[0]?.action, 'start');
    assert.equal(r2.repairs[0]?.outcome, 'repaired');

    // decision audit event + out-of-band node command record are persisted
    const decisions = await db.query(
      `SELECT type FROM session_events
        WHERE session_id = $1 AND type = 'ops.fleet_host_repair_decision'
        ORDER BY id DESC LIMIT 1`,
      ['ops:fleet-repair:r1'],
    );
    assert.equal(decisions.rows.length, 1);
    const oob = await db.query(
      `SELECT command_id, node_id, command, status, args_json, output_json
         FROM node_commands WHERE node_id = $1 ORDER BY created_at DESC LIMIT 1`,
      ['r1'],
    );
    assert.equal(oob.rows.length, 1);
    assert.equal(oob.rows[0]?.status, 'succeeded');
    assert.equal(oob.rows[0]?.command, 'restart');
    const oobArgs = (oob.rows[0]?.args_json as Record<string, unknown>) ?? {};
    assert.equal(oobArgs.action, 'start');
    assert.equal(oobArgs.transport, 'ssh');

    // 3. repair cooldown: immediate re-run skips repair
    repairs = 0;
    const r3 = await runFleetHostChecks({
      force: true,
      targets: [target],
      quiet: true,
      autoRepair: true,
      hostRunner: failingHost,
      repairRunner: async () => { repairs += 1; return okRepair(); },
    });
    assert.equal(repairs, 0);
    assert.equal(r3.repairs[0]?.skipReason, 'repair_cooldown');

    // 4. failed repair increments consecutive counter
    await db.query('UPDATE fleet_host_check_state SET last_repair_at = NULL WHERE node_id = $1', [target.nodeId]);
    const r4 = await runFleetHostChecks({
      force: true,
      targets: [target],
      quiet: true,
      autoRepair: true,
      repairCooldownMs: 1,
      hostRunner: failingHost,
      repairRunner: async () => ({ stdout: 'REPAIR_EXIT=1\nREPAIR_STATE=inactive', stderr: '', exitCode: 1 }),
    });
    assert.equal(r4.repairs[0]?.outcome, 'failed');

    // 5. quorum guard: offline share > 50% -> skip repair
    await db.query('UPDATE fleet_host_check_state SET last_repair_at = NULL, repair_failures = 0 WHERE node_id = $1', [target.nodeId]);
    repairs = 0;
    const r5 = await runFleetHostChecks({
      force: true,
      targets: [target],
      quiet: true,
      autoRepair: true,
      offlineFleetShare: 0.9,
      hostRunner: failingHost,
      repairRunner: async () => { repairs += 1; return okRepair(); },
    });
    assert.equal(repairs, 0);
    assert.equal(r5.repairs[0]?.skipReason, 'quorum_guard');
  } finally {
    await closeDb().catch(() => undefined);
  }
});
