import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import Fastify from 'fastify';
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
