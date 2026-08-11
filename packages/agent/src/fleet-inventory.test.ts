import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig } from '@los/infra/config';
import { closeDb, initDb } from '@los/infra/db';
import type { ExecutorNodeRecord } from './executor-nodes.js';
import {
  DEFAULT_NAMED_FLEET_NODE_IDS,
  _resetFleetWatchStoreForTests,
  classifyNamedFleetNode,
  evaluateNamedFleet,
  resolveFleetAlertConsecutiveTicks,
  resolveFleetAlertCooldownMs,
  resolveNamedFleetNodeIds,
  tickNamedFleetWatch,
} from './fleet-inventory.js';

function node(
  partial: Partial<ExecutorNodeRecord> & { nodeId: string },
): ExecutorNodeRecord {
  const status = partial.status ?? 'online';
  const candidate = partial.execution?.candidate ?? (status === 'online');
  const blockers = partial.execution?.blockers
    ?? (candidate ? [] : ['verification:agent_http_ndjson:not_confirmed']);
  return {
    nodeId: partial.nodeId,
    nodeKind: partial.nodeKind ?? 'executor',
    baseUrl: partial.baseUrl ?? 'http://127.0.0.1:8090',
    status,
    version: partial.version ?? '0.1.0+test',
    connectModes: partial.connectModes ?? ['agent_http_ndjson'],
    connectConfig: partial.connectConfig ?? {},
    capacity: partial.capacity ?? {},
    capabilities: partial.capabilities ?? { run_agent: true },
    verified: partial.verified ?? {},
    queueDepth: 0,
    activeTaskCount: 0,
    meshLinks: [],
    lastHeartbeatAt: partial.lastHeartbeatAt ?? new Date().toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    execution: {
      candidate,
      mode: 'agent_http_ndjson',
      blockers,
      warnings: [],
    },
  };
}

test('resolveNamedFleetNodeIds defaults and parses env', () => {
  assert.deepEqual(resolveNamedFleetNodeIds({}), [...DEFAULT_NAMED_FLEET_NODE_IDS]);
  assert.deepEqual(
    resolveNamedFleetNodeIds({ LOS_FLEET_NODE_IDS: ' a,b ; c  d ' }),
    ['a', 'b', 'c', 'd'],
  );
  assert.equal(resolveFleetAlertConsecutiveTicks({}), 2);
  assert.equal(resolveFleetAlertConsecutiveTicks({ LOS_FLEET_ALERT_CONSECUTIVE_TICKS: '3' }), 3);
  assert.equal(resolveFleetAlertCooldownMs({ LOS_FLEET_ALERT_COOLDOWN_MS: '60000' }), 60_000);
});

test('classifyNamedFleetNode covers healthy offline unverified missing', () => {
  assert.equal(
    classifyNamedFleetNode('x', node({ nodeId: 'x', execution: { candidate: true, blockers: [], warnings: [], mode: 'agent_http_ndjson' } })).health,
    'healthy',
  );
  assert.equal(
    classifyNamedFleetNode('x', node({ nodeId: 'x', status: 'offline', execution: { candidate: false, blockers: ['status:offline'], warnings: [], mode: 'agent_http_ndjson' } })).health,
    'offline',
  );
  assert.equal(
    classifyNamedFleetNode('x', node({
      nodeId: 'x',
      status: 'online',
      execution: { candidate: false, blockers: ['verification:agent_http_ndjson:not_confirmed'], warnings: [], mode: 'agent_http_ndjson' },
    })).health,
    'online_unverified',
  );
  assert.equal(classifyNamedFleetNode('gone', undefined).health, 'missing');
});

test('evaluateNamedFleet only scores named ids', () => {
  const snap = evaluateNamedFleet(
    [
      node({ nodeId: 'mbp-executor-1', execution: { candidate: true, blockers: [], warnings: [], mode: 'agent_http_ndjson' } }),
      node({ nodeId: 'noise-executor', status: 'offline', execution: { candidate: false, blockers: ['status:offline'], warnings: [], mode: 'agent_http_ndjson' } }),
    ],
    ['mbp-executor-1', 'node34-executor-1'],
  );
  assert.deepEqual(snap.healthy, ['mbp-executor-1']);
  assert.deepEqual(snap.missing, ['node34-executor-1']);
  assert.deepEqual(snap.attentionNodeIds, ['node34-executor-1']);
  assert.ok(!snap.offline.includes('noise-executor'));
});

test('tickNamedFleetWatch alerts after consecutive ticks and respects cooldown', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  _resetFleetWatchStoreForTests();
  try {
    const db = (await import('@los/infra/db')).getDb();
    await db.exec('DROP TABLE IF EXISTS fleet_watch_state');
    _resetFleetWatchStoreForTests();

    const bad = [
      node({
        nodeId: 'mbp-executor-1',
        status: 'offline',
        execution: { candidate: false, blockers: ['status:offline'], warnings: [], mode: 'agent_http_ndjson' },
      }),
    ];
    const namedOnly = ['mbp-executor-1'];
    const prev = process.env.LOS_FLEET_NODE_IDS;
    process.env.LOS_FLEET_NODE_IDS = namedOnly.join(',');

    const t0 = new Date('2026-08-10T14:00:00.000Z');
    const first = await tickNamedFleetWatch(bad, {
      consecutiveTicks: 2,
      cooldownMs: 30 * 60_000,
      now: t0,
      dryRun: true,
    });
    assert.equal(first.emissions[0]?.consecutiveUnhealthy, 1);
    assert.equal(first.emissions[0]?.eventEmitted, false);
    assert.equal(first.emissions[0]?.skippedReason, 'below_threshold');

    const t1 = new Date('2026-08-10T14:15:00.000Z');
    const second = await tickNamedFleetWatch(bad, {
      consecutiveTicks: 2,
      cooldownMs: 30 * 60_000,
      now: t1,
      dryRun: true,
    });
    assert.equal(second.emissions[0]?.consecutiveUnhealthy, 2);
    assert.equal(second.emissions[0]?.skippedReason, 'dry_run');

    // Live emit once
    const live = await tickNamedFleetWatch(bad, {
      consecutiveTicks: 2,
      cooldownMs: 30 * 60_000,
      now: new Date('2026-08-10T14:16:00.000Z'),
    });
    assert.equal(live.emissions[0]?.eventEmitted, true);
    assert.deepEqual(live.alertedNodeIds, ['mbp-executor-1']);

    // Cooldown blocks
    const cooled = await tickNamedFleetWatch(bad, {
      consecutiveTicks: 2,
      cooldownMs: 30 * 60_000,
      now: new Date('2026-08-10T14:20:00.000Z'),
    });
    assert.equal(cooled.emissions[0]?.eventEmitted, false);
    assert.equal(cooled.emissions[0]?.skippedReason, 'cooldown');

    // Recovery resets consecutive
    const good = [
      node({
        nodeId: 'mbp-executor-1',
        execution: { candidate: true, blockers: [], warnings: [], mode: 'agent_http_ndjson' },
      }),
    ];
    const recovered = await tickNamedFleetWatch(good, {
      consecutiveTicks: 2,
      cooldownMs: 30 * 60_000,
      now: new Date('2026-08-10T14:21:00.000Z'),
      dryRun: true,
    });
    assert.equal(recovered.emissions[0]?.consecutiveUnhealthy, 0);
    assert.equal(recovered.emissions[0]?.skippedReason, 'healthy');

    if (prev === undefined) delete process.env.LOS_FLEET_NODE_IDS;
    else process.env.LOS_FLEET_NODE_IDS = prev;
  } finally {
    await closeDb().catch(() => undefined);
  }
});
