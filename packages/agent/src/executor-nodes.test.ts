import test from 'node:test';
import assert from 'node:assert/strict';

import { closeDb, getDb, initDb } from '@los/infra/db';
import { loadConfig } from '@los/infra/config';
import {
  ensureExecutorNodeStore,
  evaluateExecutorNode,
  loadExecutorNode,
  listExecutorNodes,
  markStaleExecutorNodesOffline,
  recordExecutorNodeProbe,
  sortExecutorCandidates,
  upsertExecutorNode,
  upsertExecutorNodeHeartbeat,
  type ExecutorNodeRecord,
} from './executor-nodes.js';

test('executor node registry persists connectivity and capability fields', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  const nodeId = `test-executor-node-${Date.now()}`;
  try {
    await ensureExecutorNodeStore();

    const heartbeat = await upsertExecutorNodeHeartbeat({
      nodeId,
      nodeKind: 'executor',
      baseUrl: 'http://127.0.0.1:8090',
      hostLabel: 'local-box',
      connectModes: ['agent_http', 'agent_http_ndjson'],
      connectConfig: {
        agent_http: {
          endpoint: 'http://127.0.0.1:8090',
        },
      },
      capabilities: {
        shell: true,
        workspace_write: true,
      },
      queueDepth: 2,
      activeTaskCount: 1,
      meshLinks: [{ peer: 'gateway', mode: 'agent_http' }],
      capacity: { arch: 'arm64' },
    });

    assert.equal(heartbeat.nodeKind, 'executor');
    assert.deepEqual(heartbeat.connectModes, ['agent_http', 'agent_http_ndjson']);
    assert.equal(heartbeat.queueDepth, 2);
    assert.equal(heartbeat.activeTaskCount, 1);
    const agentHttp = heartbeat.connectConfig.agent_http as Record<string, unknown> | undefined;
    assert.equal(agentHttp?.endpoint, 'http://127.0.0.1:8090');

    const probed = await recordExecutorNodeProbe({
      nodeId,
      verified: {
        agent_http: {
          ok: true,
          checked_at: new Date().toISOString(),
        },
      },
      status: 'online',
    });

    assert.equal(probed.nodeId, nodeId);
    const verifiedAgentHttp = probed.verified.agent_http as Record<string, unknown> | undefined;
    assert.equal(verifiedAgentHttp?.ok, true);

    const nodes = await listExecutorNodes(10);
    const loaded = nodes.find(node => node.nodeId === nodeId);
    assert.ok(loaded);
    assert.equal(loaded?.hostLabel, 'local-box');
    assert.equal(loaded?.nodeKind, 'executor');
    assert.equal(loaded?.connectModes[0], 'agent_http');
    assert.equal(loaded?.meshLinks[0]?.peer, 'gateway');
  } finally {
    await getDb().query('DELETE FROM executor_nodes WHERE node_id = $1', [nodeId]).catch(() => undefined);
    await closeDb().catch(() => undefined);
  }
});

test('manual executor node upsert preserves non-executor boundaries', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  const nodeId = `test-ssh-target-${Date.now()}`;
  try {
    await ensureExecutorNodeStore();

    const saved = await upsertExecutorNode({
      nodeId,
      nodeKind: 'ssh_target',
      hostLabel: 'HStorage2',
      status: 'offline',
      connectModes: ['tailscale_ssh'],
      connectConfig: {
        tailscale_ssh: {
          endpoint: 'root@100.86.24.22:23452',
          source: 'ssh_config',
          alias: 'hh-sgp1-r-t',
        },
      },
      capabilities: {
        run_agent: false,
      },
    });

    assert.equal(saved.nodeKind, 'ssh_target');
    assert.equal(saved.execution.candidate, false);
    assert.ok(saved.execution.blockers.includes('node_kind:ssh_target'));
    assert.ok(saved.execution.blockers.includes('connect_mode:missing_agent_http'));
    assert.ok(saved.execution.blockers.includes('capability:run_agent_missing'));

    const loaded = await loadExecutorNode(nodeId);
    assert.equal(loaded?.hostLabel, 'HStorage2');
    assert.deepEqual(loaded?.connectModes, ['tailscale_ssh']);
    assert.equal(loaded?.capabilities.run_agent, false);
  } finally {
    await getDb().query('DELETE FROM executor_nodes WHERE node_id = $1', [nodeId]).catch(() => undefined);
    await closeDb().catch(() => undefined);
  }
});

test('executor heartbeat preserves draining status until promoted', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  const nodeId = `test-draining-heartbeat-${Date.now()}`;
  try {
    await ensureExecutorNodeStore();

    await upsertExecutorNode({
      nodeId,
      nodeKind: 'executor',
      status: 'draining',
      baseUrl: 'http://127.0.0.1:8090',
      connectModes: ['agent_http'],
      connectConfig: {
        agent_http: { baseUrl: 'http://127.0.0.1:8090' },
      },
      capabilities: { run_agent: true },
    });

    const heartbeat = await upsertExecutorNodeHeartbeat({
      nodeId,
      nodeKind: 'executor',
      baseUrl: 'http://127.0.0.1:8090',
      connectModes: ['agent_http'],
      connectConfig: {
        agent_http: { baseUrl: 'http://127.0.0.1:8090' },
      },
      capabilities: { run_agent: true },
    });

    assert.equal(heartbeat.status, 'draining');
    assert.equal(heartbeat.execution.candidate, false);

    const promoted = await upsertExecutorNodeHeartbeat({
      nodeId,
      nodeKind: 'executor',
      status: 'online',
      baseUrl: 'http://127.0.0.1:8090',
      connectModes: ['agent_http'],
      connectConfig: {
        agent_http: { baseUrl: 'http://127.0.0.1:8090' },
      },
      capabilities: { run_agent: true },
    });

    assert.equal(promoted.status, 'online');
  } finally {
    await getDb().query('DELETE FROM executor_nodes WHERE node_id = $1', [nodeId]).catch(() => undefined);
    await closeDb().catch(() => undefined);
  }
});

test('executor heartbeat merges runtime modes with existing management paths', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  const nodeId = `test-heartbeat-merge-${Date.now()}`;
  try {
    await ensureExecutorNodeStore();

    await upsertExecutorNode({
      nodeId,
      nodeKind: 'ssh_target',
      status: 'online',
      connectModes: ['tailscale_ssh', 'http_health'],
      connectConfig: {
        tailscale_ssh: { endpoint: '100.68.106.96:22' },
        http_health: { endpoint: 'http://100.68.106.96:28082/api/v1/healthz' },
      },
      capabilities: { run_agent: false, remote_ssh: true },
    });

    const heartbeat = await upsertExecutorNodeHeartbeat({
      nodeId,
      nodeKind: 'executor',
      baseUrl: 'http://100.68.106.96:8090',
      connectModes: ['agent_http', 'agent_http_ndjson'],
      connectConfig: {
        agent_http: { baseUrl: 'http://100.68.106.96:8090' },
      },
      capabilities: { run_agent: true, stream_ndjson: true },
    });

    assert.equal(heartbeat.nodeKind, 'executor');
    assert.deepEqual(heartbeat.connectModes, ['tailscale_ssh', 'http_health', 'agent_http', 'agent_http_ndjson']);
    assert.equal((heartbeat.connectConfig.tailscale_ssh as Record<string, unknown>).endpoint, '100.68.106.96:22');
    assert.equal((heartbeat.connectConfig.agent_http as Record<string, unknown>).baseUrl, 'http://100.68.106.96:8090');
    assert.equal(heartbeat.capabilities.remote_ssh, true);
    assert.equal(heartbeat.capabilities.run_agent, true);
  } finally {
    await getDb().query('DELETE FROM executor_nodes WHERE node_id = $1', [nodeId]).catch(() => undefined);
    await closeDb().catch(() => undefined);
  }
});

test('executor heartbeat preserves rollout metadata until updated explicitly', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  const nodeId = `test-rollout-metadata-${Date.now()}`;
  try {
    await ensureExecutorNodeStore();

    await upsertExecutorNode({
      nodeId,
      nodeKind: 'executor',
      status: 'online',
      version: '0.1.0',
      targetVersion: '0.2.0',
      rolloutState: 'upgrading',
      rolloutMessage: 'rolling out 0.2.0',
      baseUrl: 'http://127.0.0.1:8090',
      connectModes: ['agent_http'],
      connectConfig: {
        agent_http: { baseUrl: 'http://127.0.0.1:8090' },
      },
      capabilities: { run_agent: true },
    });

    const heartbeat = await upsertExecutorNodeHeartbeat({
      nodeId,
      nodeKind: 'executor',
      baseUrl: 'http://127.0.0.1:8090',
      connectModes: ['agent_http'],
      connectConfig: {
        agent_http: { baseUrl: 'http://127.0.0.1:8090' },
      },
      capabilities: { run_agent: true },
    });

    assert.equal(heartbeat.targetVersion, '0.2.0');
    assert.equal(heartbeat.rolloutState, 'upgrading');
    assert.equal(heartbeat.rolloutMessage, 'rolling out 0.2.0');
  } finally {
    await getDb().query('DELETE FROM executor_nodes WHERE node_id = $1', [nodeId]).catch(() => undefined);
    await closeDb().catch(() => undefined);
  }
});

test('markStaleExecutorNodesOffline only marks stale online nodes offline', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  const suffix = Date.now();
  const staleNodeId = `test-stale-offline-${suffix}`;
  const freshNodeId = `test-fresh-online-${suffix}`;
  try {
    await ensureExecutorNodeStore();

    for (const nodeId of [staleNodeId, freshNodeId]) {
      await upsertExecutorNodeHeartbeat({
        nodeId,
        nodeKind: 'executor',
        baseUrl: 'http://127.0.0.1:8090',
        connectModes: ['agent_http'],
        capabilities: { run_agent: true },
      });
    }
    await getDb().query(
      `UPDATE executor_nodes SET last_heartbeat_at = now() - interval '2 minutes' WHERE node_id = $1`,
      [staleNodeId],
    );

    const result = await markStaleExecutorNodesOffline(60_000);
    assert.ok(result.updated.some(node => node.nodeId === staleNodeId));
    assert.ok(!result.updated.some(node => node.nodeId === freshNodeId));

    const stale = await loadExecutorNode(staleNodeId);
    const fresh = await loadExecutorNode(freshNodeId);
    assert.equal(stale?.status, 'offline');
    assert.equal(fresh?.status, 'online');
  } finally {
    await getDb().query('DELETE FROM executor_nodes WHERE node_id = ANY($1)', [[staleNodeId, freshNodeId]]).catch(() => undefined);
    await closeDb().catch(() => undefined);
  }
});

test('executor node probe success clears previous probe error', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  const nodeId = `test-probe-error-clear-${Date.now()}`;
  try {
    await ensureExecutorNodeStore();

    await upsertExecutorNode({
      nodeId,
      nodeKind: 'proxy',
      status: 'offline',
      connectModes: ['socks5'],
      connectConfig: {
        socks5: { endpoint: 'socks5://127.0.0.1:2080' },
      },
      capabilities: { proxy_egress: true, run_agent: false },
      lastProbeError: 'old failure',
    });

    const probed = await recordExecutorNodeProbe({
      nodeId,
      status: 'online',
      verified: {
        socks5: {
          ok: true,
          checked_at: new Date().toISOString(),
        },
      },
      lastProbeError: null,
    });

    assert.equal(probed.lastProbeError, undefined);
    const loaded = await loadExecutorNode(nodeId);
    assert.equal(loaded?.lastProbeError, undefined);
  } finally {
    await getDb().query('DELETE FROM executor_nodes WHERE node_id = $1', [nodeId]).catch(() => undefined);
    await closeDb().catch(() => undefined);
  }
});

test('executor node classification rejects ingress and proxy nodes', () => {
  const executor = evaluateExecutorNode({
    nodeId: 'exec-node',
    nodeKind: 'executor',
    baseUrl: 'http://127.0.0.1:8090',
    hostLabel: 'exec',
    status: 'online',
    version: '0.1.0',
    connectModes: ['agent_http'],
    connectConfig: {},
    capacity: {},
    capabilities: { run_agent: true },
    verified: {
      agent_http: { ok: true, checked_at: new Date().toISOString() },
    },
    queueDepth: 0,
    activeTaskCount: 0,
    meshLinks: [],
    lastHeartbeatAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  assert.equal(executor.candidate, true);
  assert.equal(executor.mode, 'agent_http');

  const proxy = evaluateExecutorNode({
    nodeId: 'proxy-node',
    nodeKind: 'proxy',
    status: 'online',
    connectModes: ['socks5'],
    connectConfig: {},
    capacity: {},
    capabilities: { proxy_egress: true },
    verified: {},
    queueDepth: 0,
    activeTaskCount: 0,
    meshLinks: [],
    lastHeartbeatAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  assert.equal(proxy.candidate, false);
  assert.ok(proxy.blockers.includes('node_kind:proxy'));
});

test('executor node classification rejects stale heartbeat executors', () => {
  const stale = evaluateExecutorNode({
    nodeId: 'stale-exec-node',
    nodeKind: 'executor',
    baseUrl: 'http://127.0.0.1:8090',
    status: 'online',
    connectModes: ['agent_http'],
    connectConfig: {},
    capacity: {},
    capabilities: { run_agent: true },
    verified: {
      agent_http: { ok: true, checked_at: new Date().toISOString() },
    },
    queueDepth: 0,
    activeTaskCount: 0,
    meshLinks: [],
    lastHeartbeatAt: new Date(Date.now() - 120_000).toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  assert.equal(stale.candidate, false);
  assert.ok(stale.blockers.includes('heartbeat:stale'));
});

test('executor node classification rejects wildcard routing URLs', () => {
  const execution = evaluateExecutorNode(testExecutorNode({
    baseUrl: 'http://0.0.0.0:8091',
    connectModes: ['agent_http', 'agent_http_ndjson'],
    connectConfig: {
      agent_http: { baseUrl: 'http://0.0.0.0:8091' },
    },
    verified: {
      agent_http_ndjson: { ok: true, checked_at: new Date().toISOString() },
    },
  }));

  assert.equal(execution.candidate, false);
  assert.ok(execution.blockers.includes('connect_url:wildcard_host'));
});

test('executor node classification blocks critical memory pressure', () => {
  const execution = evaluateExecutorNode(testExecutorNode({
    capacity: { memoryTotalMb: 1000, memoryAvailableMb: 40 },
  }));

  assert.equal(execution.candidate, false);
  assert.ok(execution.blockers.includes('resource:memory_pressure'));
});

test('executor candidate sorting deprioritizes warning-level memory pressure', () => {
  const pressured = executorNodeRecord('pressured', {
    memoryTotalMb: 1000,
    memoryAvailableMb: 80,
  });
  const healthy = executorNodeRecord('healthy', {
    memoryTotalMb: 1000,
    memoryAvailableMb: 500,
  });

  assert.deepEqual(sortExecutorCandidates([pressured, healthy], pressured.nodeId).map(node => node.nodeId), ['healthy', 'pressured']);
});

function testExecutorNode(overrides: Partial<ExecutorNodeRecord> = {}): Omit<ExecutorNodeRecord, 'execution'> {
  const { execution: _execution, ...node } = executorNodeRecord('test-node', overrides.capacity ?? {});
  return { ...node, ...overrides };
}

function executorNodeRecord(nodeId: string, capacity: ExecutorNodeRecord['capacity']): ExecutorNodeRecord {
  const now = new Date().toISOString();
  const node = {
    nodeId,
    nodeKind: 'executor' as const,
    status: 'online' as const,
    connectModes: ['agent_http'],
    connectConfig: {},
    capacity,
    capabilities: { run_agent: true },
    verified: { agent_http: { ok: true, checked_at: now } },
    queueDepth: 0,
    activeTaskCount: 0,
    meshLinks: [],
    lastHeartbeatAt: now,
    createdAt: now,
    updatedAt: now,
  };
  return { ...node, execution: evaluateExecutorNode(node) };
}
