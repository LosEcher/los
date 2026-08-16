import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { setConfig, type Config } from '@los/infra/config';
import { registerRequestContext } from '../../request-context.js';
import {
  registerProviderCompatExecuteRoutes,
  type CompatExecuteDependencies,
} from './provider-compat-execute.js';

function buildConfig(opts: { authEnabled: boolean; operatorToken?: string }): Config {
  return {
    databaseUrl: 'postgres://los:los@127.0.0.1:5432/los',
    server: { port: 8080, host: '127.0.0.1', corsOrigin: 'http://localhost:5173', localEndpoints: [] },
    auth: {
      enabled: opts.authEnabled,
      token: 'test-token',
      ...(opts.operatorToken ? { operatorToken: opts.operatorToken } : {}),
    },
    integrations: {
      feedAnalysis: {
        resultReturningEnabled: true, maxInlineBytes: 1048576, maxItems: 500,
        materialHosts: [], materialFetchTimeoutMs: 10000, executionTimeoutMs: 120000, callbackPollMs: 5000, callbackProfiles: {},
      },
    },
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

function mockDeps(overrides: Partial<CompatExecuteDependencies> = {}): CompatExecuteDependencies {
  return {
    runScheduledAgentTask: async () => ({
      status: 'completed' as const,
      sessionId: 'session-compat-1',
      taskRun: { id: 'task-compat-1' } as never,
      result: { finalText: 'ok' } as never,
    }),
    listSessionEvents: async () => ([
      {
        id: 1,
        sessionId: 'session-compat-1',
        turn: 0,
        type: 'session.started',
        source: 'test',
        payload: { effectiveModel: 'deepseek-v4-flash', routeReason: 'explicit_model' },
        visibility: 'audit' as const,
        createdAt: new Date().toISOString(),
      },
      {
        id: 2,
        sessionId: 'session-compat-1',
        turn: 1,
        type: 'tool.call',
        source: 'test',
        toolName: 'list_directory',
        payload: {},
        visibility: 'public' as const,
        createdAt: new Date().toISOString(),
      },
      {
        id: 3,
        sessionId: 'session-compat-1',
        turn: 1,
        type: 'tool.call',
        source: 'test',
        toolName: 'read_file',
        payload: {},
        visibility: 'public' as const,
        createdAt: new Date().toISOString(),
      },
      {
        id: 4,
        sessionId: 'session-compat-1',
        turn: 1,
        type: 'tool.result',
        source: 'test',
        toolName: 'read_file',
        payload: { ok: true },
        visibility: 'public' as const,
        createdAt: new Date().toISOString(),
      },
      {
        id: 5,
        sessionId: 'session-compat-1',
        turn: 2,
        type: 'session.completed',
        source: 'test',
        payload: {},
        visibility: 'audit' as const,
        createdAt: new Date().toISOString(),
      },
      {
        id: 6,
        sessionId: 'session-compat-1',
        turn: 2,
        type: 'done',
        source: 'test',
        payload: {},
        visibility: 'public' as const,
        createdAt: new Date().toISOString(),
      },
    ]),
    recordProviderCompatEvidenceFromSummary: async (summary) => ({
      id: `evidence-${summary.provider}`,
      provider: summary.provider,
      model: summary.model,
      probeId: summary.probeId,
      targetLabel: summary.provider,
      decision: summary.passed ? 'verified_advisory' : 'advisory',
      passed: summary.passed,
      totalTokens: summary.totalTokens,
      summary: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
    resolveWorkspaceRoot: (requested) => {
      if (requested && requested.startsWith('/tmp')) {
        throw new Error('workspaceRoot must stay under gateway workspace');
      }
      return process.cwd();
    },
    nowMs: () => 1_700_000_000_000,
    ...overrides,
  };
}

async function buildApp(opts: { authEnabled: boolean; operatorToken?: string }, deps = mockDeps()) {
  const config = buildConfig(opts);
  setConfig(config);
  const app = Fastify({ logger: false });
  await registerRequestContext(app, config);
  registerProviderCompatExecuteRoutes(app, deps);
  return app;
}

test('POST /providers/:name/compat/execute requires operator when auth enabled', async () => {
  const app = await buildApp({ authEnabled: true, operatorToken: 'op-secret' });
  try {
    const denied = await app.inject({
      method: 'POST',
      url: '/providers/deepseek/compat/execute',
      headers: { 'x-los-auth-token': 'test-token' },
      payload: { probe: 'read-context' },
    });
    assert.equal(denied.statusCode, 403);

    const allowed = await app.inject({
      method: 'POST',
      url: '/providers/deepseek/compat/execute',
      headers: {
        'x-los-auth-token': 'test-token',
        'x-los-operator-token': 'op-secret',
      },
      payload: { model: 'deepseek-v4-flash', probe: 'read-context' },
    });
    assert.equal(allowed.statusCode, 200);
    const body = allowed.json();
    assert.equal(body.ok, true);
    assert.equal(body.evidenceId, 'evidence-deepseek');
    assert.equal(body.summary.passed, true);
    assert.ok(body.summary.toolCalls.includes('list_directory'));
    assert.ok(body.summary.toolCalls.includes('read_file'));
    assert.equal(body.summary.rawTranscript, undefined);
    assert.match(String(body.cliEquivalent), /los compat --execute --target deepseek:deepseek-v4-flash --probe read-context/);
  } finally {
    await app.close();
  }
});

test('POST /providers/:name/compat/execute rejects unknown probe', async () => {
  const app = await buildApp({ authEnabled: false });
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/providers/deepseek/compat/execute',
      payload: { probe: 'not-a-real-probe' },
    });
    assert.equal(res.statusCode, 422);
    assert.match(String(res.json().error), /Unknown compatibility probe/);
  } finally {
    await app.close();
  }
});

test('POST /providers/:name/compat/execute rejects workspace escape', async () => {
  const app = await buildApp({ authEnabled: false });
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/providers/deepseek/compat/execute',
      payload: { workspaceRoot: '/tmp/outside' },
    });
    assert.equal(res.statusCode, 422);
    assert.match(String(res.json().error), /workspaceRoot/);
  } finally {
    await app.close();
  }
});

test('POST /providers/:name/compat/execute allows when auth disabled', async () => {
  const app = await buildApp({ authEnabled: false });
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/providers/deepseek/compat/execute',
      payload: { probe: 'read-context' },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().ok, true);
  } finally {
    await app.close();
  }
});
