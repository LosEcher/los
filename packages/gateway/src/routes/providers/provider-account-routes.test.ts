import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { getConfig, setConfig } from '@los/infra/config';
import type { GrokAccountCandidate } from '@los/infra/discovery';
import type { ProviderAccountRecord } from '@los/infra/provider-accounts';
import { registerRequestContext } from '../../request-context.js';
import {
  registerProviderCrudRoutes,
  type ProviderAccountRouteDependencies,
} from './provider-crud-routes.js';

const availableCandidate: GrokAccountCandidate = {
  candidateId: 'xai-grok-default',
  provider: 'xai',
  runtimeKind: 'grok',
  available: true,
  cliInstalled: true,
  authMode: 'oidc',
  sourceKind: 'default_home',
  reason: null,
};

function account(overrides: Partial<ProviderAccountRecord> = {}): ProviderAccountRecord {
  return {
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
    ...overrides,
  };
}

function dependencies(options: {
  candidate?: GrokAccountCandidate;
  existing?: ProviderAccountRecord | null;
} = {}): ProviderAccountRouteDependencies & {
  writes: Array<Record<string, unknown>>;
} {
  const writes: Array<Record<string, unknown>> = [];
  const existing = options.existing ?? null;
  return {
    writes,
    scanGrokAccount: () => options.candidate ?? availableCandidate,
    listProviderAccounts: async () => existing ? [existing] : [],
    loadProviderAccount: async () => existing,
    createProviderAccount: async (input) => {
      writes.push({ kind: 'create', ...input });
      return account({
        ...input,
        credentialGeneration: 1,
        verifiedAt: input.verifiedAt,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    },
    setProviderAccountState: async (input) => {
      writes.push({ kind: 'state', ...input });
      return account({
        ...existing,
        state: input.state,
        verifiedAt: input.verifiedAt === null ? undefined : input.verifiedAt ?? existing?.verifiedAt,
      });
    },
  };
}

async function buildApp(deps: ProviderAccountRouteDependencies) {
  const config = getConfig();
  config.auth.enabled = false;
  setConfig(config);
  const app = Fastify({ logger: false });
  registerRequestContext(app, config);
  registerProviderCrudRoutes(app, deps);
  await app.ready();
  return app;
}

test('provider account discovery and list responses never expose credential references', async () => {
  const deps = dependencies({ existing: account() });
  const app = await buildApp(deps);
  try {
    const discovery = await app.inject({ method: 'GET', url: '/providers/accounts/discovery' });
    assert.equal(discovery.statusCode, 200);
    assert.deepEqual(discovery.json(), { grok: availableCandidate });

    const list = await app.inject({ method: 'GET', url: '/providers/accounts' });
    assert.equal(list.statusCode, 200);
    assert.equal(list.json().accounts[0].id, 'xai-grok-default');
    assert.equal('secretRef' in list.json().accounts[0], false);
    assert.doesNotMatch(list.body, /external:grok|auth\.json|access_token|refresh_token/);
  } finally {
    await app.close();
  }
});

test('Grok adoption creates only the fixed opaque external account reference', async () => {
  const deps = dependencies();
  const app = await buildApp(deps);
  try {
    const response = await app.inject({ method: 'POST', url: '/providers/accounts/grok' });
    assert.equal(response.statusCode, 201);
    assert.equal(response.json().account.id, 'xai-grok-default');
    assert.equal('secretRef' in response.json().account, false);
    assert.equal(deps.writes.length, 1);
    assert.deepEqual(deps.writes[0], {
      kind: 'create',
      id: 'xai-grok-default',
      provider: 'xai',
      authMode: 'external_ref',
      displayLabel: 'Grok CLI login',
      secretRef: 'external:grok/default',
      state: 'active',
      secretScope: 'external_backend',
    });
  } finally {
    await app.close();
  }
});

test('Grok adoption reactivates a matching disabled account', async () => {
  const deps = dependencies({ existing: account({ state: 'disabled' }) });
  const app = await buildApp(deps);
  try {
    const response = await app.inject({ method: 'POST', url: '/providers/accounts/grok' });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().account.state, 'active');
    assert.equal(deps.writes.length, 1);
    assert.deepEqual(deps.writes[0], {
      kind: 'state',
      id: 'xai-grok-default',
      expectedCredentialGeneration: 1,
      state: 'active',
      verifiedAt: null,
    });
  } finally {
    await app.close();
  }
});

test('unavailable or conflicting Grok discovery leaves accounts unchanged', async () => {
  const unavailable = dependencies({
    candidate: { ...availableCandidate, available: false, reason: 'grok_auth_not_found' },
  });
  const unavailableApp = await buildApp(unavailable);
  try {
    const response = await unavailableApp.inject({ method: 'POST', url: '/providers/accounts/grok' });
    assert.equal(response.statusCode, 404);
    assert.deepEqual(response.json(), { error: 'grok_login_unavailable', reason: 'grok_auth_not_found' });
    assert.equal(unavailable.writes.length, 0);
  } finally {
    await unavailableApp.close();
  }

  const conflicting = dependencies({ existing: account({ secretRef: 'env:XAI_API_KEY' }) });
  const conflictApp = await buildApp(conflicting);
  try {
    const response = await conflictApp.inject({ method: 'POST', url: '/providers/accounts/grok' });
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().error, 'provider_account_conflict');
    assert.equal(conflicting.writes.length, 0);
  } finally {
    await conflictApp.close();
  }
});
