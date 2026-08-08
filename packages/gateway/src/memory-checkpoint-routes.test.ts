/**
 * GET /memory/checkpoint/:sessionId — cross-tenant/project read guard.
 *
 * Regression: the route called getLatestCheckpoint(sessionId) with no access
 * context, so any authenticated user knowing a foreign sessionId could read
 * its compaction summary. Non-operators must be pinned to their own
 * tenant/project; operators may target another scope via query params.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { setConfig, type Config } from '@los/infra/config';
import { getDb, initDb } from '@los/infra/db';
import { ensureMemoryCompactionStore } from '@los/memory';
import { registerRequestContext } from './request-context.js';
import { registerMemoryRoutes } from './routes/data/memory-routes.js';

function buildConfig(): Config {
  return {
    databaseUrl: 'postgres://los:los@127.0.0.1:5432/los',
    server: { port: 8080, host: '127.0.0.1', corsOrigin: 'http://localhost:5173', localEndpoints: [] },
    auth: {
      enabled: true,
      token: 'test-token',
      operatorToken: 'op-secret',
    },
    integrations: { feedAnalysis: {
      resultReturningEnabled: true, maxInlineBytes: 1048576, maxItems: 500,
      materialHosts: [], materialFetchTimeoutMs: 10000, executionTimeoutMs: 120000, callbackPollMs: 5000, callbackProfiles: {},
    } },
    agent: {
      defaultProvider: 'deepseek',
      defaultModel: 'deepseek-v4-flash',
      maxLoops: 20,
      sandboxMode: 'workspace-write',
      allowNativeShell: false,
      identity: { name: 'default', inheritForChildren: false },
    },
    judge: {},
    review: { enabled: false, roles: {} },
    providers: {},
    memory: {
      ftsEnabled: true,
      maxObservations: 10000,
      persistChatDefault: true,
      selfReflectionEnabled: false,
      codeGraph: {
        enabled: false, shadowMode: false, injectArchitecture: false,
        cbmCommand: 'codebase-memory-mcp', cbmArgs: [], maxPromptTokens: 400,
      },
    },
    executor: { enabled: false, host: '127.0.0.1', port: 8090, shutdownGraceMs: 120_000, nodeKind: 'executor', connectModes: [], meshNodes: [] },
    profile: 'test',
    defaultProjectId: 'los',
    migrationsDir: 'packages/infra/migrations',
  };
}

async function insertCheckpoint(sessionId: string, tenantId: string, projectId: string, note: string): Promise<string> {
  await ensureMemoryCompactionStore();
  const id = `chkpt-route-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  await getDb().query(
    `INSERT INTO memory_compactions (id, session_id, tenant_id, project_id, summary_json)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [id, sessionId, tenantId, projectId, JSON.stringify({ note })],
  );
  return id;
}

test('checkpoint route scopes reads to caller tenant/project; operator can pivot', async () => {
  const config = buildConfig();
  setConfig(config);
  await initDb(config.databaseUrl);
  const app = Fastify({ logger: false });
  await registerRequestContext(app, config);
  registerMemoryRoutes(app);

  const sessionId = `chkpt-route-session-${Date.now()}`;
  const mine = await insertCheckpoint(sessionId, 'local', 'los', 'mine');
  const foreign = await insertCheckpoint(sessionId, 'other-tenant', 'other-project', 'foreign');
  try {
    // Authenticated non-operator: pinned to local/los — the foreign row must
    // not leak even though both rows share the sessionId.
    const res = await app.inject({
      method: 'GET', url: `/memory/checkpoint/${sessionId}`,
      headers: { 'x-los-auth-token': 'test-token' },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { checkpoint: { id: string } | null };
    assert.ok(body.checkpoint, 'own-scope checkpoint must be returned');
    assert.equal(body.checkpoint!.id, mine);

    // Non-operator cannot pivot via query params.
    const forged = await app.inject({
      method: 'GET',
      url: `/memory/checkpoint/${sessionId}?tenantId=other-tenant&projectId=other-project`,
      headers: { 'x-los-auth-token': 'test-token' },
    });
    assert.equal((forged.json() as { checkpoint: { id: string } | null }).checkpoint?.id, mine,
      'scope headers/query must not pivot a non-operator read');

    // Operator may target another tenant/project explicitly.
    const opRes = await app.inject({
      method: 'GET',
      url: `/memory/checkpoint/${sessionId}?tenantId=other-tenant&projectId=other-project`,
      headers: { 'x-los-auth-token': 'test-token', 'x-los-operator-token': 'op-secret' },
    });
    assert.equal(opRes.statusCode, 200);
    assert.equal((opRes.json() as { checkpoint: { id: string } | null }).checkpoint?.id, foreign);
  } finally {
    await app.close();
    await getDb().query('DELETE FROM memory_compactions WHERE id IN ($1, $2)', [mine, foreign]).catch(() => undefined);
  }
});
