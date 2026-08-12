import assert from 'node:assert/strict';
import test from 'node:test';
import type { ExecutorNodeRecord } from '@los/agent/executor-nodes';
import {
  isAutoProbeEligible,
  runNodeAutoProbeTick,
  selectAutoProbeTargets,
} from './node-auto-probe.js';
import { _resetRemoteExecutorCircuitsForTests } from './remote-executor-circuit.js';

function resetCircuits(): void {
  _resetRemoteExecutorCircuitsForTests();
}

function node(partial: Partial<ExecutorNodeRecord> & { nodeId: string }): ExecutorNodeRecord {
  const status = partial.status ?? 'online';
  const blockers = partial.execution?.blockers ?? ['verification:agent_http_ndjson:not_confirmed'];
  const candidate = partial.execution?.candidate ?? blockers.length === 0;
  return {
    nodeId: partial.nodeId,
    nodeKind: partial.nodeKind ?? 'executor',
    baseUrl: partial.baseUrl ?? 'http://100.0.0.1:8090',
    status,
    connectModes: partial.connectModes ?? ['agent_http', 'agent_http_ndjson'],
    connectConfig: partial.connectConfig ?? {
      agent_http: { baseUrl: 'http://100.0.0.1:8090', healthUrl: 'http://100.0.0.1:8090/health' },
    },
    capacity: partial.capacity ?? {},
    capabilities: partial.capabilities ?? { run_agent: true },
    verified: partial.verified ?? {
      agent_http_ndjson: { ok: false, reason: 'heartbeat_claim_requires_active_probe', source: 'heartbeat' },
    },
    queueDepth: partial.queueDepth ?? 0,
    activeTaskCount: partial.activeTaskCount ?? 0,
    meshLinks: partial.meshLinks ?? [],
    lastProbeAt: partial.lastProbeAt,
    lastHeartbeatAt: partial.lastHeartbeatAt ?? new Date().toISOString(),
    createdAt: partial.createdAt ?? new Date().toISOString(),
    updatedAt: partial.updatedAt ?? new Date().toISOString(),
    execution: {
      candidate,
      mode: 'agent_http_ndjson',
      blockers,
      warnings: partial.execution?.warnings ?? [],
    },
  };
}

test('isAutoProbeEligible requires online executor run_agent with only verification gap', () => {
  resetCircuits();
  assert.equal(isAutoProbeEligible(node({ nodeId: 'ok' })), true);
  assert.equal(isAutoProbeEligible(node({ nodeId: 'offline', status: 'offline' })), false);
  assert.equal(
    isAutoProbeEligible(node({ nodeId: 'ssh', nodeKind: 'ssh_target' })),
    false,
  );
  assert.equal(
    isAutoProbeEligible(node({ nodeId: 'no-run', capabilities: { run_agent: false } })),
    false,
  );
  assert.equal(
    isAutoProbeEligible(node({
      nodeId: 'candidate',
      execution: { candidate: true, blockers: [], warnings: [], mode: 'agent_http_ndjson' },
    })),
    false,
  );
  assert.equal(
    isAutoProbeEligible(node({
      nodeId: 'memory',
      execution: {
        candidate: false,
        mode: 'agent_http_ndjson',
        blockers: ['verification:agent_http_ndjson:not_confirmed', 'resource:memory_pressure'],
        warnings: [],
      },
    })),
    false,
  );
});

test('isAutoProbeEligible respects per-node cooldown from lastProbeAt', () => {
  resetCircuits();
  const now = Date.parse('2026-08-10T13:00:00.000Z');
  const recent = node({
    nodeId: 'recent',
    lastProbeAt: '2026-08-10T12:58:00.000Z',
  });
  assert.equal(isAutoProbeEligible(recent, 5 * 60_000, now), false);
  assert.equal(isAutoProbeEligible(recent, 60_000, now), true);
});

test('selectAutoProbeTargets sorts by freshest heartbeat and applies max selection later', () => {
  resetCircuits();
  const now = Date.now();
  const targets = selectAutoProbeTargets([
    node({ nodeId: 'older', lastHeartbeatAt: new Date(now - 20_000).toISOString() }),
    node({ nodeId: 'newer', lastHeartbeatAt: new Date(now - 5_000).toISOString() }),
    node({ nodeId: 'skip', status: 'offline' }),
  ], { now });
  assert.deepEqual(targets.map((n) => n.nodeId), ['newer', 'older']);
});

test('isAutoProbeEligible rejects stale heartbeats (boot / reboot grace)', () => {
  resetCircuits();
  const now = Date.now();
  assert.equal(
    isAutoProbeEligible(
      node({ nodeId: 'stale', lastHeartbeatAt: new Date(now - 60_000).toISOString() }),
      5 * 60_000,
      now,
    ),
    false,
  );
});

test('runNodeAutoProbeTick probes at most maxPerTick serially with gap and cooldown stamp', async () => {
  resetCircuits();
  const gaps: number[] = [];
  const probed: string[] = [];
  const records: Array<{ nodeId: string; lastProbeError: string | null | undefined }> = [];
  const now = Date.now();
  const nodes = [
    node({ nodeId: 'a', lastHeartbeatAt: new Date(now - 2_000).toISOString() }),
    node({ nodeId: 'b', lastHeartbeatAt: new Date(now - 5_000).toISOString() }),
    node({ nodeId: 'c', lastHeartbeatAt: new Date(now - 8_000).toISOString() }),
  ];

  const result = await runNodeAutoProbeTick({
    maxPerTick: 2,
    minProbeGapMs: 25,
    cooldownMs: 5 * 60_000,
    now,
    listNodes: async () => nodes,
    load: async (id) => nodes.find((n) => n.nodeId === id) ?? null,
    probe: async (n) => {
      probed.push(n.nodeId);
      return {
        status: 'online',
        verified: {
          agent_http: { ok: true, source: 'probe' },
          agent_http_ndjson: { ok: true, source: 'probe' },
        },
      };
    },
    record: async (input) => {
      records.push({ nodeId: input.nodeId, lastProbeError: input.lastProbeError });
      return node({ nodeId: input.nodeId });
    },
    sleep: async (ms) => {
      gaps.push(ms);
    },
  });

  assert.equal(result.eligible, 3);
  assert.deepEqual(result.probed, ['a', 'b']);
  assert.equal(result.skippedCooldown, 1);
  assert.deepEqual(probed, ['a', 'b']);
  assert.deepEqual(gaps, [25]);
  assert.equal(records.length, 2);
});

test('runNodeAutoProbeTick records failed probes so cooldown still applies', async () => {
  resetCircuits();
  const records: string[] = [];
  const n = node({ nodeId: 'flaky' });
  const result = await runNodeAutoProbeTick({
    maxPerTick: 1,
    minProbeGapMs: 0,
    listNodes: async () => [n],
    load: async () => n,
    probe: async () => {
      throw new Error('timeout');
    },
    record: async (input) => {
      records.push(`${input.nodeId}:${input.lastProbeError ?? ''}`);
      return n;
    },
    sleep: async () => undefined,
  });

  assert.deepEqual(result.failed, ['flaky']);
  assert.equal(records.length, 1);
  assert.match(records[0]!, /flaky:timeout/);
});
