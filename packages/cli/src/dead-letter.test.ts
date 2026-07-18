import test from 'node:test';
import assert from 'node:assert/strict';
import { deadLetterCommand } from './dead-letter.js';

test('dead-letter ack sends audited resolution and operator credentials', async () => {
  const originalFetch = globalThis.fetch;
  const originalOperatorToken = process.env.LOS_OPERATOR_TOKEN;
  const requests: Request[] = [];
  process.env.LOS_OPERATOR_TOKEN = 'operator-fixture';
  globalThis.fetch = async (input, init) => {
    requests.push(new Request(input, init));
    return new Response(JSON.stringify({ id: 'dlq-1', resolution: 'superseded' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  try {
    await deadLetterCommand([], [
      'ack', 'dlq-1', '--resolution', 'superseded', '--note', 'historical probe', '--json',
    ]);
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.headers.get('x-los-operator-token'), 'operator-fixture');
    assert.deepEqual(await requests[0]?.json(), {
      resolution: 'superseded',
      note: 'historical probe',
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalOperatorToken === undefined) delete process.env.LOS_OPERATOR_TOKEN;
    else process.env.LOS_OPERATOR_TOKEN = originalOperatorToken;
  }
});

test('dead-letter ack requires an explicit resolution', async () => {
  await assert.rejects(
    deadLetterCommand([], ['ack', 'dlq-1']),
    /requires --resolution/,
  );
});
