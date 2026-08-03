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

  await reporter.run();
  await reporter.run();
  await reporter.run();
  await reporter.run();

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

  await reporter.run();
  await reporter.run();
  await reporter.run();

  assert.deepEqual(warnings, [
    'node heartbeat failed (1 consecutive): first outage',
    'node heartbeat failed (1 consecutive): second outage',
  ]);
});

test('heartbeat reporter backs off exponentially while failing and resets on recovery', async () => {
  let attempts = 0;
  const reporter = createHeartbeatReporter(
    async () => {
      attempts += 1;
      if (attempts <= 4) throw new Error(`outage ${attempts}`);
    },
    { warn: () => undefined, info: () => undefined },
    { baseIntervalMs: 10_000, backoffFactor: 3, maxBackoffMs: 900_000 },
  );

  assert.equal(reporter.nextIntervalMs(), 10_000, 'healthy interval is the base');

  await reporter.run();
  assert.equal(reporter.nextIntervalMs(), 30_000, '1st failure: base * 3');

  await reporter.run();
  assert.equal(reporter.nextIntervalMs(), 90_000, '2nd failure: base * 9');

  await reporter.run();
  assert.equal(reporter.nextIntervalMs(), 270_000, '3rd failure: base * 27');

  await reporter.run();
  assert.equal(reporter.nextIntervalMs(), 810_000, '4th failure: base * 81');

  await reporter.run(); // recovery
  assert.equal(reporter.nextIntervalMs(), 10_000, 'recovered: back to base');
});

test('heartbeat reporter caps backoff at maxBackoffMs', async () => {
  const reporter = createHeartbeatReporter(
    async () => {
      throw new Error('persistent outage');
    },
    { warn: () => undefined, info: () => undefined },
    { baseIntervalMs: 10_000, backoffFactor: 3, maxBackoffMs: 60_000 },
  );

  for (let i = 0; i < 10; i += 1) {
    await reporter.run();
  }
  assert.equal(reporter.nextIntervalMs(), 60_000, 'backoff never exceeds the cap');
});

test('heartbeat reporter rejects invalid options', () => {
  assert.throws(
    () => createHeartbeatReporter(async () => undefined, { warn: () => undefined, info: () => undefined }, { reminderEvery: 0 }),
    /positive integer/,
  );
  assert.throws(
    () => createHeartbeatReporter(async () => undefined, { warn: () => undefined, info: () => undefined }, { baseIntervalMs: 0 }),
    /positive integer/,
  );
  assert.throws(
    () => createHeartbeatReporter(async () => undefined, { warn: () => undefined, info: () => undefined }, { maxBackoffMs: -1 }),
    /positive integer/,
  );
});
