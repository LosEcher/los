import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { _XaiOAuthStore } from './xai-oauth-store.js';
import {
  _resolveXaiOAuthCredential,
  XaiOAuthError,
  type XaiOAuthState,
  type XaiOAuthTokens,
} from './xai-oauth.js';

test('xAI auth store writes atomically with private permissions', async (t) => {
  const { root, store } = createFixture(t);
  const first = await store.save(createState(jwtIn(60), 'refresh-1'));
  const second = await store.save(createState(jwtIn(120), 'refresh-2'), {
    expectedGeneration: first.credential_generation,
  });

  assert.equal(first.credential_generation, 1);
  assert.equal(second.credential_generation, 2);
  assert.equal(store.load()?.tokens.refresh_token, 'refresh-2');
  assert.deepEqual(
    readdirSync(dirname(store.authPath)).filter(name => name.endsWith('.tmp') || name.endsWith('.lock')),
    [],
  );
  if (process.platform !== 'win32') {
    assert.equal(statSync(dirname(store.authPath)).mode & 0o777, 0o700);
    assert.equal(statSync(store.authPath).mode & 0o777, 0o600);
  }
  assert.ok(root.startsWith(tmpdir()));
});

test('xAI auth store repairs permissive existing LOS permissions on read', async (t) => {
  const { store } = createFixture(t);
  await store.save(createState(jwtIn(60), 'refresh-existing'));
  if (process.platform === 'win32') return;

  chmodSync(dirname(store.authPath), 0o755);
  chmodSync(store.authPath, 0o644);

  assert.equal(store.load()?.tokens.refresh_token, 'refresh-existing');
  assert.equal(statSync(dirname(store.authPath)).mode & 0o777, 0o700);
  assert.equal(statSync(store.authPath).mode & 0o777, 0o600);
});

test('malformed xAI auth JSON fails closed and preserves the original file', async (t) => {
  const { store } = createFixture(t);
  mkdirSync(dirname(store.authPath), { recursive: true });
  const malformed = '{"providers":{"xai-oauth":';
  writeFileSync(store.authPath, malformed, 'utf-8');

  assert.throws(
    () => store.load(),
    (error: unknown) => error instanceof XaiOAuthError && error.code === 'xai_auth_store_malformed',
  );
  await assert.rejects(
    store.save(createState(jwtIn(60), 'refresh-new')),
    (error: unknown) => error instanceof XaiOAuthError && error.code === 'xai_auth_store_malformed',
  );
  assert.equal(readFileSync(store.authPath, 'utf-8'), malformed);
});

test('credential generation fences stale writers and terminal cleanup', async (t) => {
  const { store } = createFixture(t);
  const first = await store.save(createState(jwtIn(-60), 'refresh-old'));
  const newer = await store.save(createState(jwtIn(120), 'refresh-new'), {
    expectedGeneration: first.credential_generation,
  });

  assert.equal(await store.clear({ expectedGeneration: first.credential_generation }), false);
  await assert.rejects(
    store.save(createState(jwtIn(180), 'refresh-stale'), {
      expectedGeneration: first.credential_generation,
    }),
    (error: unknown) => error instanceof XaiOAuthError && error.code === 'xai_credential_generation_conflict',
  );
  assert.equal(store.load()?.credential_generation, newer.credential_generation);
  assert.equal(store.load()?.tokens.refresh_token, 'refresh-new');
});

test('terminal refresh failure clears only the attempted credential generation', async (t) => {
  const { store } = createFixture(t);
  await store.save(createState(jwtIn(-60), 'refresh-terminal'));

  await assert.rejects(
    _resolveXaiOAuthCredential({
      store,
      baseUrl: 'https://api.x.ai/v1',
      refresh: async () => {
        throw new XaiOAuthError('fixture invalid grant', 'xai_refresh_failed', true);
      },
    }),
    (error: unknown) => error instanceof XaiOAuthError && error.isTerminal,
  );
  assert.equal(store.load(), null);
});

test('concurrent refresh in one process spends a refresh token once', async (t) => {
  const { store } = createFixture(t);
  await store.save(createState(jwtIn(-60), 'refresh-old'));
  let refreshCalls = 0;
  const refresh = async (): Promise<XaiOAuthTokens & { last_refresh: string }> => {
    refreshCalls += 1;
    await delay(30);
    return refreshedTokens(jwtIn(7200), 'refresh-rotated');
  };

  const [first, second] = await Promise.all([
    _resolveXaiOAuthCredential({ store, refresh, baseUrl: 'https://api.x.ai/v1' }),
    _resolveXaiOAuthCredential({ store, refresh, baseUrl: 'https://api.x.ai/v1' }),
  ]);

  assert.equal(refreshCalls, 1);
  assert.equal(first.apiKey, second.apiKey);
  assert.equal(store.load()?.tokens.refresh_token, 'refresh-rotated');
  assert.equal(store.load()?.credential_generation, 2);
});

test('file lock makes a sibling resolver adopt the rotated token', async (t) => {
  const fixture = createFixture(t);
  const sibling = new _XaiOAuthStore({
    authPath: fixture.store.authPath,
    hermesPath: join(fixture.root, 'hermes', 'auth.json'),
    lockTimeoutMs: 1_000,
    lockRetryMs: 5,
  });
  await fixture.store.save(createState(jwtIn(-60), 'refresh-old'));
  let refreshCalls = 0;
  const refresh = async (): Promise<XaiOAuthTokens & { last_refresh: string }> => {
    refreshCalls += 1;
    await delay(30);
    return refreshedTokens(jwtIn(7200), 'refresh-rotated');
  };

  const [first, second] = await Promise.all([
    _resolveXaiOAuthCredential({ store: fixture.store, refresh, baseUrl: 'https://api.x.ai/v1' }),
    _resolveXaiOAuthCredential({ store: sibling, refresh, baseUrl: 'https://api.x.ai/v1' }),
  ]);

  assert.equal(refreshCalls, 1);
  assert.equal(first.apiKey, second.apiKey);
  assert.equal(sibling.load()?.tokens.refresh_token, 'refresh-rotated');
});

function createFixture(t: test.TestContext): { root: string; store: _XaiOAuthStore } {
  const root = mkdtempSync(join(tmpdir(), 'los-xai-oauth-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return {
    root,
    store: new _XaiOAuthStore({
      authPath: join(root, 'los', 'auth.json'),
      hermesPath: join(root, 'hermes', 'auth.json'),
      lockTimeoutMs: 1_000,
      lockRetryMs: 5,
    }),
  };
}

function createState(accessToken: string, refreshToken: string): XaiOAuthState {
  return {
    tokens: {
      access_token: accessToken,
      refresh_token: refreshToken,
      id_token: 'fixture-id-token',
      token_type: 'Bearer',
    },
    discovery: {
      authorization_endpoint: 'https://auth.x.ai/authorize',
      token_endpoint: 'https://auth.x.ai/token',
    },
    redirect_uri: 'http://127.0.0.1:56121/callback',
    auth_mode: 'oauth_pkce',
  };
}

function refreshedTokens(
  accessToken: string,
  refreshToken: string,
): XaiOAuthTokens & { last_refresh: string } {
  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    id_token: 'fixture-id-token-new',
    token_type: 'Bearer',
    last_refresh: '2026-07-18T00:00:00.000Z',
  };
}

function jwtIn(seconds: number): string {
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + seconds })).toString('base64url');
  return `fixture.${payload}.signature`;
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
