import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { getConfig, setConfig } from '@los/infra/config';
import type { GrokRuntimeHandle, GrokRuntimeOutput } from '@los/agent/runtime-adapter';
import type { GrokAccountCandidate } from '@los/infra/discovery';
import type { ProviderAccountRecord } from '@los/infra/provider-accounts';
import { registerRequestContext } from '../../request-context.js';
import {
  registerRuntimeAdapterRoutes,
  type GrokRuntimeRouteDependencies,
} from './runtime-adapter-routes.js';

const candidate: GrokAccountCandidate = {
  candidateId: 'xai-grok-default',
  provider: 'xai',
  runtimeKind: 'grok',
  available: true,
  cliInstalled: true,
  authMode: 'oidc',
  sourceKind: 'default_home',
  reason: null,
};

const account: ProviderAccountRecord = {
  id: 'xai-grok-default',
  provider: 'xai',
  authMode: 'external_ref',
  displayLabel: 'Grok CLI login',
  secretRef: 'external:grok/default',
  state: 'active',
  credentialGeneration: 1,
  secretScope: 'external_backend',
  verifiedAt: '2026-07-18T08:00:00.000Z',
  createdAt: '2026-07-18T08:00:00.000Z',
  updatedAt: '2026-07-18T08:00:00.000Z',
};

function handle(output: Partial<GrokRuntimeOutput> = {}): GrokRuntimeHandle {
  return {
    sessionId: 'ext-grok-fixture',
    pid: 4242,
    kill: () => true,
    exited: Promise.resolve({ exitCode: 0, signal: null }),
    output: Promise.resolve({
      text: 'bounded redacted output',
      capturedBytes: 23,
      totalBytes: 23,
      stderrBytes: 0,
      truncated: false,
      ...output,
    }),
  };
}

function dependencies(options: {
  account?: ProviderAccountRecord | null;
  candidate?: GrokAccountCandidate;
  output?: Partial<GrokRuntimeOutput>;
} = {}): GrokRuntimeRouteDependencies & {
  calls: Array<Record<string, unknown>>;
  verificationWrites: Array<Record<string, unknown>>;
} {
  const calls: Array<Record<string, unknown>> = [];
  const verificationWrites: Array<Record<string, unknown>> = [];
  return {
    calls,
    verificationWrites,
    loadProviderAccount: async () => options.account === undefined ? account : options.account,
    setProviderAccountState: async (input) => {
      verificationWrites.push(input);
      return { ...account, state: input.state, verifiedAt: input.verifiedAt ?? undefined };
    },
    scanGrokAccount: () => options.candidate ?? candidate,
    spawnGrok: input => {
      calls.push(input);
      return handle(options.output);
    },
  };
}

async function buildApp(deps: GrokRuntimeRouteDependencies) {
  const config = getConfig();
  config.auth.enabled = false;
  setConfig(config);
  const app = Fastify({ logger: false });
  registerRequestContext(app, config);
  registerRuntimeAdapterRoutes(app, undefined, deps);
  await app.ready();
  return app;
}

test('Grok runtime requires an active adopted account and fresh login', async () => {
  const missingAccount = dependencies({ account: null });
  const accountApp = await buildApp(missingAccount);
  try {
    const response = await accountApp.inject({
      method: 'POST',
      url: '/runtimes/grok/run',
      payload: { prompt: 'hello', workspaceRoot: process.cwd() },
    });
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().error, 'grok_account_not_active');
    assert.equal(missingAccount.calls.length, 0);
  } finally {
    await accountApp.close();
  }

  const staleLogin = dependencies({
    candidate: { ...candidate, available: false, reason: 'grok_auth_expired' },
  });
  const loginApp = await buildApp(staleLogin);
  try {
    const response = await loginApp.inject({
      method: 'POST',
      url: '/runtimes/grok/run',
      payload: { prompt: 'hello', workspaceRoot: process.cwd() },
    });
    assert.equal(response.statusCode, 503);
    assert.deepEqual(response.json(), { error: 'grok_login_unavailable', reason: 'grok_auth_expired' });
    assert.equal(staleLogin.calls.length, 0);
  } finally {
    await loginApp.close();
  }
});

test('Grok runtime rejects browser env, extra args, invalid workspace, and invalid timeout', async () => {
  const deps = dependencies();
  const app = await buildApp(deps);
  try {
    for (const payload of [
      { prompt: 'hello', workspaceRoot: process.cwd(), env: { GROK_AUTH: 'secret' } },
      { prompt: 'hello', workspaceRoot: process.cwd(), extraArgs: ['--always-approve'] },
      { prompt: 'hello', workspaceRoot: '/definitely/not/a/los/workspace' },
      { prompt: 'hello', workspaceRoot: process.cwd(), timeoutMs: 999 },
    ]) {
      const response = await app.inject({ method: 'POST', url: '/runtimes/grok/run', payload });
      assert.equal(response.statusCode, 400);
    }
    assert.equal(deps.calls.length, 0);
  } finally {
    await app.close();
  }
});

test('Grok runtime streams bounded output with account provenance', async () => {
  const deps = dependencies();
  const app = await buildApp(deps);
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/runtimes/grok/run',
      payload: { prompt: 'hello', workspaceRoot: process.cwd(), timeoutMs: 5_000 },
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.headers['content-type'] ?? '', /text\/event-stream/);
    assert.match(response.body, /event: runtime\.started/);
    assert.match(response.body, /event: runtime\.process/);
    assert.match(response.body, /event: runtime\.output/);
    assert.match(response.body, /event: runtime\.completed/);
    assert.match(response.body, /bounded redacted output/);
    assert.match(response.body, /xai-grok-default/);
    assert.doesNotMatch(response.body, /external:grok\/default|secretRef|stderr/);
    assert.equal(deps.calls.length, 1);
    assert.equal(deps.calls[0]?.prompt, 'hello');
    assert.equal(deps.calls[0]?.timeoutMs, 5_000);
    assert.equal(deps.verificationWrites.length, 1);
    assert.equal(deps.verificationWrites[0]?.id, 'xai-grok-default');
    assert.equal(deps.verificationWrites[0]?.expectedCredentialGeneration, 1);
    assert.equal(deps.verificationWrites[0]?.state, 'active');
    assert.equal(typeof deps.verificationWrites[0]?.verifiedAt, 'string');
  } finally {
    await app.close();
  }
});

test('Grok spawn failures stream only a bounded error code', async () => {
  const deps = dependencies({ output: { text: '', errorCode: 'grok_spawn_failed' } });
  const app = await buildApp(deps);
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/runtimes/grok/run',
      payload: { prompt: 'hello', workspaceRoot: process.cwd() },
    });
    assert.match(response.body, /event: runtime\.error/);
    assert.match(response.body, /grok_spawn_failed/);
    assert.doesNotMatch(response.body, /event: runtime\.completed/);
    assert.equal(deps.verificationWrites.length, 0);
  } finally {
    await app.close();
  }
});
