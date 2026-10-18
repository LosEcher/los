import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile, mkdir, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionEventRecord } from '@los/agent';
import { GatewayEventSink, countEventSpool, _pruneEventSpool, replayGatewayEventSpool } from './gateway-event-sink.js';

function event(): SessionEventRecord {
  return {
    id: 1,
    sessionId: 'session-1',
    turn: 0,
    type: 'session.started',
    source: 'los',
    payload: {},
    visibility: 'public',
    createdAt: new Date().toISOString(),
  };
}

test('event sink spools to disk and deletes only after gateway 200', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'los-event-spool-'));
  let seenPath = '';
  let seenToken = '';
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    seenPath = new URL(String(url)).pathname;
    seenToken = new Headers(init?.headers).get('x-los-task-token') ?? '';
    return new Response('{"ok":true}', { status: 200 });
  }) as typeof fetch;
  try {
    const sink = new GatewayEventSink({
      gatewayUrl: 'http://gateway.local', taskRunId: 'task-1', getToken: () => 'tok-1', spoolRoot: dir, fetchImpl,
    });
    await sink.enqueue(event());
    assert.equal(sink.backlog, 1);
    assert.equal((await readdir(join(dir, 'task-1'))).length, 1);
    assert.equal(await sink.drain(2_000), 0);
    assert.equal(seenPath, '/tasks/task-1/events');
    assert.equal(seenToken, 'tok-1');
    assert.equal((await readdir(join(dir, 'task-1'))).length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('event spool replay uses a node credential and removes acknowledged files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'los-event-replay-'));
  const taskDir = join(dir, 'task-2');
  await mkdir(taskDir, { recursive: true });
  await writeFile(join(taskDir, 'event-1.json'), JSON.stringify({
    ...event(), clientEventId: 'task-2:1:0',
  }), 'utf8');
  let credential = '';
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    credential = new Headers(init?.headers).get('x-los-node-credential') ?? '';
    return new Response('{"ok":true}', { status: 200 });
  }) as typeof fetch;
  try {
    const sent = await replayGatewayEventSpool({
      spoolRoot: dir, gatewayUrl: 'http://gateway.local', nodeCredential: 'node-cred', nodeId: 'node-a', fetchImpl,
    });
    assert.equal(sent, 1);
    assert.equal(credential, 'node-cred');
    assert.equal((await readdir(taskDir)).length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});


test('spool quota limits files and health count reflects backlog', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'los-event-quota-'));
  try {
    const sink = new GatewayEventSink({
      gatewayUrl: 'http://gateway.local', taskRunId: 'task-q', getToken: () => 'tok', spoolRoot: dir,
      spoolMaxFiles: 1,
    });
    await sink.enqueue(event());
    await sink.enqueue({ ...event(), id: 2 });
    sink.dispose();
    assert.equal(sink.spoolBacklog, 1);
    assert.equal(sink.spoolDropped, 1);
    assert.equal(await countEventSpool(dir), 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('pruneEventSpool removes only expired spool files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'los-event-prune-'));
  const taskDir = join(dir, 'task-p');
  await mkdir(taskDir, { recursive: true });
  const oldFile = join(taskDir, 'old.json');
  const newFile = join(taskDir, 'new.json');
  await writeFile(oldFile, '{}', 'utf8');
  await writeFile(newFile, '{}', 'utf8');
  const old = new Date(Date.now() - 8 * 24 * 60 * 60_000);
  await utimes(oldFile, old, old);
  try {
    assert.equal(await _pruneEventSpool(dir, 7 * 24 * 60 * 60_000), 1);
    assert.equal(await countEventSpool(dir), 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
