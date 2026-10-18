import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import Fastify from 'fastify';

import { createHash } from 'node:crypto';
import { getDb } from '@los/infra/db';

import { registerNodeRoutes } from './routes/infrastructure/node-routes.js';
import type { NodeRouteDependencies } from './routes/infrastructure/node-routes.js';
import { _credentialExpiryWarning } from './node-credential-expiry.js';
import {
  ensureNodeEnrollmentStore,
  issueNodeEnrollmentToken,
  redeemNodeEnrollmentToken,
  verifyNodeCredential,
} from '@los/agent/node-enrollment';

// ── Stub deps: in-memory executor node store, no DB ──

const stubNodes = new Map<string, Record<string, unknown>>();

const stubDeps: NodeRouteDependencies = {
  ensureExecutorNodeStore: async () => {},
  listExecutorNodes: async (_limit?: number) => Array.from(stubNodes.values()) as any,
  loadExecutorNode: async (nodeId: string) => (stubNodes.get(nodeId) ?? null) as any,
  recordExecutorNodeProbe: async (input) => {
    const existing = stubNodes.get(input.nodeId) ?? {};
    const updated = {
      ...existing,
      ...input,
      verified: input.verified ?? {},
      execution: (existing as any).execution ?? { candidate: false, blockers: [] },
    };
    stubNodes.set(input.nodeId, updated);
    return updated as any;
  },
  upsertExecutorNode: async (input) => {
    const existing = stubNodes.get(input.nodeId);
    const merged = { ...existing, ...input };
    stubNodes.set(input.nodeId, merged);
    return merged as any;
  },
  upsertExecutorNodeHeartbeat: async (input) => {
    const existing = stubNodes.get(input.nodeId) ?? { nodeId: input.nodeId };
    const updated = { ...existing, ...input, lastHeartbeat: new Date().toISOString() };
    stubNodes.set(input.nodeId, updated);
    return updated as any;
  },
  requireOperator: async () => true,
  appendNodeProbeEvent: async (input) => ({
    id: 1,
    nodeId: input.nodeId,
    fromStatus: input.fromStatus,
    toStatus: input.toStatus,
    at: new Date().toISOString(),
    detail: input.detail,
  }),
  listNodeProbeEvents: async (_nodeId: string, _limit?: number) => [],
};

test('node infrastructure routes require operator access', async () => {
  const app = Fastify({ logger: false });
  const gatedDeps: NodeRouteDependencies = {
    ...stubDeps,
    requireOperator: async (_req, reply) => {
      await reply.code(403).send({ error: 'operator token required' });
      return false;
    },
  };
  registerNodeRoutes(app, gatedDeps);

  const requests = [
    { method: 'GET', url: '/nodes' },
    { method: 'PATCH', url: '/nodes/node-1', payload: { status: 'offline' } },
    { method: 'POST', url: '/nodes/node-1/probe' },
    { method: 'POST', url: '/nodes/node-1/ssh-run', payload: { command: 'id' } },
    { method: 'POST', url: '/nodes/import-ssh-config', payload: { content: 'Host node-1' } },
  ] as const;

  for (const request of requests) {
    const response = await app.inject(request);
    assert.equal(response.statusCode, 403, `${request.method} ${request.url} must be operator-only`);
    assert.deepEqual(response.json(), { error: 'operator token required' });
  }

  await app.close();
});

test('node heartbeat persists executor draining status and active task count', async () => {
  const nodeId = `test-heartbeat-draining-${Date.now()}`;
  const app = Fastify({ logger: false });
  registerNodeRoutes(app, stubDeps);

  const response = await app.inject({
    method: 'POST',
    url: '/nodes/heartbeat',
    payload: {
      nodeId,
      status: 'draining',
      activeTaskCount: 2,
      capabilities: { run_agent: false },
    },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().status, 'draining');

  const stored = stubNodes.get(nodeId);
  assert.ok(stored);
  assert.equal(stored?.status, 'draining');
  assert.equal(stored?.activeTaskCount, 2);

  await app.close();
});

test('node probe verifies non-executor http_health without creating an executor candidate', async () => {
  const nodeId = `test-http-health-${Date.now()}`;
  const healthServer = createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true }));
  });
  const app = Fastify({ logger: false });
  registerNodeRoutes(app, stubDeps);

  stubNodes.set(nodeId, {
    nodeId,
    nodeKind: 'ssh_target',
    status: 'offline',
    connectModes: ['http_health'],
    connectConfig: {},
    capabilities: { run_agent: false },
    verified: {},
    queueDepth: 0,
    activeTaskCount: 0,
    meshLinks: [],
    execution: { candidate: false, blockers: ['node_kind:ssh_target'] },
  });

  try {
    await listen(healthServer);
    const address = healthServer.address() as AddressInfo;
    const endpoint = `http://127.0.0.1:${address.port}/api/v1/healthz`;
    // Update stub node with the real endpoint
    const existing = stubNodes.get(nodeId)!;
    existing.connectConfig = { http_health: { endpoint } };
    stubNodes.set(nodeId, existing);

    const response = await app.inject({
      method: 'POST',
      url: `/nodes/${nodeId}/probe`,
    });
    assert.equal(response.statusCode, 200);
    const data = response.json();
    assert.equal(data.probe.status, 'online');
    assert.equal(data.node.verified.http_health.ok, true);
    assert.equal(data.node.execution.candidate, false);
    assert.ok(data.node.execution.blockers.includes('node_kind:ssh_target'));
  } finally {
    stubNodes.delete(nodeId);
    await closeServer(healthServer);
    await app.close();
  }
});

test('node probe parses socks5 endpoints as tcp socket targets', async () => {
  const nodeId = `test-socks5-proxy-${Date.now()}`;
  const socketServer = createServer((_req, res) => {
    res.end();
  });
  const app = Fastify({ logger: false });
  registerNodeRoutes(app, stubDeps);

  stubNodes.set(nodeId, {
    nodeId,
    nodeKind: 'proxy',
    status: 'offline',
    connectModes: ['socks5'],
    connectConfig: {},
    capabilities: { proxy_egress: true, run_agent: false },
    verified: {},
    queueDepth: 0,
    activeTaskCount: 0,
    meshLinks: [],
    execution: { candidate: false, blockers: ['node_kind:proxy'] },
  });

  try {
    await listen(socketServer);
    const address = socketServer.address() as AddressInfo;

    // Update stub node with the real sock5 endpoint
    const existing = stubNodes.get(nodeId)!;
    existing.connectConfig = { socks5: { endpoint: `socks5://127.0.0.1:${address.port}` } };
    stubNodes.set(nodeId, existing);

    const response = await app.inject({
      method: 'POST',
      url: `/nodes/${nodeId}/probe`,
    });
    assert.equal(response.statusCode, 200);
    const data = response.json();
    assert.equal(data.probe.status, 'online');
    assert.equal(data.node.verified.socks5.ok, true);
    assert.equal(data.node.execution.candidate, false);
    assert.ok(data.node.execution.blockers.includes('node_kind:proxy'));
  } finally {
    stubNodes.delete(nodeId);
    await closeServer(socketServer);
    await app.close();
  }
});

test('node heartbeat validates the per-node credential when present (ADR 0048 B3)', async () => {
  await ensureNodeEnrollmentStore();
  const stamp = Date.now();
  const nodeId = `test-cred-${stamp}`;
  const otherNodeId = `test-cred-other-${stamp}`;
  const token = await issueNodeEnrollmentToken(nodeId);
  const issued = await redeemNodeEnrollmentToken(token.token, nodeId);
  assert.ok(issued, 'enrollment token must redeem into a node credential');

  const app = Fastify({ logger: false });
  registerNodeRoutes(app, stubDeps);
  try {
    // Valid credential for this node ⇒ accepted, and the row is stored.
    const ok = await app.inject({
      method: 'POST',
      url: '/nodes/heartbeat',
      headers: { 'x-los-node-credential': issued!.credential },
      payload: { nodeId },
    });
    assert.equal(ok.statusCode, 200);
    assert.ok(stubNodes.get(nodeId));

    // A credential belonging to a different node must not attribute this heartbeat.
    const mismatched = await app.inject({
      method: 'POST',
      url: '/nodes/heartbeat',
      headers: { 'x-los-node-credential': issued!.credential },
      payload: { nodeId: otherNodeId },
    });
    assert.equal(mismatched.statusCode, 401);
    assert.equal(stubNodes.has(otherNodeId), false, 'a rejected heartbeat must not create a row');

    // An unknown credential is refused rather than silently ignored.
    const bogus = await app.inject({
      method: 'POST',
      url: '/nodes/heartbeat',
      headers: { 'x-los-node-credential': 'not-a-real-credential' },
      payload: { nodeId },
    });
    assert.equal(bogus.statusCode, 401);

    // Transition leniency: a node that has not enrolled yet still heartbeats, so the
    // fleet is not cut over until every node can send a credential.
    const lenient = await app.inject({
      method: 'POST',
      url: '/nodes/heartbeat',
      payload: { nodeId },
    });
    assert.equal(lenient.statusCode, 200);
  } finally {
    await app.close();
  }
});

test('enrollment stores a 30-day expiry and expired credentials are refused (C.2 第 3 条)', async () => {
  await ensureNodeEnrollmentStore();
  const stamp = Date.now();
  const nodeId = `test-cred-ttl-${stamp}`;
  const token = await issueNodeEnrollmentToken(nodeId);

  const app = Fastify({ logger: false });
  registerNodeRoutes(app, stubDeps);
  try {
    const enrolled = await app.inject({
      method: 'POST',
      url: '/nodes/enroll',
      payload: { token: token.token, nodeId },
    });
    assert.equal(enrolled.statusCode, 200);
    const body = enrolled.json() as { credential: string; expiresAt: string };
    const remainingDays = (new Date(body.expiresAt).getTime() - Date.now()) / (24 * 60 * 60_000);
    assert.ok(remainingDays > 29 && remainingDays <= 30.1, `default TTL must be ~30d, got ${remainingDays}d`);

    const verified = await verifyNodeCredential(body.credential);
    assert.equal(verified?.nodeId, nodeId);
    assert.equal(verified?.expiresAt, body.expiresAt, 'stored expiry must be the one returned to the node');

    const beat = await app.inject({
      method: 'POST',
      url: '/nodes/heartbeat',
      headers: { 'x-los-node-credential': body.credential },
      payload: { nodeId },
    });
    assert.equal(beat.statusCode, 200);

    // An already-expired credential must stop authenticating — not just report an old date.
    const expiredNodeId = `test-cred-expired-${stamp}`;
    const expiredToken = await issueNodeEnrollmentToken(expiredNodeId);
    const expired = await redeemNodeEnrollmentToken(expiredToken.token, expiredNodeId, -60_000);
    assert.ok(expired);
    assert.equal(await verifyNodeCredential(expired!.credential), null);
    const expiredBeat = await app.inject({
      method: 'POST',
      url: '/nodes/heartbeat',
      headers: { 'x-los-node-credential': expired!.credential },
      payload: { nodeId: expiredNodeId },
    });
    assert.equal(expiredBeat.statusCode, 401);
  } finally {
    await app.close();
  }
});

test('node can rotate its own credential; the old value survives only the overlap window', async () => {
  await ensureNodeEnrollmentStore();
  const stamp = Date.now();
  const nodeId = `test-cred-rotate-${stamp}`;
  const token = await issueNodeEnrollmentToken(nodeId);
  const first = await redeemNodeEnrollmentToken(token.token, nodeId);
  assert.ok(first);

  const app = Fastify({ logger: false });
  registerNodeRoutes(app, stubDeps);
  try {
    const rotated = await app.inject({
      method: 'POST',
      url: '/nodes/credential/rotate',
      headers: { 'x-los-node-credential': first!.credential },
      payload: {},
    });
    assert.equal(rotated.statusCode, 200);
    const body = rotated.json() as { nodeId: string; credential: string; expiresAt: string };
    assert.equal(body.nodeId, nodeId);
    assert.notEqual(body.credential, first!.credential);
    assert.ok(new Date(body.expiresAt).getTime() > Date.now() + 29 * 24 * 60 * 60_000);

    // Both values work during the overlap window: the old one for continuity,
    // the new one as the active credential.
    assert.equal((await verifyNodeCredential(first!.credential))?.nodeId, nodeId);
    assert.equal((await verifyNodeCredential(body.credential))?.nodeId, nodeId);

    // Heartbeat now reports the active expiry and no rotation pressure at 30d.
    const beat = await app.inject({
      method: 'POST',
      url: '/nodes/heartbeat',
      headers: { 'x-los-node-credential': body.credential },
      payload: { nodeId },
    });
    assert.equal(beat.statusCode, 200);
    assert.equal(beat.json().credentialRotationDue, false);
    assert.equal(beat.json().credentialExpiresAt, body.expiresAt);

    // Rotating again with the now-previous value is refused (only the active value may rotate).
    const reRotateOld = await app.inject({
      method: 'POST',
      url: '/nodes/credential/rotate',
      headers: { 'x-los-node-credential': first!.credential },
      payload: {},
    });
    assert.equal(reRotateOld.statusCode, 401);

    // Once the overlap window closes, the old value must stop authenticating.
    await getDb().query(
      `UPDATE node_enrollments SET previous_valid_until = now() - interval '1 second' WHERE node_id = $1`,
      [nodeId],
    );
    assert.equal(await verifyNodeCredential(first!.credential), null);
    assert.equal((await verifyNodeCredential(body.credential))?.nodeId, nodeId);
  } finally {
    await app.close();
  }
});

test('legacy rows without expires_at are grandfathered to enrolled_at + 365d', async () => {
  await ensureNodeEnrollmentStore();
  const stamp = Date.now();
  const freshNodeId = `test-cred-legacy-fresh-${stamp}`;
  const ancientNodeId = `test-cred-legacy-old-${stamp}`;
  const freshCredential = `legacy-fresh-${stamp}`;
  const ancientCredential = `legacy-old-${stamp}`;
  const hash = (v: string) => createHash('sha256').update(v).digest('hex');

  await getDb().query(
    `INSERT INTO node_enrollments (node_id, credential_hash, enrolled_at, expires_at)
     VALUES ($1, $2, now() - interval '10 days', NULL),
            ($3, $4, now() - interval '400 days', NULL)
     ON CONFLICT (node_id) DO UPDATE
       SET credential_hash = EXCLUDED.credential_hash,
           enrolled_at = EXCLUDED.enrolled_at,
           expires_at = NULL,
           revoked_at = NULL`,
    [freshNodeId, hash(freshCredential), ancientNodeId, hash(ancientCredential)],
  );

  const fresh = await verifyNodeCredential(freshCredential);
  assert.equal(fresh?.nodeId, freshNodeId);
  const remainingDays = (new Date(fresh!.expiresAt).getTime() - Date.now()) / (24 * 60 * 60_000);
  assert.ok(remainingDays > 354 && remainingDays <= 355, `legacy expiry must be enrolled_at + 365d, got ${remainingDays}d`);

  assert.equal(await verifyNodeCredential(ancientCredential), null, 'a legacy credential older than 365d must be rejected');
});

test('_credentialExpiryWarning: 7-day window, renders days, never warns in the past', () => {
  const now = Date.parse('2026-10-18T00:00:00Z');
  const at = (days: number) => new Date(now + days * 24 * 60 * 60_000).toISOString();

  assert.equal(_credentialExpiryWarning('node-a', at(8), now), undefined);
  assert.match(_credentialExpiryWarning('node-a', at(6.2), now)!, /node-a expires in 7d/);
  assert.match(_credentialExpiryWarning('node-a', at(0.5), now)!, /expires in 1d/);
  assert.equal(_credentialExpiryWarning('node-a', at(-1), now), undefined);
});

function listen(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
}

function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise(resolve => server.close(() => resolve()));
}
