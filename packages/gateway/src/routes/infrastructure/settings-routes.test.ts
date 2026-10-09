import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { loadConfig, setConfig, type Config } from '@los/infra/config';
import authMiddleware from '../../auth-middleware.js';
import { registerRequestContext } from '../../request-context.js';
import { registerSettingsRoutes } from './settings-routes.js';

/**
 * ADR 0047 第 2 节 (c)：provider 路由冲突必须**可见**（禁止静默覆盖）。
 * 但它包含"谁覆盖了谁"的来源信息 ⇒ 属运维诊断面，**只在 operator 路径返回**。
 *
 * 这两条是本次改动的安全边界，必须都有回归：
 *   ① operator 路径能看到冲突
 *   ② 公开 /settings **不得**出现该字段
 */

function config(conflicts: Config['providerRouteConflicts']): Config {
  return {
    databaseUrl: 'postgres://los:los@127.0.0.1:5432/los',
    server: { port: 8080, host: '127.0.0.1', corsOrigin: 'http://localhost:5173', localEndpoints: [] },
    auth: { enabled: true, token: 'access-token', operatorToken: 'operator-token' },
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
    providerRouteConflicts: conflicts,
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
    executor: { enabled: false, host: '127.0.0.1', port: 8090, shutdownGraceMs: 120_000, nodeKind: 'executor', connectModes: [], meshNodes: [] },
    profile: 'test',
    defaultProjectId: 'los',
    migrationsDir: 'packages/infra/migrations',
  };
}

const SAMPLE_CONFLICT = {
  provider: 'packycode',
  field: 'baseUrl' as const,
  previous: 'https://www.packyapi.com/v1',
  next: 'https://www.packyapi.ai/v1',
  winnerSource: 'cc-switch',
  loserSource: '~/.los/config.yaml',
  ownerLayer: 'cc-switch-desktop' as const,
};

async function harness(conflicts: Config['providerRouteConflicts']) {
  const effectiveConfig = config(conflicts);
  setConfig(effectiveConfig);
  const app = Fastify({ logger: false });
  registerRequestContext(app, effectiveConfig);
  await authMiddleware(app, { config: effectiveConfig });
  registerSettingsRoutes(app);
  await app.ready();
  return { app, effectiveConfig };
}

test('operator sees provider route conflicts on GET /settings/private', async () => {
  const previousConfig = await loadConfig();
  const { app } = await harness([SAMPLE_CONFLICT]);
  try {
    const res = await app.inject({
      method: 'GET',
      url: '/settings/private',
      headers: { 'x-los-operator-token': 'operator-token' },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as Record<string, unknown>;
    assert.ok('providerRouteConflicts' in body, 'operator response must expose the conflicts field');
    const conflicts = body.providerRouteConflicts as Array<Record<string, unknown>>;
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0]!.provider, 'packycode');
    assert.equal(conflicts[0]!.field, 'baseUrl');
    assert.equal(conflicts[0]!.winnerSource, 'cc-switch');
  } finally {
    await app.close();
    setConfig(previousConfig);
  }
});

test('NEGATIVE: public GET /settings never exposes provider route conflicts', async () => {
  const previousConfig = await loadConfig();
  const { app } = await harness([SAMPLE_CONFLICT]);
  try {
    const res = await app.inject({ method: 'GET', url: '/settings' });
    assert.equal(res.statusCode, 200);
    const body = res.json() as Record<string, unknown>;
    assert.ok(
      !('providerRouteConflicts' in body),
      'public settings must NOT leak provider route conflicts (it names who overwrote whom)',
    );
  } finally {
    await app.close();
    setConfig(previousConfig);
  }
});

test('empty conflict list is still reported to operator (distinguishes "none" from "not detected")', async () => {
  const previousConfig = await loadConfig();
  const { app } = await harness([]);
  try {
    const res = await app.inject({
      method: 'GET',
      url: '/settings/private',
      headers: { 'x-los-operator-token': 'operator-token' },
    });
    const body = res.json() as Record<string, unknown>;
    assert.deepEqual(body.providerRouteConflicts, []);
  } finally {
    await app.close();
    setConfig(previousConfig);
  }
});
