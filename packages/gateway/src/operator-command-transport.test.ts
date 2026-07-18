import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { MessageRouter, type HandlerDescriptor } from '@los/agent/message-router';
import { setConfig, type Config } from '@los/infra/config';
import { registerChatRoute } from './chat-route.js';
import { registerOpenAICompatibleRoute } from './openai-compat-route.js';
import { registerRequestContext } from './request-context.js';
import authMiddleware from './auth-middleware.js';

function config(): Config {
  return {
    databaseUrl: 'postgres://los:los@127.0.0.1:5432/los_test',
    server: { port: 8080, host: '127.0.0.1', corsOrigin: 'http://localhost:5173', localEndpoints: [] },
    auth: { enabled: true, token: 'access-token', operatorToken: 'operator-token' },
    integrations: { feedAnalysis: {
      resultReturningEnabled: true, maxInlineBytes: 1048576, maxItems: 500,
      materialHosts: [], materialFetchTimeoutMs: 10000, executionTimeoutMs: 120000, callbackPollMs: 5000, callbackProfiles: {},
    } },
    agent: {
      defaultProvider: 'deepseek', defaultModel: 'deepseek-v4-flash', maxLoops: 20,
      sandboxMode: 'workspace-write', identity: { name: 'default', inheritForChildren: false },
    },
    judge: {},
    review: { enabled: false, roles: {} },
    providers: {},
    memory: {
      ftsEnabled: true, maxObservations: 10000, persistChatDefault: true,
      selfReflectionEnabled: false,
      codeGraph: {
        enabled: false, shadowMode: false, injectArchitecture: false,
        cbmCommand: 'codebase-memory-mcp', cbmArgs: [], maxPromptTokens: 400,
      },
    },
    executor: {
      enabled: false, host: '127.0.0.1', port: 8090, nodeKind: 'executor',
      shutdownGraceMs: 120_000, connectModes: [], meshNodes: [],
    },
    profile: 'test',
    defaultProjectId: 'los',
    migrationsDir: 'packages/infra/migrations',
  };
}

test('chat and OpenAI command transports enforce anonymous/authenticated/operator states', async () => {
  const effectiveConfig = config();
  setConfig(effectiveConfig);
  const writes: string[] = [];
  const handler: HandlerDescriptor = {
    name: 'steering-write',
    priority: 1,
    match: intent => intent.type === 'steering',
    handle: async ctx => {
      writes.push(ctx.principal.subject);
      return { handled: true, text: 'executed', sessionId: 'session-abc12345' };
    },
  };
  const router = new MessageRouter({ handlers: [handler] });
  const app = Fastify({ logger: false });
  registerRequestContext(app, effectiveConfig);
  await authMiddleware(app, { config: effectiveConfig });
  registerChatRoute(app, effectiveConfig, process.cwd(), undefined, undefined, router);
  registerOpenAICompatibleRoute(app, effectiveConfig, process.cwd(), undefined, router);

  const states = [
    { name: 'anonymous', headers: {}, expected: 401 },
    { name: 'authenticated', headers: { 'x-los-auth-token': 'access-token' }, expected: 403 },
    {
      name: 'operator',
      headers: { 'x-los-operator-token': 'operator-token', 'x-user-id': 'forged-name' },
      expected: 200,
    },
  ] as const;

  try {
    for (const state of states) {
      const chat = await app.inject({
        method: 'POST', url: '/chat', headers: state.headers,
        payload: { prompt: '#approve session-abc12345' },
      });
      assert.equal(chat.statusCode, state.expected, `/chat ${state.name}`);
      if (state.expected === 401) assert.equal(chat.json().error, 'unauthorized');
      if (state.expected === 403) assert.equal(chat.json().error, 'operator_required');

      const compat = await app.inject({
        method: 'POST', url: '/v1/chat/completions', headers: state.headers,
        payload: { messages: [{ role: 'user', content: '#approve session-abc12345' }] },
      });
      assert.equal(compat.statusCode, state.expected, `OpenAI ${state.name}`);
      if (state.expected === 401) assert.equal(compat.json().error, 'unauthorized');
      if (state.expected === 403) assert.equal(compat.json().error.code, 'operator_required');
    }
    assert.deepEqual(writes, ['operator:shared-token', 'operator:shared-token']);
  } finally {
    await app.close();
  }
});
