import assert from 'node:assert/strict';
import test from 'node:test';

import type { ExecutorNodeRecord } from './executor-nodes.js';
import {
  assessThresholdWithHysteresis,
  evaluateFleetNodeResources,
  evaluateNamedFleetResources,
  formatFleetResourceSummary,
  FLEET_MEM_AVAILABLE_WARN_RATIO,
  FLEET_MEM_AVAILABLE_CRITICAL_RATIO,
  FLEET_SWAP_USED_WARN_RATIO,
  FLEET_SWAP_USED_CRITICAL_RATIO,
  FLEET_HEARTBEAT_WARN_MS,
} from './fleet-resources.js';

function node(
  partial: Partial<ExecutorNodeRecord> & { nodeId: string },
): ExecutorNodeRecord {
  const status = partial.status ?? 'online';
  const candidate = partial.execution?.candidate ?? (status === 'online');
  return {
    nodeId: partial.nodeId,
    nodeKind: partial.nodeKind ?? 'executor',
    resourceClass: partial.resourceClass,
    baseUrl: partial.baseUrl ?? 'http://127.0.0.1:8090',
    status,
    version: partial.version ?? '0.1.0+test',
    connectModes: partial.connectModes ?? ['agent_http_ndjson'],
    connectConfig: partial.connectConfig ?? {},
    capacity: partial.capacity ?? {},
    capabilities: partial.capabilities ?? { run_agent: true },
    verified: partial.verified ?? {},
    queueDepth: partial.queueDepth ?? 0,
    activeTaskCount: partial.activeTaskCount ?? 0,
    meshLinks: [],
    lastHeartbeatAt: partial.lastHeartbeatAt ?? new Date().toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    execution: {
      candidate,
      mode: 'agent_http_ndjson',
      blockers: partial.execution?.blockers ?? [],
      warnings: partial.execution?.warnings ?? [],
    },
  };
}

test('memory available warning and critical thresholds', () => {
  const now = Date.now();
  const warn = evaluateFleetNodeResources(
    'mbp',
    node({
      nodeId: 'mbp',
      capacity: { memoryTotalMb: 1000, memoryAvailableMb: 100 }, // 10%
      lastHeartbeatAt: new Date(now).toISOString(),
    }),
    now,
  );
  assert.ok(warn.findings.some((f) => f.signal === 'memory_available' && f.severity === 'warning'));
  assert.ok(warn.memoryAvailableRatio! < FLEET_MEM_AVAILABLE_WARN_RATIO);

  const crit = evaluateFleetNodeResources(
    'mbp',
    node({
      nodeId: 'mbp',
      capacity: { memoryTotalMb: 1000, memoryAvailableMb: 40 }, // 4%
      lastHeartbeatAt: new Date(now).toISOString(),
    }),
    now,
  );
  assert.ok(crit.findings.some((f) => f.signal === 'memory_available' && f.severity === 'critical'));
});

test('swap used warning from heartbeat capacity', () => {
  const now = Date.now();
  const snap = evaluateFleetNodeResources(
    'node34-executor-1',
    node({
      nodeId: 'node34-executor-1',
      capacity: {
        memoryTotalMb: 10000,
        memoryAvailableMb: 5000,
        swapTotalMb: 6000,
        swapUsedMb: 4000, // ~66%
      },
      lastHeartbeatAt: new Date(now).toISOString(),
    }),
    now,
  );
  assert.ok(snap.swapUsedRatio! > FLEET_SWAP_USED_WARN_RATIO);
  assert.ok(snap.findings.some((f) => f.signal === 'swap_used' && f.severity === 'warning'));
  assert.ok(snap.findings.some((f) => f.code === 'resource:swap_high:node34-executor-1'));
});

test('light/oracle active tasks warn; healthy heavy node does not', () => {
  const now = Date.now();
  const oracle = evaluateFleetNodeResources(
    'oracle-executor',
    node({
      nodeId: 'oracle-executor',
      resourceClass: 'constrained_executor',
      activeTaskCount: 1,
      capacity: { memoryTotalMb: 954, memoryAvailableMb: 400 },
      lastHeartbeatAt: new Date(now).toISOString(),
    }),
    now,
  );
  assert.equal(oracle.lightNode, true);
  assert.ok(oracle.findings.some((f) => f.signal === 'active_tasks_light_node'));

  const mbp = evaluateFleetNodeResources(
    'mbp-executor-1',
    node({
      nodeId: 'mbp-executor-1',
      activeTaskCount: 2,
      capacity: { memoryTotalMb: 32768, memoryAvailableMb: 20000 },
      lastHeartbeatAt: new Date(now).toISOString(),
    }),
    now,
  );
  assert.equal(mbp.lightNode, false);
  assert.ok(!mbp.findings.some((f) => f.signal === 'active_tasks_light_node'));
});

test('heartbeat age warning without demoting when capacity is fine', () => {
  const now = Date.now();
  const lag = evaluateFleetNodeResources(
    'desktop',
    node({
      nodeId: 'desktop',
      capacity: { memoryTotalMb: 80000, memoryAvailableMb: 40000 },
      lastHeartbeatAt: new Date(now - (FLEET_HEARTBEAT_WARN_MS + 5_000)).toISOString(),
    }),
    now,
  );
  assert.ok(lag.findings.some((f) => f.signal === 'heartbeat_age' && f.severity === 'warning'));
});

test('evaluateNamedFleetResources only scores named ids and formats summary', () => {
  const now = Date.now();
  const snap = evaluateNamedFleetResources(
    [
      node({
        nodeId: 'oracle-executor',
        capacity: { memoryTotalMb: 1000, memoryAvailableMb: 50, swapTotalMb: 2000, swapUsedMb: 100 },
        lastHeartbeatAt: new Date(now).toISOString(),
      }),
      node({
        nodeId: 'noise',
        capacity: { memoryTotalMb: 1000, memoryAvailableMb: 10 },
        lastHeartbeatAt: new Date(now).toISOString(),
      }),
    ],
    ['oracle-executor', 'missing-node'],
    now,
  );
  assert.deepEqual(snap.namedIds, ['oracle-executor', 'missing-node']);
  assert.equal(snap.nodes.length, 2);
  // 50/1000 = 5% available → warning (<15%), not critical (<5%)
  assert.ok(snap.warningCodes.some((c) => c.includes('oracle-executor')));
  assert.ok(!snap.findings.some((f) => f.nodeId === 'noise'));
  const lines = formatFleetResourceSummary(snap);
  assert.ok(lines.some((l) => l.includes('oracle-executor')));
});

test('cpu load thresholds only when both fields present', () => {
  const now = Date.now();
  const high = evaluateFleetNodeResources(
    'n',
    node({
      nodeId: 'n',
      capacity: {
        memoryTotalMb: 8000,
        memoryAvailableMb: 4000,
        cpuLoad1m: 9,
        cpuCores: 2,
      } as ExecutorNodeRecord['capacity'],
      lastHeartbeatAt: new Date(now).toISOString(),
    }),
    now,
  );
  assert.ok(high.findings.some((f) => f.signal === 'cpu_load' && f.severity === 'critical'));

  const noCpu = evaluateFleetNodeResources(
    'n',
    node({
      nodeId: 'n',
      capacity: { memoryTotalMb: 8000, memoryAvailableMb: 4000 },
      lastHeartbeatAt: new Date(now).toISOString(),
    }),
    now,
  );
  assert.ok(!noCpu.findings.some((f) => f.signal === 'cpu_load'));
});

// ── Hysteresis (Komodo borrow P0-1) ─────────────────────────────────────────

test('assessThresholdWithHysteresis: below-direction memory semantics', () => {
  const rule = {
    warn: FLEET_MEM_AVAILABLE_WARN_RATIO,
    critical: FLEET_MEM_AVAILABLE_CRITICAL_RATIO,
    direction: 'below' as const,
  };
  const band = 0.03;
  // Enter warning/critical at raw thresholds regardless of prev.
  assert.equal(assessThresholdWithHysteresis(0.10, rule, undefined, band), 'warning');
  assert.equal(assessThresholdWithHysteresis(0.04, rule, 'warning', band), 'critical');
  // Defer clearing inside the band: [warn, warn+band) keeps warning.
  assert.equal(assessThresholdWithHysteresis(0.16, rule, 'warning', band), 'warning');
  // No prev inside the band → cleared (plain threshold behavior).
  assert.equal(assessThresholdWithHysteresis(0.16, rule, undefined, band), undefined);
  // Crossed back past warn+band → cleared.
  assert.equal(assessThresholdWithHysteresis(0.19, rule, 'warning', band), undefined);
  // Critical hysteresis: [critical, critical+band) keeps critical.
  assert.equal(assessThresholdWithHysteresis(0.06, rule, 'critical', band), 'critical');
  assert.equal(assessThresholdWithHysteresis(0.09, rule, 'critical', band), 'warning');
  // band=undefined → pure threshold, prev ignored.
  assert.equal(assessThresholdWithHysteresis(0.16, rule, 'warning', undefined), undefined);
  assert.equal(assessThresholdWithHysteresis(0.10, rule, 'warning', undefined), 'warning');
});

test('assessThresholdWithHysteresis: above-direction swap semantics', () => {
  const rule = {
    warn: FLEET_SWAP_USED_WARN_RATIO,
    critical: FLEET_SWAP_USED_CRITICAL_RATIO,
    direction: 'above' as const,
  };
  const band = 0.03;
  assert.equal(assessThresholdWithHysteresis(0.55, rule, undefined, band), 'warning');
  assert.equal(assessThresholdWithHysteresis(0.85, rule, 'warning', band), 'critical');
  // Defer clearing inside the band: (warn-band, warn] keeps warning.
  assert.equal(assessThresholdWithHysteresis(0.48, rule, 'warning', band), 'warning');
  assert.equal(assessThresholdWithHysteresis(0.48, rule, undefined, band), undefined);
  // Crossed back past warn-band → cleared.
  assert.equal(assessThresholdWithHysteresis(0.45, rule, 'warning', band), undefined);
  // Critical hysteresis: (critical-band, critical] keeps critical.
  assert.equal(assessThresholdWithHysteresis(0.79, rule, 'critical', band), 'critical');
  assert.equal(assessThresholdWithHysteresis(0.76, rule, 'critical', band), 'warning');
});

test('evaluateFleetNodeResources: hysteresis defers warning clearing', () => {
  const now = Date.now();
  const base = {
    nodeId: 'mbp',
    capacity: { memoryTotalMb: 1000 },
    lastHeartbeatAt: new Date(now).toISOString(),
  };
  // 16% available: inside the warning band.
  const kept = evaluateFleetNodeResources(
    'mbp',
    node({ ...base, capacity: { memoryTotalMb: 1000, memoryAvailableMb: 160 } }),
    now,
    { memory_available: 'warning' },
  );
  assert.ok(kept.findings.some((f) => f.signal === 'memory_available' && f.severity === 'warning'));

  // Same metric without prev → no finding (plain threshold behavior).
  const plain = evaluateFleetNodeResources(
    'mbp',
    node({ ...base, capacity: { memoryTotalMb: 1000, memoryAvailableMb: 160 } }),
    now,
  );
  assert.ok(!plain.findings.some((f) => f.signal === 'memory_available'));

  // 19% available: recovered past warn+band → cleared even with prev warning.
  const recovered = evaluateFleetNodeResources(
    'mbp',
    node({ ...base, capacity: { memoryTotalMb: 1000, memoryAvailableMb: 190 } }),
    now,
    { memory_available: 'warning' },
  );
  assert.ok(!recovered.findings.some((f) => f.signal === 'memory_available'));
});

test('evaluateNamedFleetResources: prevSeveritiesByNode is threaded through', () => {
  const now = Date.now();
  const snap = evaluateNamedFleetResources(
    [
      node({
        nodeId: 'mbp',
        capacity: { memoryTotalMb: 1000, memoryAvailableMb: 160 },
        lastHeartbeatAt: new Date(now).toISOString(),
      }),
    ],
    ['mbp'],
    now,
    { mbp: { memory_available: 'warning' } },
  );
  // In the band + prev warning → warning kept; without prev this would be clean.
  assert.ok(snap.warningCodes.some((c) => c === 'resource:memory_low:mbp'));
});
