import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  KimiCodeAuthError,
  KIMI_CODE_BASE_URL,
  KIMI_OAUTH_TOKEN_ENDPOINT,
  refreshKimiCodeAccessToken,
  resolveKimiCodeCredential,
  _readKimiCredentials,
} from './kimi-code.js';

interface FetchCall {
  url: string;
  init: RequestInit;
}

function okJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function createFixture(t: { after: (fn: () => void) => void }): string {
  const root = mkdtempSync(join(tmpdir(), 'los-kimi-code-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeCredentials(root: string, overrides: Record<string, unknown> = {}): string {
  const path = join(root, 'credentials', 'kimi-code.json');
  mkdirSync(join(root, 'credentials'), { recursive: true });
  writeFileSync(path, JSON.stringify({
    access_token: 'access-valid',
    refresh_token: 'refresh-valid',
    expires_at: Math.floor(Date.now() / 1000) + 600,
    token_type: 'Bearer',
    ...overrides,
  }), 'utf-8');
  return path;
}

function recordFetch(calls: FetchCall[], status = 200, body: unknown = {}): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return okJsonResponse(body, status);
  }) as typeof fetch;
}

test('resolveKimiCodeCredential uses a fresh access token without refreshing', async (t) => {
  const root = createFixture(t);
  const path = writeCredentials(root);
  const calls: FetchCall[] = [];

  const credential = await resolveKimiCodeCredential({
    credentialsPath: path,
    fetchImpl: recordFetch(calls),
  });

  assert.equal(credential.apiKey, 'access-valid');
  assert.equal(credential.baseUrl, KIMI_CODE_BASE_URL);
  assert.equal(calls.length, 0);
});

test('resolveKimiCodeCredential refreshes an expiring token and persists it', async (t) => {
  const root = createFixture(t);
  const path = writeCredentials(root, { expires_at: Math.floor(Date.now() / 1000) - 10 });
  const calls: FetchCall[] = [];

  const credential = await resolveKimiCodeCredential({
    credentialsPath: path,
    fetchImpl: recordFetch(calls, 200, {
      access_token: 'access-refreshed',
      refresh_token: 'refresh-rotated',
      expires_in: 900,
    }),
  });

  assert.equal(credential.apiKey, 'access-refreshed');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, KIMI_OAUTH_TOKEN_ENDPOINT);
  const body = String(calls[0].init.body ?? '');
  assert.match(body, /grant_type=refresh_token/);
  assert.match(body, /refresh_token=refresh-valid/);

  const persisted = _readKimiCredentials(path);
  assert.equal(persisted?.access_token, 'access-refreshed');
  assert.equal(persisted?.refresh_token, 'refresh-rotated');
  assert.ok(typeof persisted?.expires_at === 'number');
});

test('resolveKimiCodeCredential throws when refresh_token is missing', async (t) => {
  const root = createFixture(t);
  const path = writeCredentials(root, { refresh_token: undefined, expires_at: 1 });

  await assert.rejects(
    resolveKimiCodeCredential({ credentialsPath: path }),
    (error: unknown) => error instanceof KimiCodeAuthError && error.code === 'kimi_auth_not_configured',
  );
});

test('resolveKimiCodeCredential propagates refresh HTTP failures', async (t) => {
  const root = createFixture(t);
  const path = writeCredentials(root, { expires_at: 1 });
  const calls: FetchCall[] = [];

  await assert.rejects(
    resolveKimiCodeCredential({
      credentialsPath: path,
      fetchImpl: recordFetch(calls, 401, { error: { message: 'bad grant' } }),
    }),
    (error: unknown) => error instanceof KimiCodeAuthError && error.code === 'kimi_refresh_failed',
  );
});

test('concurrent resolvers share a single refresh (single-flight)', async (t) => {
  const root = createFixture(t);
  const path = writeCredentials(root, { expires_at: 1 });
  let fetchCount = 0;
  const fetchImpl = (async () => {
    fetchCount += 1;
    await new Promise(resolve => setTimeout(resolve, 20));
    return okJsonResponse({ access_token: 'access-one', refresh_token: 'refresh-new', expires_in: 900 });
  }) as typeof fetch;

  const [a, b] = await Promise.all([
    resolveKimiCodeCredential({ credentialsPath: path, fetchImpl }),
    resolveKimiCodeCredential({ credentialsPath: path, fetchImpl }),
  ]);

  assert.equal(a.apiKey, 'access-one');
  assert.equal(b.apiKey, 'access-one');
  assert.equal(fetchCount, 1);
});

test('refreshKimiCodeAccessToken requires a refresh token', async () => {
  await assert.rejects(
    refreshKimiCodeAccessToken('  ', { fetchImpl: (async () => new Response()) as typeof fetch }),
    (error: unknown) => error instanceof KimiCodeAuthError && error.code === 'kimi_auth_missing_refresh_token',
  );
});

test('refreshKimiCodeAccessToken rejects responses without access_token', async (t) => {
  const root = createFixture(t);
  void root;
  await assert.rejects(
    refreshKimiCodeAccessToken('refresh-x', {
      fetchImpl: recordFetch([], 200, { expires_in: 900 }),
    }),
    (error: unknown) => error instanceof KimiCodeAuthError && error.code === 'kimi_refresh_missing_access_token',
  );
});
