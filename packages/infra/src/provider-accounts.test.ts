import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { loadConfig } from './config.js';
import { closeDb, getDb, initDb } from './db.js';
import {
  CreateProviderAccountInputSchema,
  createProviderAccount,
  listProviderAccounts,
  loadProviderAccount,
  replaceProviderAccountCredential,
  setProviderAccountState,
} from './provider-accounts.js';

async function openTestDb(): Promise<void> {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
}

test('provider accounts preserve stable identity and distinguish secret scope', async () => {
  await openTestDb();
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const ids = [`xai-local-${suffix}`, `grok-external-${suffix}`, `xai-node-${suffix}`];
  try {
    const local = await createProviderAccount({
      id: ids[0],
      provider: 'xai',
      authMode: 'oauth',
      displayLabel: 'Local xAI OAuth',
      secretRef: 'local-file:los-auth/xai-oauth',
      state: 'active',
      secretScope: 'local_node',
    });
    const external = await createProviderAccount({
      id: ids[1],
      provider: 'xai',
      authMode: 'external_ref',
      displayLabel: 'Grok external session',
      secretRef: 'external:grok/default',
      state: 'unavailable',
      secretScope: 'external_backend',
    });
    const named = await createProviderAccount({
      id: ids[2],
      provider: 'xai',
      authMode: 'oauth',
      displayLabel: 'Named node xAI OAuth',
      secretRef: 'local-file:los-auth/xai-oauth',
      state: 'active',
      secretScope: 'named_node',
      nodeId: 'executor-xai-1',
    });

    assert.equal(local.credentialGeneration, 1);
    assert.equal(local.id, ids[0]);
    assert.equal(local.secretScope, 'local_node');
    assert.equal(local.nodeId, undefined);
    assert.equal(external.secretScope, 'external_backend');
    assert.equal(named.secretScope, 'named_node');
    assert.equal(named.nodeId, 'executor-xai-1');

    const listed = await listProviderAccounts({ provider: 'xai' });
    assert.ok(ids.every(id => listed.some(account => account.id === id)));
    assert.equal((await loadProviderAccount(ids[0]))?.secretRef, 'local-file:los-auth/xai-oauth');
  } finally {
    await getDb().query('DELETE FROM provider_accounts WHERE id = ANY($1)', [ids]).catch(() => undefined);
    await closeDb().catch(() => undefined);
  }
});

test('credential replacement is generation-fenced and clears verification', async () => {
  await openTestDb();
  const id = `xai-generation-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    const created = await createProviderAccount({
      id,
      provider: 'xai',
      authMode: 'api_key',
      displayLabel: 'xAI environment credential',
      secretRef: 'env:XAI_API_KEY',
      state: 'active',
      secretScope: 'local_node',
      verifiedAt: '2026-07-18T08:00:00.000Z',
    });
    const replaced = await replaceProviderAccountCredential({
      id,
      expectedCredentialGeneration: created.credentialGeneration,
      authMode: 'external_ref',
      secretRef: 'external:grok/default',
      secretScope: 'external_backend',
    });

    assert.equal(replaced.credentialGeneration, 2);
    assert.equal(replaced.verifiedAt, undefined);
    await assert.rejects(
      replaceProviderAccountCredential({
        id,
        expectedCredentialGeneration: created.credentialGeneration,
        authMode: 'api_key',
        secretRef: 'env:XAI_API_KEY',
        secretScope: 'local_node',
      }),
      (error: unknown) => error instanceof Error
        && 'code' in error
        && error.code === 'provider_account_generation_conflict',
    );

    const verified = await setProviderAccountState({
      id,
      expectedCredentialGeneration: replaced.credentialGeneration,
      state: 'active',
      verifiedAt: '2026-07-18T09:00:00.000Z',
    });
    assert.equal(verified.credentialGeneration, 2);
    assert.equal(verified.verifiedAt, '2026-07-18T09:00:00.000Z');
  } finally {
    await getDb().query('DELETE FROM provider_accounts WHERE id = $1', [id]).catch(() => undefined);
    await closeDb().catch(() => undefined);
  }
});

test('provider account validation rejects unscoped values and invalid node bindings', () => {
  const base = {
    id: 'xai-validation',
    provider: 'xai',
    authMode: 'oauth' as const,
    displayLabel: 'Validation account',
    state: 'unavailable' as const,
  };
  assert.equal(CreateProviderAccountInputSchema.safeParse({
    ...base,
    secretRef: 'not-a-backend-reference',
    secretScope: 'local_node',
  }).success, false);
  assert.equal(CreateProviderAccountInputSchema.safeParse({
    ...base,
    secretRef: 'local-file:missing-entry',
    secretScope: 'local_node',
  }).success, false);
  assert.equal(CreateProviderAccountInputSchema.safeParse({
    ...base,
    secretRef: 'local-file:los-auth/xai-oauth',
    secretScope: 'named_node',
  }).success, false);
  assert.equal(CreateProviderAccountInputSchema.safeParse({
    ...base,
    secretRef: 'external:grok/default',
    secretScope: 'external_backend',
    nodeId: 'executor-1',
  }).success, false);
});

test('database constraints reject invalid references and missing named-node bindings', async () => {
  await openTestDb();
  const baseId = `xai-db-constraint-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    await assert.rejects(getDb().query(
      `INSERT INTO provider_accounts (
         id, provider, auth_mode, display_label, secret_ref, state, secret_scope, node_id
       ) VALUES ($1, 'xai', 'oauth', 'Invalid reference', $2, 'unavailable', $3, $4)`,
      [`${baseId}-ref`, 'not-a-backend-reference', 'local_node', null],
    ));
    await assert.rejects(getDb().query(
      `INSERT INTO provider_accounts (
         id, provider, auth_mode, display_label, secret_ref, state, secret_scope, node_id
       ) VALUES ($1, 'xai', 'oauth', 'Missing node', $2, 'unavailable', $3, $4)`,
      [`${baseId}-node`, 'local-file:los-auth/xai-oauth', 'named_node', null],
    ));
  } finally {
    await getDb().query('DELETE FROM provider_accounts WHERE id LIKE $1', [`${baseId}%`]).catch(() => undefined);
    await closeDb().catch(() => undefined);
  }
});

test('provider account schema exposes references but no raw credential columns', async () => {
  await openTestDb();
  try {
    const columns = await getDb().query<{ column_name: string }>(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'provider_accounts'`,
    );
    const names = new Set(columns.rows.map(row => row.column_name));
    assert.ok(names.has('secret_ref'));
    for (const forbidden of [
      'access_token',
      'refresh_token',
      'api_key',
      'cookie',
      'auth_snapshot',
      'provider_response',
    ]) {
      assert.equal(names.has(forbidden), false, `forbidden provider_accounts column: ${forbidden}`);
    }

    const migration = readFileSync(
      new URL('../migrations/036_provider_accounts.sql', import.meta.url),
      'utf8',
    );
    assert.doesNotMatch(
      migration,
      /\b(access_token|refresh_token|api_key_value|cookie|auth_snapshot|provider_response)\b/i,
    );
    const publicModule = readFileSync(new URL('./provider-accounts.ts', import.meta.url), 'utf8');
    assert.doesNotMatch(
      publicModule,
      /\b(accessToken|refreshToken|apiKey|cookie|authSnapshot|providerResponse)\s*[?:]/,
    );
  } finally {
    await closeDb().catch(() => undefined);
  }
});
