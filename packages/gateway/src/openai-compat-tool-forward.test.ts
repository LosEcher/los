import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import Fastify from 'fastify';
import { setConfig, type Config } from '@los/infra/config';
import { registerOpenAICompatibleRoute } from './openai-compat-route.js';
import { registerRequestContext } from './request-context.js';
import {
  buildToolForwardBody,
  clientSuppliedTools,
  forwardClientToolCompletion,
  openAICompatChatUrl,
  resolveToolForwardTarget,
  safeUpstreamMessage,
} from './openai-compat-tool-forward.js';

const source = readFileSync(new URL('./openai-compat-tool-forward.ts', import.meta.url), 'utf8');

test('client tool forwarding does not log credentials', () => {
  assert.doesNotMatch(source, /console\.(?:log|info|debug|warn|error)/);
  assert.doesNotMatch(source, /JSON\.stringify\(.*apiKey/);
});

test('empty tools stay on the agent path', () => {
  assert.equal(clientSuppliedTools({}), null);
  assert.equal(clientSuppliedTools({ tools: [] }), null);
  assert.equal(clientSuppliedTools({ tools: ['nope'] }), null);
});

test('tool forward body keeps the caller tool_choice and tool messages', () => {
  const messages = [
    { role: 'user', content: '只打开文件面板，不要读取文件内容' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'ct_files', arguments: '{}' } }],
    },
    { role: 'tool', tool_call_id: 'call-1', content: '{"handoff":"frontend"}' },
  ];
  const body = buildToolForwardBody({
    model: 'deepseek-chat',
    messages,
    tools: [{ type: 'function', function: { name: 'ct_files' } }],
    toolChoice: 'required',
    stream: true,
    maxTokens: 256,
    temperature: 0.2,
  });
  assert.equal(body.model, 'deepseek-chat');
  assert.equal(body.tool_choice, 'required');
  assert.equal(body.stream, true);
  assert.deepEqual(body.messages, messages);
  assert.equal(body.max_tokens, 256);
});

test('provider target uses the configured model and /v1 join', () => {
  assert.equal(openAICompatChatUrl('https://api.deepseek.com'), 'https://api.deepseek.com/v1/chat/completions');
  assert.equal(openAICompatChatUrl('https://api.deepseek.com/v1/'), 'https://api.deepseek.com/v1/chat/completions');
  setConfig(configWithProvider());
  const target = resolveToolForwardTarget('deepseek');
  assert.equal(target.url, 'https://upstream.example/v1/chat/completions');
  assert.equal(target.model, 'deepseek-chat');
  assert.equal(target.apiKey, 'test-key');
});

test('upstream errors do not keep a bearer token', () => {
  assert.equal(
    safeUpstreamMessage('denied Bearer sk-secret-value'),
    'denied Bearer [redacted]',
  );
  assert.equal(
    safeUpstreamMessage(JSON.stringify({ error: { message: 'model rejected tools' } })),
    'model rejected tools',
  );
});

test('OpenAI-compat completions with tools skip runChat and return the provider tool call', async () => {
  setConfig(configWithProvider());
  const app = Fastify({ logger: false });
  registerRequestContext(app, configWithProvider());
  let ran = false;
  let forwarded: { url: string; body: Record<string, unknown>; authorization: string } | undefined;
  registerOpenAICompatibleRoute(app, configWithProvider(), '/workspace/los', undefined, undefined, {
    getDefaultProjectId: () => undefined,
    resolveConfiguredProjectOwner: () => {
      throw new Error('tool forwarding must not resolve a workspace');
    },
    runChat: async () => {
      ran = true;
      throw new Error('runChat must not see client tools');
    },
    forwardClientTools: async input => {
      await forwardClientToolCompletion({
        ...input,
        resolveTarget: () => ({
          url: 'https://upstream.example/v1/chat/completions',
          apiKey: 'test-key',
          model: 'deepseek-chat',
        }),
        fetchImpl: async (url, init) => {
          forwarded = {
            url: String(url),
            body: JSON.parse(String(init?.body)),
            authorization: String((init?.headers as Record<string, string>).Authorization),
          };
          return new Response(JSON.stringify({
            id: 'chatcmpl-test',
            choices: [{
              index: 0,
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [{
                  id: 'call-1',
                  type: 'function',
                  function: { name: 'ct_files', arguments: '{}' },
                }],
              },
              finish_reason: 'tool_calls',
            }],
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        },
      });
    },
  });

  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'deepseek',
        tool_choice: 'required',
        messages: [{ role: 'user', content: '只打开文件面板，不要读取文件内容' }],
        tools: [{ type: 'function', function: { name: 'ct_files', description: 'Open the Files panel' } }],
      },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(ran, false);
    assert.equal(forwarded?.url, 'https://upstream.example/v1/chat/completions');
    assert.equal(forwarded?.authorization, 'Bearer test-key');
    assert.equal(forwarded?.body.model, 'deepseek-chat');
    assert.equal(forwarded?.body.tool_choice, 'required');
    assert.equal((forwarded?.body.tools as unknown[]).length, 1);
    assert.equal(response.json().choices[0].finish_reason, 'tool_calls');
    assert.equal(response.json().choices[0].message.tool_calls[0].function.name, 'ct_files');
  } finally {
    await app.close();
  }
});

test('OpenAI-compat tool streams are passed through without rewriting deltas', async () => {
  setConfig(configWithProvider());
  const app = Fastify({ logger: false });
  registerRequestContext(app, configWithProvider());
  const sse = 'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"ct_files"}}]}}]}\n\n';
  registerOpenAICompatibleRoute(app, configWithProvider(), '/workspace/los', undefined, undefined, {
    getDefaultProjectId: () => undefined,
    resolveConfiguredProjectOwner: () => {
      throw new Error('tool forwarding must not resolve a workspace');
    },
    runChat: async () => {
      throw new Error('runChat must not see client tools');
    },
    forwardClientTools: async input => {
      await forwardClientToolCompletion({
        ...input,
        resolveTarget: () => ({
          url: 'https://upstream.example/v1/chat/completions',
          apiKey: 'test-key',
          model: 'deepseek-chat',
        }),
        fetchImpl: async () => new Response(sse, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }),
      });
    },
  });

  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'deepseek',
        stream: true,
        messages: [{ role: 'user', content: 'open files' }],
        tools: [{ type: 'function', function: { name: 'ct_files' } }],
      },
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.body, /ct_files/);
    assert.doesNotMatch(response.body, /role":"assistant"/);
  } finally {
    await app.close();
  }
});

function configWithProvider(): Config {
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
      sandboxNetwork: 'isolated',
      windowsSandboxBackend: 'acl',
      allowNativeShell: false,
      identity: { name: 'default', inheritForChildren: false },
      skills: { runtimeEnabled: true, autoInject: false, maxAutoSkills: 3, maxSkillTokens: 2500 },
      rules: { operatorInject: true, enforcementEnabled: true, maxPromptRules: 20 },
    },
    judge: {},
    review: { enabled: false, roles: {} },
    providers: {
      deepseek: {
        apiKey: 'test-key',
        baseUrl: 'https://upstream.example',
        model: 'deepseek-chat',
        enabled: true,
        weight: 100,
      },
    },
    providerFallbacks: {},
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
