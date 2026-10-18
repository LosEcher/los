import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  _defaultCredentialStatePath,
  loadNodeCredential,
  _readPersistedNodeCredential,
  rotateNodeCredentialViaGateway,
  saveNodeCredential,
} from './node-credential.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'los-node-credential-'));
}

test('persisted credential wins over the configured value and is written 0600', () => {
  const dir = tempDir();
  const path = join(dir, 'cred.json');
  try {
    saveNodeCredential('node-a', 'rotated-secret', '2026-12-01T00:00:00.000Z', { path });
    const mode = statSync(path).mode & 0o777;
    assert.equal(mode, 0o600, `credential file must be 0600, got ${mode.toString(8)}`);

    assert.equal(loadNodeCredential('node-a', 'configured-secret', { path }), 'rotated-secret');
    assert.deepEqual(_readPersistedNodeCredential('node-a', { path }), {
      nodeId: 'node-a',
      credential: 'rotated-secret',
      expiresAt: '2026-12-01T00:00:00.000Z',
    });

    // A different node id must not consume this file.
    assert.equal(loadNodeCredential('node-b', 'configured-b', { path }), 'configured-b');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('corrupt or wrong-shaped state files fall back instead of crashing startup', () => {
  const dir = tempDir();
  const path = join(dir, 'cred.json');
  try {
    for (const body of ['not-json', '{"nodeId":"node-a"}', '{"nodeId":"other","credential":"x"}', '{"nodeId":"node-a","credential":""}']) {
      writeFileSync(path, body);
      assert.equal(loadNodeCredential('node-a', 'fallback', { path }), 'fallback', `body=${body}`);
      assert.equal(_readPersistedNodeCredential('node-a', { path }), null);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rotate calls the gateway with the current credential and persists the new one', async () => {
  const dir = tempDir();
  const path = join(dir, 'cred.json');
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fakeFetch = (async (url: any, init: any) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({
      nodeId: 'node-a',
      credential: 'new-secret',
      expiresAt: '2026-11-17T00:00:00.000Z',
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

  try {
    const rotated = await rotateNodeCredentialViaGateway({
      gatewayUrl: 'http://gw:8080/',
      nodeId: 'node-a',
      credential: 'old-secret',
      path,
      fetchImpl: fakeFetch,
    });
    assert.equal(rotated?.credential, 'new-secret');
    assert.equal(rotated?.persisted, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'http://gw:8080/nodes/credential/rotate');
    assert.equal((calls[0].init.headers as Record<string, string>)['x-los-node-credential'], 'old-secret');
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).credential, 'new-secret');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rotation failures return null (heartbeat must keep running on the old credential)', async () => {
  const dir = tempDir();
  const path = join(dir, 'cred.json');
  try {
    const denied = (async () => new Response('{"error":"invalid or expired node credential"}', { status: 401 })) as unknown as typeof fetch;
    assert.equal(await rotateNodeCredentialViaGateway({
      gatewayUrl: 'http://gw:8080', nodeId: 'node-a', credential: 'stale', path, fetchImpl: denied,
    }), null);

    const networkError = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    assert.equal(await rotateNodeCredentialViaGateway({
      gatewayUrl: 'http://gw:8080', nodeId: 'node-a', credential: 'stale', path, fetchImpl: networkError,
    }), null);

    const wrongNode = (async () => new Response(JSON.stringify({ nodeId: 'node-b', credential: 'x' }), { status: 200 })) as unknown as typeof fetch;
    assert.equal(await rotateNodeCredentialViaGateway({
      gatewayUrl: 'http://gw:8080', nodeId: 'node-a', credential: 'stale', path, fetchImpl: wrongNode,
    }), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a failed disk write still returns the rotated credential with persisted=false', async () => {
  const dir = tempDir();
  // Parent "directory" is a regular file ⇒ mkdir fails for any uid (not a chmod trick).
  const blocker = join(dir, 'not-a-directory');
  writeFileSync(blocker, 'x');
  const path = join(blocker, 'cred.json');
  const fakeFetch = (async () => new Response(JSON.stringify({
    nodeId: 'node-a',
    credential: 'new-secret',
    expiresAt: '2026-11-17T00:00:00.000Z',
  }), { status: 200 })) as unknown as typeof fetch;

  try {
    const rotated = await rotateNodeCredentialViaGateway({
      gatewayUrl: 'http://gw:8080', nodeId: 'node-a', credential: 'old-secret', path, fetchImpl: fakeFetch,
    });
    assert.equal(rotated?.credential, 'new-secret', 'memory must switch to the new credential even if disk fails');
    assert.equal(rotated?.persisted, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('default state path is under .los-runtime/executor and encodes the node id', () => {
  const path = _defaultCredentialStatePath('node/with space', '/tmp/work');
  assert.equal(path, '/tmp/work/.los-runtime/executor/node-credential-node%2Fwith%20space.json');
});
