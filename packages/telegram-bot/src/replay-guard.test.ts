import assert from 'node:assert/strict';
import test from 'node:test';
import { TelegramReplayGuard } from './replay-guard.js';

test('replay guard atomically collapses concurrent update and callback keys', async () => {
  const guard = new TelegramReplayGuard();
  let executions = 0;
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const operation = async () => {
    executions += 1;
    await blocked;
  };

  const first = guard.runOnce(['update:1', 'callback:abc'], operation);
  const replayByUpdate = guard.runOnce(['update:1', 'callback:def'], operation);
  const replayByCallback = guard.runOnce(['update:2', 'callback:abc'], operation);
  release();

  assert.deepEqual(await Promise.all([first, replayByUpdate, replayByCallback]), [true, false, false]);
  assert.equal(executions, 1);
  assert.equal(await guard.runOnce(['update:1'], operation), false);
});

test('replay guard allows retry after a failed first execution', async () => {
  const guard = new TelegramReplayGuard();
  await assert.rejects(guard.runOnce(['update:3'], async () => { throw new Error('retry'); }), /retry/);
  assert.equal(await guard.runOnce(['update:3'], async () => undefined), true);
});

test('replay guard binds all aliases after a completed-key collision', async () => {
  const guard = new TelegramReplayGuard();
  let executions = 0;
  const operation = async () => { executions += 1; };

  assert.equal(await guard.runOnce(['update:10', 'callback:a'], operation), true);
  assert.equal(await guard.runOnce(['update:11', 'callback:a'], operation), false);
  assert.equal(await guard.runOnce(['update:11', 'callback:b'], operation), false);
  assert.equal(executions, 1);
});
