import assert from 'node:assert/strict';
import Fastify from 'fastify';
import test from 'node:test';
import { setConfig, type Config } from '@los/infra/config';
import authMiddleware from '../../auth-middleware.js';
import { registerRequestContext } from '../../request-context.js';
import { registerGovernanceRoutes } from './governance-routes.js';

function config(): Config {
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
    executor: { enabled: false, host: '127.0.0.1', port: 8090, shutdownGraceMs: 120_000, nodeKind: 'executor', connectModes: [], meshNodes: [] },
    profile: 'test',
    defaultProjectId: 'los',
    migrationsDir: 'packages/infra/migrations',
  };
}

function makeJob(overrides: Record<string, unknown> = {}) {
  return {
    id: 'job-1',
    jobType: 'self_bootstrap',
    cadence: 'daily',
    status: 'active',
    autoFix: { autoFixEnabled: false },
    circuitState: 'closed',
    consecutiveNoOps: 0,
    consecutiveFailures: 0,
    lastRunAt: null,
    nextRunAt: null,
    lastTaskRunId: null,
    resultSummary: { findingCount: 2, findings: [{ dimension: 'todo_lifecycle' }] },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    config: {},
    ...overrides,
  };
}

test('governance routes list self_bootstrap, reject non-operator writes, and pause/resume', async () => {
  const store = new Map<string, any>([['self_bootstrap', makeJob()]]);
  const app = Fastify({ logger: false });
  const effective = config();
  setConfig(effective);
  registerRequestContext(app, effective);
  await authMiddleware(app, { config: effective });

  registerGovernanceRoutes(app, {
    ensureGovernanceJobStore: async () => {},
    seedGovernanceJobs: async () => {},
    listGovernanceJobs: async (opts: any) => {
      if (opts?.jobType) {
        const job = store.get(opts.jobType);
        return job ? [job] : [];
      }
      return [...store.values()];
    },
    updateGovernanceJob: async (id: string, patch: Record<string, unknown>) => {
      const job = [...store.values()].find(j => j.id === id) ?? store.get('self_bootstrap');
      Object.assign(job, patch);
      return job;
    },
    runGovernanceSweep: async () => ({
      dryRun: false,
      jobsRun: 1,
      jobsSkipped: 0,
      findingsCreated: 1,
      errors: [],
      results: [{ jobId: 'job-1', jobType: 'self_bootstrap', summary: { findingCount: 1 }, durationMs: 12 }],
    }),
  } as any);

  try {
    const auth = { 'x-los-auth-token': 'access-token' };
    const operator = { ...auth, 'x-los-operator-token': 'operator-token' };

    const list = await app.inject({ method: 'GET', url: '/governance/jobs', headers: auth });
    assert.equal(list.statusCode, 200);
    const body = list.json();
    assert.equal(body.count, 1);
    assert.equal(body.jobs[0].jobType, 'self_bootstrap');
    assert.equal(body.jobs[0].findingCount, 2);
    assert.ok(body.knownJobTypes.includes('self_bootstrap'));
    assert.ok(body.knownJobTypes.includes('adversarial_review'));

    const denied = await app.inject({
      method: 'POST',
      url: '/governance/jobs/self_bootstrap/run',
      headers: auth,
      payload: {},
    });
    assert.equal(denied.statusCode, 403);

    const run = await app.inject({
      method: 'POST',
      url: '/governance/jobs/self_bootstrap/run',
      headers: operator,
      payload: {},
    });
    assert.equal(run.statusCode, 200);
    assert.equal(run.json().jobsRun, 1);
    assert.equal(run.json().findingsCreated, 1);

    const pause = await app.inject({
      method: 'POST',
      url: '/governance/jobs/self_bootstrap/status',
      headers: operator,
      payload: { status: 'paused' },
    });
    assert.equal(pause.statusCode, 200);
    assert.equal(pause.json().jobs[0].status, 'paused');

    const unknown = await app.inject({
      method: 'GET',
      url: '/governance/jobs/not_a_job',
      headers: auth,
    });
    assert.equal(unknown.statusCode, 400);
  } finally {
    await app.close();
  }
});
