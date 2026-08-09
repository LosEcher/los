import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  resolveMCPCredentialRef,
} from './mcp-credential-resolver.js';
import { mcpCredentialRefShapeError } from './mcp-distribution-policy.js';
import { readLocalAuthSecretResult } from './auth/local-auth-secret.js';

test('credential_ref shape accepts env and local-file:los-auth only', () => {
  assert.equal(mcpCredentialRefShapeError('env:MCP_TOKEN'), undefined);
  assert.equal(mcpCredentialRefShapeError('local-file:los-auth/xai-oauth'), undefined);
  assert.equal(mcpCredentialRefShapeError('external:vault/mcp'), 'backend_not_implemented');
  assert.equal(mcpCredentialRefShapeError('adapter:k8s/secret'), 'backend_not_implemented');
  assert.equal(mcpCredentialRefShapeError('local-file:other/store'), 'local_file_prefix_not_allowed');
  assert.equal(mcpCredentialRefShapeError('not-a-ref'), 'credential_ref not resolved');
  assert.equal(mcpCredentialRefShapeError(undefined), 'credential_ref not resolved');
});

test('resolveMCPCredentialRef none and oauth paths', async () => {
  const none = await resolveMCPCredentialRef({ mode: 'none' }, {
    serverId: 's1',
    transport: 'stdio',
  });
  assert.equal(none.ok, true);
  if (none.ok) {
    assert.deepEqual(none.env, {});
    assert.deepEqual(none.headers, {});
    assert.equal(none.backend, 'none');
  }

  const oauth = await resolveMCPCredentialRef({ mode: 'oauth', credentialRef: 'env:X' }, {
    serverId: 's1',
    transport: 'stdio',
  });
  assert.equal(oauth.ok, false);
  if (!oauth.ok) assert.match(oauth.reason, /oauth/);
});

test('env credential_ref injects child env for stdio and headers for remote', async () => {
  const env = { MCP_FIXTURE_TOKEN: 'secret-token-value' };

  const stdio = await resolveMCPCredentialRef(
    { mode: 'credential_ref', credentialRef: 'env:MCP_FIXTURE_TOKEN' },
    { serverId: 'stdio-s', transport: 'stdio', env },
  );
  assert.equal(stdio.ok, true);
  if (stdio.ok) {
    assert.deepEqual(stdio.env, { MCP_FIXTURE_TOKEN: 'secret-token-value' });
    assert.deepEqual(stdio.headers, {});
    assert.equal(stdio.backend, 'env');
  }

  const remote = await resolveMCPCredentialRef(
    { mode: 'credential_ref', credentialRef: 'env:MCP_FIXTURE_TOKEN' },
    { serverId: 'remote-s', transport: 'streamable-http', env },
  );
  assert.equal(remote.ok, true);
  if (remote.ok) {
    assert.deepEqual(remote.env, {});
    assert.deepEqual(remote.headers, { Authorization: 'Bearer secret-token-value' });
    assert.equal(remote.backend, 'env');
  }

  const missing = await resolveMCPCredentialRef(
    { mode: 'credential_ref', credentialRef: 'env:MCP_MISSING_TOKEN_XYZ' },
    { serverId: 'missing', transport: 'sse', env: {} },
  );
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.match(missing.reason, /missing/i);
});

test('local-file:los-auth reads access_token from auth store', async () => {
  const root = mkdtempSync(join(tmpdir(), 'los-mcp-auth-'));
  const authPath = join(root, 'auth.json');
  mkdirSync(root, { recursive: true });
  writeFileSync(authPath, JSON.stringify({
    providers: {
      'mcp-fixture': {
        tokens: { access_token: 'local-access-token' },
      },
    },
  }, null, 2));

  const loaded = readLocalAuthSecretResult('local-file:los-auth/mcp-fixture', { authPath });
  assert.equal(loaded.ok, true);
  if (loaded.ok) assert.equal(loaded.value, 'local-access-token');
  assert.equal(
    readLocalAuthSecretResult('local-file:other/key', { authPath }).ok,
    false,
  );

  const remote = await resolveMCPCredentialRef(
    { mode: 'credential_ref', credentialRef: 'local-file:los-auth/mcp-fixture' },
    { serverId: 'local', transport: 'sse', localAuth: { authPath } },
  );
  assert.equal(remote.ok, true);
  if (remote.ok) {
    assert.deepEqual(remote.headers, { Authorization: 'Bearer local-access-token' });
    assert.equal(remote.backend, 'local-file');
  }

  const missing = await resolveMCPCredentialRef(
    { mode: 'credential_ref', credentialRef: 'local-file:los-auth/no-such' },
    { serverId: 'local', transport: 'stdio', localAuth: { authPath } },
  );
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.reason, 'local_file_secret_missing');
});
