import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import Fastify from 'fastify';
import { MessageRouter } from '@los/agent/message-router';
import { setConfig, type Config } from '@los/infra/config';
import { registerOpenAICompatibleRoute } from './openai-compat-route.js';
import { registerRequestContext } from './request-context.js';

const source = readFileSync(new URL('./openai-compat-route.ts', import.meta.url), 'utf8');

test('OpenAI-compatible route never logs raw request headers', () => {
  assert.doesNotMatch(source, /JSON\.stringify\(req\.headers\)/);
  assert.doesNotMatch(source, /console\.(?:log|info|debug|warn|error)/);
});

test('OpenAI-compatible chat resolves intake ownership before runChat', async () => {
  const effectiveConfig = config();
  setConfig(effectiveConfig);
  const app = Fastify({ logger: false });
  registerRequestContext(app, effectiveConfig);

  let captured: Record<string, unknown> | undefined;
  registerOpenAICompatibleRoute(app, effectiveConfig, '/workspace/los', undefined, undefined, {
    getDefaultProjectId: () => undefined,
    resolveConfiguredProjectOwner: input => {
      assert.equal(input.defaultProjectId, 'los');
      assert.equal(input.defaultWorkspaceRoot, '/workspace/los');
      return {
        status: 'resolved',
        ownerRepo: 'los',
        workspaceRoot: '/workspace/los',
        reason: 'configured_default',
      };
    },
    runChat: async params => {
      captured = params as unknown as Record<string, unknown>;
      params.send('done', { text: 'OK' });
      return {
        status: 'completed',
        sessionId: params.sid,
        taskRunId: 'task-openai-compat',
        traceId: params.traceId,
        result: {
          text: 'OK',
          loopCount: 1,
          totalTokens: 2,
          runCompletionStatus: null,
          blockedVerificationRecordIds: [],
        },
      };
    },
  });

  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'deepseek',
        messages: [{ role: 'user', content: 'reply only OK' }],
      },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().choices[0].message.content, 'OK');
    assert.equal(captured?.projectId, 'los');
    assert.equal(captured?.workspaceRoot, '/workspace/los');
    assert.deepEqual(captured?.intakeResolution, {
      status: 'resolved',
      ownerRepo: 'los',
      workspaceRoot: '/workspace/los',
      reason: 'configured_default',
    });
  } finally {
    await app.close();
  }
});

test('OpenAI-compatible chat streams real SSE chunks when stream=true', async () => {
  const effectiveConfig = config();
  setConfig(effectiveConfig);
  const app = Fastify({ logger: false });
  registerRequestContext(app, effectiveConfig);

  let capturedSignal: AbortSignal | undefined;
  registerOpenAICompatibleRoute(app, effectiveConfig, '/workspace/los', undefined, undefined, {
    getDefaultProjectId: () => undefined,
    resolveConfiguredProjectOwner: () => ({
      status: 'resolved', ownerRepo: 'los', workspaceRoot: '/workspace/los', reason: 'configured_default',
    }),
    runChat: async params => {
      capturedSignal = params.signal;
      params.send('model.delta', { turn: 1, provider: 'deepseek', model: null, textDelta: 'Hello', reasoningDelta: '' });
      params.send('model.delta', { turn: 1, provider: 'deepseek', model: null, textDelta: ' world', reasoningDelta: '' });
      params.send('done', { text: 'Hello world', turns: 1, tokens: { prompt: 10, completion: 11 } });
      return {
        status: 'completed', sessionId: params.sid, taskRunId: 'task-openai-compat',
        traceId: params.traceId,
        result: { text: 'Hello world', loopCount: 1, totalTokens: 21, runCompletionStatus: null, blockedVerificationRecordIds: [] },
      };
    },
  });

  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'deepseek', messages: [{ role: 'user', content: 'hi' }], stream: true },
    });

    assert.equal(response.statusCode, 200);
    assert.match(response.headers['content-type'] ?? '', /text\/event-stream/);
    const events = parseSSEEvents(response.body);
    // [role] → [Hello] → [ world] → [finish] → [usage] → [DONE]
    assert.deepEqual(events[0].choices[0].delta, { role: 'assistant' });
    assert.equal(events[0].choices[0].finish_reason, null);
    assert.equal(events[1].choices[0].delta.content, 'Hello');
    assert.equal(events[2].choices[0].delta.content, ' world');
    assert.deepEqual(events[3].choices[0].delta, {});
    assert.equal(events[3].choices[0].finish_reason, 'stop');
    assert.deepEqual(events[3].choices, [{ index: 0, delta: {}, finish_reason: 'stop' }]);
    assert.deepEqual(events[4].choices, []);
    assert.deepEqual(events[4].usage, { prompt_tokens: 10, completion_tokens: 11, total_tokens: 21 });
    assert.equal(events[5], '[DONE]');
    assert.equal(events.length, 6);
    assert.ok(capturedSignal, 'streaming path should pass an abort signal to runChat');
  } finally {
    await app.close();
  }
});

test('OpenAI-compatible SSE reconciles missing tail from done text', async () => {
  const effectiveConfig = config();
  setConfig(effectiveConfig);
  const app = Fastify({ logger: false });
  registerRequestContext(app, effectiveConfig);

  registerOpenAICompatibleRoute(app, effectiveConfig, '/workspace/los', undefined, undefined, {
    getDefaultProjectId: () => undefined,
    resolveConfiguredProjectOwner: () => ({
      status: 'resolved', ownerRepo: 'los', workspaceRoot: '/workspace/los', reason: 'configured_default',
    }),
    runChat: async params => {
      // Provider only emitted a partial delta; done.text is authoritative.
      params.send('model.delta', { turn: 1, provider: 'deepseek', model: null, textDelta: 'Hello', reasoningDelta: '' });
      params.send('done', { text: 'Hello world!', turns: 1 });
      return {
        status: 'completed', sessionId: params.sid, taskRunId: 'task-openai-compat',
        traceId: params.traceId,
        result: { text: 'Hello world!', loopCount: 1, totalTokens: 12, runCompletionStatus: null, blockedVerificationRecordIds: [] },
      };
    },
  });

  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'deepseek', messages: [{ role: 'user', content: 'hi' }], stream: true },
    });

    const events = parseSSEEvents(response.body);
    assert.equal(events[1].choices[0].delta.content, 'Hello');
    assert.equal(events[2].choices[0].delta.content, ' world!');
    assert.equal(events[3].choices[0].finish_reason, 'stop');
    assert.equal(events[4], '[DONE]');
  } finally {
    await app.close();
  }
});

test('OpenAI-compatible SSE streams an error chunk on runChat failure', async () => {
  const effectiveConfig = config();
  setConfig(effectiveConfig);
  const app = Fastify({ logger: false });
  registerRequestContext(app, effectiveConfig);

  registerOpenAICompatibleRoute(app, effectiveConfig, '/workspace/los', undefined, undefined, {
    getDefaultProjectId: () => undefined,
    resolveConfiguredProjectOwner: () => ({
      status: 'resolved', ownerRepo: 'los', workspaceRoot: '/workspace/los', reason: 'configured_default',
    }),
    runChat: async params => {
      params.send('error', { message: 'boom' });
      return {
        status: 'cancelled', sessionId: params.sid, taskRunId: 'task-openai-compat',
        traceId: params.traceId, cancelReason: 'boom',
      };
    },
  });

  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'deepseek', messages: [{ role: 'user', content: 'hi' }], stream: true },
    });

    const events = parseSSEEvents(response.body);
    assert.equal(events[1].choices[0].finish_reason, 'error');
    assert.deepEqual(events[1].error, { message: 'boom' });
    assert.equal(events[2], '[DONE]');
  } finally {
    await app.close();
  }
});

test('OpenAI-compatible short-path command streams as SSE when stream=true', async () => {
  const effectiveConfig = config();
  setConfig(effectiveConfig);
  const app = Fastify({ logger: false });
  registerRequestContext(app, effectiveConfig);

  const messageRouter = new MessageRouter({ handlers: [{
    name: 'status',
    priority: 1,
    match: intent => intent.type === 'status',
    handle: async () => ({ handled: true, text: 'all good' }),
  }] });

  registerOpenAICompatibleRoute(app, effectiveConfig, '/workspace/los', undefined, messageRouter, {
    getDefaultProjectId: () => undefined,
    resolveConfiguredProjectOwner: () => ({
      status: 'resolved', ownerRepo: 'los', workspaceRoot: '/workspace/los', reason: 'configured_default',
    }),
  });

  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'deepseek', messages: [{ role: 'user', content: '#status abc12345' }], stream: true },
    });

    const events = parseSSEEvents(response.body);
    assert.equal(events[0].choices[0].delta.role, 'assistant');
    assert.equal(events[1].choices[0].delta.content, 'all good');
    assert.equal(events[2].choices[0].finish_reason, 'stop');
    assert.equal(events[3], '[DONE]');
  } finally {
    await app.close();
  }
});

test('OpenAI-compatible SSE error chunk keeps the structured failure classification', async () => {
  const effectiveConfig = config();
  setConfig(effectiveConfig);
  const app = Fastify({ logger: false });
  registerRequestContext(app, effectiveConfig);

  registerOpenAICompatibleRoute(app, effectiveConfig, '/workspace/los', undefined, undefined, {
    getDefaultProjectId: () => undefined,
    resolveConfiguredProjectOwner: () => ({
      status: 'resolved', ownerRepo: 'los', workspaceRoot: '/workspace/los', reason: 'configured_default',
    }),
    runChat: async params => {
      // AgentError-shaped failure thrown by the agent loop (upstream 503).
      const err: any = new Error('packycode API error 503: QPS/TPM 高峰');
      err.toJSON = () => ({
        code: 'PROVIDER_HTTP_ERROR', message: 'packycode API error 503: QPS/TPM 高峰',
        httpStatus: 503, retryable: true, provider: 'packycode', model: 'gpt-5.5',
      });
      throw err;
    },
  });

  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'packycode', messages: [{ role: 'user', content: 'hi' }], stream: true },
    });

    const events = parseSSEEvents(response.body);
    assert.equal(events[1].choices[0].finish_reason, 'error');
    assert.deepEqual(events[1].error, {
      message: 'packycode API error 503: QPS/TPM 高峰',
      code: 'PROVIDER_HTTP_ERROR',
      httpStatus: 503,
      retryable: true,
      provider: 'packycode',
      model: 'gpt-5.5',
    });
    assert.equal(events[2], '[DONE]');
  } finally {
    await app.close();
  }
});

test('OpenAI-compatible SSE blocked tail carries the block reason', async () => {
  const effectiveConfig = config();
  setConfig(effectiveConfig);
  const app = Fastify({ logger: false });
  registerRequestContext(app, effectiveConfig);

  registerOpenAICompatibleRoute(app, effectiveConfig, '/workspace/los', undefined, undefined, {
    getDefaultProjectId: () => undefined,
    resolveConfiguredProjectOwner: () => ({
      status: 'resolved', ownerRepo: 'los', workspaceRoot: '/workspace/los', reason: 'configured_default',
    }),
    runChat: async params => {
      params.send('blocked', { reason: 'provider unavailable' });
      return {
        status: 'blocked', sessionId: params.sid, taskRunId: 'task-openai-compat',
        traceId: params.traceId, cancelReason: 'provider unavailable',
      };
    },
  });

  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'deepseek', messages: [{ role: 'user', content: 'hi' }], stream: true },
    });

    const events = parseSSEEvents(response.body);
    assert.equal(events[1].choices[0].finish_reason, 'blocked');
    assert.deepEqual(events[1].error, { message: 'provider unavailable' });
    assert.equal(events[2], '[DONE]');
  } finally {
    await app.close();
  }
});

test('OpenAI-compatible non-streaming failure carries the structured failure classification', async () => {
  const effectiveConfig = config();
  setConfig(effectiveConfig);
  const app = Fastify({ logger: false });
  registerRequestContext(app, effectiveConfig);

  registerOpenAICompatibleRoute(app, effectiveConfig, '/workspace/los', undefined, undefined, {
    getDefaultProjectId: () => undefined,
    resolveConfiguredProjectOwner: () => ({
      status: 'resolved', ownerRepo: 'los', workspaceRoot: '/workspace/los', reason: 'configured_default',
    }),
    runChat: async () => {
      const err: any = new Error('packycode API error 503: QPS/TPM 高峰');
      err.toJSON = () => ({
        code: 'PROVIDER_HTTP_ERROR', message: 'packycode API error 503: QPS/TPM 高峰',
        httpStatus: 503, retryable: true, provider: 'packycode', model: 'gpt-5.5',
      });
      throw err;
    },
  });

  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'packycode', messages: [{ role: 'user', content: 'hi' }], stream: false },
    });

    assert.equal(response.statusCode, 500);
    assert.deepEqual(response.json().error, {
      message: 'packycode API error 503: QPS/TPM 高峰',
      type: 'internal_error',
      code: 'PROVIDER_HTTP_ERROR',
      httpStatus: 503,
      retryable: true,
      provider: 'packycode',
      model: 'gpt-5.5',
    });
  } finally {
    await app.close();
  }
});

test('OpenAI-compatible /v1/models lists providers as OpenAI model objects', async () => {
  const effectiveConfig = config();
  effectiveConfig.providers = {
    packycode: { baseUrl: 'https://www.packyapi.com/v1', model: 'gpt-5.5', enabled: true, weight: 1 },
    deepseek: { baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', enabled: true, weight: 1 },
  };
  setConfig(effectiveConfig);
  const app = Fastify({ logger: false });
  registerRequestContext(app, effectiveConfig);
  registerOpenAICompatibleRoute(app, effectiveConfig, '/workspace/los');

  try {
    const response = await app.inject({ method: 'GET', url: '/v1/models' });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.object, 'list');
    // Ambient discovery may add providers; config-declared ones must be present.
    const ids = body.data.map((m: { id: string }) => m.id);
    assert.ok(ids.includes('deepseek'));
    assert.ok(ids.includes('packycode'));
    assert.deepEqual(ids, [...ids].sort());
    for (const model of body.data) {
      assert.equal(model.object, 'model');
      assert.equal(model.owned_by, 'los');
      assert.equal(typeof model.created, 'number');
    }
  } finally {
    await app.close();
  }
});

function parseSSEEvents(body: string): any[] {
  return body.split('\n')
    .filter(line => line.startsWith('data: '))
    .map(line => {
      const payload = line.slice('data: '.length);
      return payload === '[DONE]' ? payload : JSON.parse(payload);
    });
}

function config(): Config {
  return {
    databaseUrl: 'postgres://los:los@127.0.0.1:5432/los_test',
    server: { port: 8080, host: '127.0.0.1', corsOrigin: 'http://localhost:5173', localEndpoints: [] },
    auth: { enabled: false },
    integrations: { feedAnalysis: {
      resultReturningEnabled: true,
      maxInlineBytes: 1048576,
      maxItems: 500,
      materialHosts: [],
      materialFetchTimeoutMs: 10000,
      executionTimeoutMs: 120000,
      callbackPollMs: 5000,
      callbackProfiles: {},
    } },
    agent: {
      defaultProvider: 'deepseek',
      defaultModel: 'deepseek-v4-flash',
      maxLoops: 20,
      sandboxMode: 'workspace-write',
      allowNativeShell: false,
      identity: { name: 'default', inheritForChildren: false },
      skills: { runtimeEnabled: true, autoInject: false, maxAutoSkills: 3, maxSkillTokens: 2500 },
      rules: { operatorInject: true, enforcementEnabled: true, maxPromptRules: 20 },
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
    executor: {
      enabled: false,
      host: '127.0.0.1',
      port: 8090,
      nodeKind: 'executor',
      shutdownGraceMs: 120_000,
      connectModes: [],
      meshNodes: [],
    },
    profile: 'test',
    defaultProjectId: 'los',
    migrationsDir: 'packages/infra/migrations',
  };
}
