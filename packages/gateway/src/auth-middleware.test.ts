import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import type { Config } from '@los/infra/config';

import authMiddleware, { _tokenAccepted } from './auth-middleware.js';
import { registerSecurityHeaders } from './security-headers.js';

test('auth middleware allows requests when auth is disabled', async () => {
  const app = Fastify({ logger: false });
  await authMiddleware(app, { config: configForAuth(false) });
  app.get('/settings', async () => ({ ok: true }));

  try {
    const response = await app.inject({ method: 'GET', url: '/settings' });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { ok: true });
  } finally {
    await app.close();
  }
});

test('executor heartbeat requires the shared agent key when configured', async () => {
  const app = Fastify({ logger: false });
  const cfg = configForAuth(false);
  cfg.executor.agentKey = 'executor-heartbeat-key';
  await authMiddleware(app, { config: cfg });
  app.post('/nodes/heartbeat', async () => ({ ok: true }));

  try {
    const missing = await app.inject({ method: 'POST', url: '/nodes/heartbeat', payload: {} });
    assert.equal(missing.statusCode, 401);

    const invalid = await app.inject({
      method: 'POST',
      url: '/nodes/heartbeat',
      headers: { authorization: 'Bearer wrong-key' },
      payload: {},
    });
    assert.equal(invalid.statusCode, 401);

    const valid = await app.inject({
      method: 'POST',
      url: '/nodes/heartbeat',
      headers: { authorization: 'Bearer executor-heartbeat-key' },
      payload: {},
    });
    assert.equal(valid.statusCode, 200);
  } finally {
    await app.close();
  }
});

test('auth middleware accepts access_token query for browser WebSocket/EventSource', async () => {
  const app = Fastify({ logger: false });
  await authMiddleware(app, { config: configForAuth(true) });
  app.get('/sessions/:id/stream/ws', async () => ({ ok: true }));
  app.get('/sessions/:id/events/live', async () => ({ ok: true }));

  try {
    const missing = await app.inject({ method: 'GET', url: '/sessions/s1/stream/ws' });
    assert.equal(missing.statusCode, 401);

    const viaQuery = await app.inject({
      method: 'GET',
      url: '/sessions/s1/stream/ws?access_token=test-token',
    });
    assert.equal(viaQuery.statusCode, 200);

    const live = await app.inject({
      method: 'GET',
      url: '/sessions/s1/events/live?access_token=test-token',
    });
    assert.equal(live.statusCode, 200);

    const wrong = await app.inject({
      method: 'GET',
      url: '/sessions/s1/stream/ws?access_token=wrong',
    });
    assert.equal(wrong.statusCode, 401);
  } finally {
    await app.close();
  }
});

test('auth middleware keeps PWA shell assets public without credentials', async () => {
  const app = Fastify({ logger: false });
  await authMiddleware(app, { config: configForAuth(true) });
  for (const path of ['/', '/favicon.ico', '/manifest.webmanifest', '/icon.svg', '/sw.js', '/assets/app.js']) {
    app.get(path, async () => ({ path }));
  }
  app.get('/chat', async () => ({ ok: true }));

  try {
    for (const path of ['/', '/favicon.ico', '/manifest.webmanifest', '/icon.svg', '/sw.js', '/assets/app.js']) {
      const response = await app.inject({ method: 'GET', url: path });
      assert.equal(response.statusCode, 200, `${path} should be public`);
    }
    // Query string must not break exact public matches.
    const manifestWithQuery = await app.inject({ method: 'GET', url: '/manifest.webmanifest?v=1' });
    assert.equal(manifestWithQuery.statusCode, 200);

    // API surfaces stay protected.
    const chat = await app.inject({ method: 'GET', url: '/chat' });
    assert.equal(chat.statusCode, 401);
  } finally {
    await app.close();
  }
});

test('auth middleware requires the configured token outside public paths', async () => {
  const app = Fastify({ logger: false });
  await authMiddleware(app, { config: configForAuth(true) });
  app.get('/protected', async () => ({ ok: true }));
  app.get('/health', async () => ({ status: 'ok' }));

  try {
    const missing = await app.inject({ method: 'GET', url: '/protected' });
    assert.equal(missing.statusCode, 401);

    const invalid = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { 'x-los-auth-token': 'wrong-token' },
    });
    assert.equal(invalid.statusCode, 401);

    const valid = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { 'x-los-auth-token': 'test-token' },
    });
    assert.equal(valid.statusCode, 200);

    // WeClaw / OpenAI-compatible clients send Authorization: Bearer
    const bearer = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: 'Bearer test-token' },
    });
    assert.equal(bearer.statusCode, 200);

    const badBearer = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: 'Bearer wrong-token' },
    });
    assert.equal(badBearer.statusCode, 401);

    const health = await app.inject({ method: 'GET', url: '/health' });
    assert.equal(health.statusCode, 200);
  } finally {
    await app.close();
  }
});

test('auth middleware protects settings mutation and operator runtime control paths', async () => {
  const app = Fastify({ logger: false });
  await authMiddleware(app, { config: configForAuth(true) });
  app.get('/settings', async () => ({ ok: true }));
  app.patch('/settings', async () => ({ ok: true }));
  app.post('/operator/tool-gate', async () => ({ ok: true }));
  app.get('/operator/events/live', async () => ({ ok: true }));
  app.post('/runtimes/codex/run', async () => ({ ok: true }));
  app.post('/v1/chat/completions', async () => ({ ok: true }));
  app.post('/chat', async () => ({ ok: true }));
  app.post('/sessions/session-a/operator-events', async () => ({ ok: true }));
  app.get('/sessions/session-a/events/live', async () => ({ ok: true }));

  try {
    const publicSettings = await app.inject({ method: 'GET', url: '/settings?tab=auth' });
    assert.equal(publicSettings.statusCode, 200);

    for (const request of [
      { method: 'PATCH', url: '/settings' },
      { method: 'POST', url: '/operator/tool-gate' },
      { method: 'GET', url: '/operator/events/live' },
      { method: 'POST', url: '/runtimes/codex/run' },
      { method: 'POST', url: '/v1/chat/completions' },
      { method: 'POST', url: '/chat' },
      { method: 'POST', url: '/sessions/session-a/operator-events' },
      { method: 'GET', url: '/sessions/session-a/events/live' },
    ] as const) {
      const missing = await app.inject(request);
      assert.equal(missing.statusCode, 401, `${request.method} ${request.url} should require auth`);

      const valid = await app.inject({
        ...request,
        headers: { 'x-los-auth-token': 'test-token' },
      });
      assert.equal(valid.statusCode, 200, `${request.method} ${request.url} should accept auth`);
    }
  } finally {
    await app.close();
  }
});

test('auth middleware accepts operator token without auth token when operatorToken is set', async () => {
  const app = Fastify({ logger: false });
  const cfg = configForAuth(true);
  cfg.auth.operatorToken = 'operator-secret';
  await authMiddleware(app, { config: cfg });
  app.post('/sessions/session-a/operator-events', async () => ({ ok: true }));
  app.get('/protected', async () => ({ ok: true }));

  try {
    // operator token should pass through
    const opOk = await app.inject({
      method: 'POST',
      url: '/sessions/session-a/operator-events',
      headers: { 'x-los-operator-token': 'operator-secret' },
    });
    assert.equal(opOk.statusCode, 200);

    // wrong operator token should still 401
    const opBad = await app.inject({
      method: 'POST',
      url: '/sessions/session-a/operator-events',
      headers: { 'x-los-operator-token': 'wrong-operator' },
    });
    assert.equal(opBad.statusCode, 401);

    // operator token also works for general protected paths
    const genOk = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { 'x-los-operator-token': 'operator-secret' },
    });
    assert.equal(genOk.statusCode, 200);
  } finally {
    await app.close();
  }
});

/**
 * 执行器的模型路由（2026-10-11）：节点用**它已经有的**那把密钥（派发通道同一把）
 * 调 OpenAI 兼容面，这样远端节点不再需要自己的 provider 凭据。
 *
 * 两条判据合起来才成立：① 该允许的允许；② **该不许的不许**——否则这就不是"收窄的
 * 一条通路"，而是"把这把共享密钥升级成网关万能钥匙"。
 */
test('executor key opens the OpenAI-compatible surface and nothing else', async () => {
  const app = Fastify({ logger: false });
  const cfg = configForAuth(true);
  cfg.executor.agentKey = 'executor-shared-key';
  await authMiddleware(app, { config: cfg });
  app.get('/v1/models', async () => ({ object: 'list', data: [] }));
  app.post('/v1/chat/completions', async () => ({ ok: true }));
  app.get('/runs', async () => ({ runs: [] }));
  app.get('/sessions/:id', async () => ({ ok: true }));
  app.post('/chat', async () => ({ ok: true }));

  const asExecutor = { authorization: 'Bearer executor-shared-key' };
  try {
    // ① 允许：只有这两条
    assert.equal((await app.inject({ method: 'GET', url: '/v1/models', headers: asExecutor })).statusCode, 200);
    assert.equal((await app.inject({ method: 'POST', url: '/v1/chat/completions', headers: asExecutor, payload: {} })).statusCode, 200);

    // ② 负向控制：同一把密钥打不开别的任何路径
    for (const [method, url] of [
      ['GET', '/runs'],
      ['GET', '/sessions/abc'],
      ['POST', '/chat'],
    ] as const) {
      const response = await app.inject({ method, url, headers: asExecutor, payload: method === 'POST' ? {} : undefined });
      assert.equal(response.statusCode, 401, `${method} ${url} must stay closed to the executor key`);
    }

    // ③ 别的凭据打同一路径仍然可用（本改动不得把浏览器/DSH 挤掉）
    const withAuthToken = await app.inject({
      method: 'POST', url: '/v1/chat/completions',
      headers: { 'x-los-auth-token': 'test-token' }, payload: {},
    });
    assert.equal(withAuthToken.statusCode, 200);

    // ④ 错密钥不得被当成"没匹配"而静默放行
    const wrong = await app.inject({
      method: 'POST', url: '/v1/chat/completions',
      headers: { authorization: 'Bearer not-the-executor-key' }, payload: {},
    });
    assert.equal(wrong.statusCode, 401);
  } finally {
    await app.close();
  }
});

test('security headers do not emit CSP unless explicitly configured', async () => {
  const app = Fastify({ logger: false });
  registerSecurityHeaders(app);
  app.get('/', async () => '<html><script>window.ok=true</script></html>');

  try {
    const response = await app.inject({ method: 'GET', url: '/' });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.equal(response.headers['content-security-policy'], undefined);
  } finally {
    await app.close();
  }
});

test('security headers emit CSP when explicitly configured', async () => {
  const app = Fastify({ logger: false });
  registerSecurityHeaders(app, { contentSecurityPolicy: "default-src 'self'" });
  app.get('/', async () => ({ ok: true }));

  try {
    const response = await app.inject({ method: 'GET', url: '/' });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['content-security-policy'], "default-src 'self'");
  } finally {
    await app.close();
  }
});

function configForAuth(enabled: boolean): Config {
  return {
    databaseUrl: 'postgres://los:los@127.0.0.1:5432/los',
    server: {
      port: 8080,
      host: '127.0.0.1',
      corsOrigin: 'http://localhost:5173',
      localEndpoints: [],
    },
    auth: {
      enabled,
      token: 'test-token',
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
      sandboxNetwork: 'isolated',
      windowsSandboxBackend: 'acl',
      allowNativeShell: false,
      identity: { name: 'default', inheritForChildren: false },
      skills: { runtimeEnabled: true, autoInject: false, maxAutoSkills: 3, maxSkillTokens: 2500 },
      rules: { operatorInject: true, enforcementEnabled: true, maxPromptRules: 20 },
    },
    judge: {},
    review: { enabled: false, roles: {} },
    providers: {},
    providerFallbacks: {},
    providerRouteConflicts: [],
    isolation: { backend: 'auto' },
    memory: {
      ftsEnabled: true,
      maxObservations: 10000,
      persistChatDefault: true,
      selfReflectionEnabled: false,
      codeGraph: {
        enabled: false,
        shadowMode: false,
        injectArchitecture: false,
        cbmCommand: 'codebase-memory-mcp',
        cbmArgs: [],
        maxPromptTokens: 400,
      },
    },
    executor: {
      enabled: false,
      host: '127.0.0.1',
      port: 8090,
      shutdownGraceMs: 120_000,
      nodeKind: 'executor',
      connectModes: [],
      meshNodes: [],
      placementPolicy: 'verified-rotate', workspacePolicy: 'verify', nodeCredentialTtlDays: 30 },
    profile: 'test',
    defaultProjectId: 'los',
    migrationsDir: 'packages/infra/migrations',
  };
}


// ── 凭据轮换窗口（2026-10-15 新增）───────────────────────────────────────────
// 契约：runbooks/credential-rotation-3-secrets-2026-10-15.md §2。
// 三条负向控制必须成立：① 窗口开时新旧都通、其它一律 401；
// ② 关窗（不设 *_PREVIOUS）后旧值必须 401；③ **PREVIOUS 不能单独授权**。

test('rotation window: static auth token accepts the previous value only while open', async () => {
  const NEW = 'new-static-token';
  const OLD = 'old-static-token';
  const build = async () => {
    const app = Fastify({ logger: false });
    const cfg = configForAuth(true);
    cfg.auth.token = NEW;
    await authMiddleware(app, { config: cfg });
    app.get('/protected', async () => ({ ok: true }));
    return app;
  };

  process.env.LOS_AUTH_TOKEN_PREVIOUS = OLD;
  const open = await build();
  try {
    for (const [label, token] of [['new', NEW], ['old', OLD]] as const) {
      const res = await open.inject({ method: 'GET', url: '/protected', headers: { 'x-los-auth-token': token } });
      assert.equal(res.statusCode, 200, label + ' token should be accepted while the window is open');
    }
    const other = await open.inject({ method: 'GET', url: '/protected', headers: { 'x-los-auth-token': 'neither' } });
    assert.equal(other.statusCode, 401, 'a value that is neither current nor previous must be rejected');
  } finally {
    await open.close();
    delete process.env.LOS_AUTH_TOKEN_PREVIOUS;
  }

  const closed = await build();
  try {
    const res = await closed.inject({ method: 'GET', url: '/protected', headers: { 'x-los-auth-token': OLD } });
    assert.equal(res.statusCode, 401, 'previous token must be rejected once the window is closed');
  } finally {
    await closed.close();
  }
});

test('rotation window: operator and executor tokens behave the same way', async () => {
  const app = Fastify({ logger: false });
  const cfg = configForAuth(true);
  cfg.auth.operatorToken = 'new-operator-token';
  cfg.executor.agentKey = 'new-executor-key';
  process.env.LOS_OPERATOR_TOKEN_PREVIOUS = 'old-operator-token';
  process.env.EXECUTOR_AGENT_KEY_PREVIOUS = 'old-executor-key';
  await authMiddleware(app, { config: cfg });
  app.get('/sessions/session-a/operator-events', async () => ({ ok: true }));
  app.get('/v1/models', async () => ({ ok: true }));

  try {
    for (const [label, token] of [['new', 'new-operator-token'], ['old', 'old-operator-token']] as const) {
      const res = await app.inject({ method: 'GET', url: '/sessions/session-a/operator-events', headers: { 'x-los-operator-token': token } });
      assert.equal(res.statusCode, 200, label + ' operator token should be accepted while the window is open');
    }
    for (const [label, key] of [['new', 'new-executor-key'], ['old', 'old-executor-key']] as const) {
      const res = await app.inject({ method: 'GET', url: '/v1/models', headers: { authorization: 'Bearer ' + key } });
      assert.equal(res.statusCode, 200, label + ' executor key should be accepted while the window is open');
    }
    const staleOperator = await app.inject({ method: 'GET', url: '/sessions/session-a/operator-events', headers: { 'x-los-operator-token': 'stale' } });
    assert.equal(staleOperator.statusCode, 401);
    const staleExecutor = await app.inject({ method: 'GET', url: '/v1/models', headers: { authorization: 'Bearer stale' } });
    assert.equal(staleExecutor.statusCode, 401);
  } finally {
    await app.close();
    delete process.env.LOS_OPERATOR_TOKEN_PREVIOUS;
    delete process.env.EXECUTOR_AGENT_KEY_PREVIOUS;
  }

  // 关窗后：旧值与"凭空一把"都必须 401
  const closed = Fastify({ logger: false });
  await authMiddleware(closed, { config: cfg });
  closed.get('/v1/models', async () => ({ ok: true }));
  closed.get('/sessions/session-a/operator-events', async () => ({ ok: true }));
  try {
    const staleKey = await closed.inject({ method: 'GET', url: '/v1/models', headers: { authorization: 'Bearer old-executor-key' } });
    assert.equal(staleKey.statusCode, 401, 'previous executor key must be rejected once the window is closed');
    const staleOp = await closed.inject({ method: 'GET', url: '/sessions/session-a/operator-events', headers: { 'x-los-operator-token': 'old-operator-token' } });
    assert.equal(staleOp.statusCode, 401, 'previous operator token must be rejected once the window is closed');
  } finally {
    await closed.close();
  }
});

test('rotation window: PREVIOUS alone must never authorize (main token missing)', async () => {
  process.env.LOS_AUTH_TOKEN_PREVIOUS = 'old-only';
  process.env.EXECUTOR_AGENT_KEY_PREVIOUS = 'old-executor-only';
  const app = Fastify({ logger: false });
  const cfg = configForAuth(true);
  cfg.auth.token = '';
  cfg.executor.agentKey = '';
  await authMiddleware(app, { config: cfg });
  app.get('/protected', async () => ({ ok: true }));
  app.get('/v1/models', async () => ({ ok: true }));
  try {
    const viaAuth = await app.inject({ method: 'GET', url: '/protected', headers: { 'x-los-auth-token': 'old-only' } });
    assert.equal(viaAuth.statusCode, 401, 'PREVIOUS must not authorize on its own');
    const viaExecutor = await app.inject({ method: 'GET', url: '/v1/models', headers: { authorization: 'Bearer old-executor-only' } });
    assert.equal(viaExecutor.statusCode, 401, 'PREVIOUS executor key must not authorize on its own');
  } finally {
    await app.close();
    delete process.env.LOS_AUTH_TOKEN_PREVIOUS;
    delete process.env.EXECUTOR_AGENT_KEY_PREVIOUS;
  }
});

test('_tokenAccepted: table', () => {
  assert.equal(_tokenAccepted('a', 'a', 'b'), true, 'current matches');
  assert.equal(_tokenAccepted('b', 'a', 'b'), true, 'previous matches inside the window');
  assert.equal(_tokenAccepted('b', 'a', undefined), false, 'previous is ignored without a window');
  assert.equal(_tokenAccepted('a', undefined, 'a'), false, 'PREVIOUS cannot stand alone');
  assert.equal(_tokenAccepted('a', '', 'a'), false, 'empty current cannot stand alone');
  assert.equal(_tokenAccepted(undefined, 'a', 'b'), false, 'missing candidate');
});
