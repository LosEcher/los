/**
 * Regression tests for the operator consent gate (`requireOperator`).
 *
 * The bug being fixed: operator-only endpoints (steering injection
 * POST /sessions/:id/operator-events, the operator event stream
 * GET /operator/events/live, security scans) did NOT enforce operator
 * privilege. Any authenticated user (holding only x-los-auth-token) could
 * inject approve/deny/escalate steering and subscribe to other tenants'
 * operator attention events.
 *
 * `requireOperator` is the shared gate: 403 when auth is enabled and the
 * requester is not an operator (missing/invalid x-los-operator-token); allow
 * when auth is disabled (local single-user dev, no auth boundary). Operator
 * privilege is validated timing-safe in the request-context onRequest hook.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { setConfig, type Config } from '@los/infra/config';
import { registerRequestContext, requireOperator } from './request-context.js';

function buildConfig(opts: { authEnabled: boolean; operatorToken?: string }): Config {
  return {
    databaseUrl: 'postgres://los:los@127.0.0.1:5432/los',
    server: { port: 8080, host: '127.0.0.1', corsOrigin: 'http://localhost:5173', localEndpoints: [] },
    auth: {
      enabled: opts.authEnabled,
      token: 'test-token',
      ...(opts.operatorToken ? { operatorToken: opts.operatorToken } : {}),
    },
    agent: {
      defaultProvider: 'deepseek',
      defaultModel: 'deepseek-v4-flash',
      maxLoops: 20,
      sandboxMode: 'workspace-write',
      identity: { name: 'default', inheritForChildren: false },
    },
    judge: {},
    review: { enabled: false, roles: {} },
    providers: {},
    memory: {
      ftsEnabled: true,
      maxObservations: 10000,
      selfReflectionEnabled: false,
      codeGraph: {
        enabled: false, shadowMode: false, injectArchitecture: false,
        cbmCommand: 'codebase-memory-mcp', cbmArgs: [], maxPromptTokens: 400,
      },
    },
    executor: { enabled: false, host: '127.0.0.1', port: 8090, nodeKind: 'executor', connectModes: [], meshNodes: [] },
    profile: 'test',
    defaultProjectId: 'los',
    migrationsDir: 'packages/infra/migrations',
  };
}

async function buildApp(config: Config) {
  setConfig(config);
  const app = Fastify({ logger: false });
  await registerRequestContext(app, config);
  app.post('/op', async (req, reply) => {
    if (!(await requireOperator(req, reply))) return;
    return { ok: true };
  });
  return app;
}

test('operator gate allows when auth is disabled (no auth boundary)', async () => {
  const app = await buildApp(buildConfig({ authEnabled: false }));
  try {
    const res = await app.inject({ method: 'POST', url: '/op' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { ok: true });
  } finally {
    await app.close();
  }
});

test('operator gate rejects authenticated non-operator with 403', async () => {
  const app = await buildApp(buildConfig({ authEnabled: true, operatorToken: 'op-secret' }));
  try {
    // Authenticated (valid auth token) but no operator token → 403.
    const res = await app.inject({
      method: 'POST', url: '/op',
      headers: { 'x-los-auth-token': 'test-token' },
    });
    assert.equal(res.statusCode, 403);
    assert.deepEqual(res.json(), { error: 'operator token required' });
  } finally {
    await app.close();
  }
});

test('operator gate rejects wrong operator token with 403', async () => {
  const app = await buildApp(buildConfig({ authEnabled: true, operatorToken: 'op-secret' }));
  try {
    const res = await app.inject({
      method: 'POST', url: '/op',
      headers: { 'x-los-auth-token': 'test-token', 'x-los-operator-token': 'wrong' },
    });
    assert.equal(res.statusCode, 403);
  } finally {
    await app.close();
  }
});

test('operator gate allows valid operator token', async () => {
  const app = await buildApp(buildConfig({ authEnabled: true, operatorToken: 'op-secret' }));
  try {
    const res = await app.inject({
      method: 'POST', url: '/op',
      headers: { 'x-los-auth-token': 'test-token', 'x-los-operator-token': 'op-secret' },
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { ok: true });
  } finally {
    await app.close();
  }
});

test('operator gate rejects when no operatorToken is configured (operator access disabled)', async () => {
  // auth enabled but no operatorToken configured → isOperator is always false
  // → operator endpoints are locked down entirely.
  const app = await buildApp(buildConfig({ authEnabled: true }));
  try {
    const res = await app.inject({
      method: 'POST', url: '/op',
      headers: { 'x-los-auth-token': 'test-token', 'x-los-operator-token': 'anything' },
    });
    assert.equal(res.statusCode, 403);
  } finally {
    await app.close();
  }
});
