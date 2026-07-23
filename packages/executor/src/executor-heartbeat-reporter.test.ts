import assert from 'node:assert/strict';
import test from 'node:test';
import { createHeartbeatReporter } from './executor-heartbeat-reporter.js';

test('heartbeat reporter logs the first failure, periodic reminders, and recovery', async () => {
  let attempts = 0;
  const warnings: string[] = [];
  const infos: string[] = [];
  const reporter = createHeartbeatReporter(
    async () => {
      attempts += 1;
      if (attempts <= 3) {
        const error = new TypeError('fetch failed', {
          cause: Object.assign(new Error('connect ECONNREFUSED 100.64.0.1:8080'), {
            code: 'ECONNREFUSED',
          }),
        });
        throw error;
      }
    },
    {
      warn: message => warnings.push(message),
      info: message => infos.push(message),
    },
    { reminderEvery: 3 },
  );

  await reporter();
  await reporter();
  await reporter();
  await reporter();

  assert.deepEqual(warnings, [
    'node heartbeat failed (1 consecutive): fetch failed (ECONNREFUSED: connect ECONNREFUSED 100.64.0.1:8080)',
    'node heartbeat failed (3 consecutive): fetch failed (ECONNREFUSED: connect ECONNREFUSED 100.64.0.1:8080)',
  ]);
  assert.deepEqual(infos, ['node heartbeat recovered after 3 consecutive failures']);
});

test('heartbeat reporter resets its failure count after recovery', async () => {
  const results = [new Error('first outage'), undefined, new Error('second outage')];
  const warnings: string[] = [];
  const reporter = createHeartbeatReporter(
    async () => {
      const result = results.shift();
      if (result) throw result;
    },
    { warn: message => warnings.push(message), info: () => undefined },
  );

  await reporter();
  await reporter();
  await reporter();

  assert.deepEqual(warnings, [
    'node heartbeat failed (1 consecutive): first outage',
    'node heartbeat failed (1 consecutive): second outage',
  ]);
});

test('heartbeat reporter rejects invalid reminder intervals', () => {
  assert.throws(
    () => createHeartbeatReporter(async () => undefined, { warn: () => undefined, info: () => undefined }, { reminderEvery: 0 }),
    /positive integer/,
  );
});
