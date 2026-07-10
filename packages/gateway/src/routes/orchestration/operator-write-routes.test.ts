import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { setConfig, type Config } from '@los/infra/config';
import authMiddleware from '../../auth-middleware.js';
import { registerRequestContext } from '../../request-context.js';
import { registerRunRoutes } from './run-routes.js';
import { registerRuntimeAdapterRoutes } from './runtime-adapter-routes.js';

function config(): Config {
  return {
    databaseUrl: 'postgres://los:los@127.0.0.1:5432/los',
    server: { port: 8080, host: '127.0.0.1', corsOrigin: 'http://localhost:5173', localEndpoints: [] },
    auth: { enabled: true, token: 'access-token', operatorToken: 'operator-token' },
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
    executor: { enabled: false, host: '127.0.0.1', port: 8090, nodeKind: 'executor', connectModes: [], meshNodes: [] },
    profile: 'test',
    defaultProjectId: 'los',
    migrationsDir: 'packages/infra/migrations',
  };
}

test('ordinary access token cannot invoke operator write routes', async () => {
  const effectiveConfig = config();
  setConfig(effectiveConfig);
  const app = Fastify({ logger: false });
  registerRequestContext(app, effectiveConfig);
  await authMiddleware(app, { config: effectiveConfig });
  registerRunRoutes(app);
  registerRuntimeAdapterRoutes(app);

  try {
    const requests = [
      { url: '/runs/run-test/recover', payload: {} },
      { url: '/runs/run-test/answer', payload: {} },
      { url: '/runs/run-test/verify', payload: {} },
      { url: '/runs/run-test/approve', payload: {} },
      { url: '/runs/run-test/revise-plan', payload: {} },
      { url: '/runtimes/codex/run', payload: { prompt: 'test' } },
      { url: '/runtimes/bridge/start', payload: {} },
    ];
    for (const request of requests) {
      const response = await app.inject({
        method: 'POST',
        url: request.url,
        headers: { 'x-los-auth-token': 'access-token' },
        payload: request.payload,
      });
      assert.equal(response.statusCode, 403, request.url);
      assert.deepEqual(response.json(), { error: 'operator token required' }, request.url);
    }
  } finally {
    await app.close();
  }
});
