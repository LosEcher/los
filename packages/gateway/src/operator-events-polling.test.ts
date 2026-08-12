import assert from 'node:assert/strict';
import test from 'node:test';
import { _createExclusivePoll } from './routes/streaming/operator-events-sse.js';

test('operator event polling never overlaps an in-flight database poll', async () => {
  let pollCount = 0;
  let releaseFirst: (() => void) | undefined;
  const firstPending = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const poll = _createExclusivePoll(async () => {
    pollCount += 1;
    if (pollCount === 1) await firstPending;
  });

  const first = poll();
  const overlapping = await poll();
  assert.equal(overlapping, false);
  assert.equal(pollCount, 1);

  releaseFirst?.();
  assert.equal(await first, true);
  assert.equal(await poll(), true);
  assert.equal(pollCount, 2);
});
