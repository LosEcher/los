import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';

import { ConfigSchema, loadConfig, setConfig } from '@los/infra/config';
import { runAgent } from './loop.js';

async function useFixtureProvider(t: TestContext): Promise<void> {
  const previous = await loadConfig();
  t.after(() => setConfig(previous));
  setConfig(ConfigSchema.parse({
    server: {}, agent: { defaultProvider: 'fixture' }, memory: {}, executor: {}, auth: {},
    providers: {
      fixture: {
        enabled: true,
        apiKey: 'fixture-key',
        baseUrl: 'https://fixture.invalid/v1',
      },
    },
  }));
}

test('runAgent exits early when stop conditions are all met', async (t: TestContext) => {
  await useFixtureProvider(t);
  let calls = 0;
  const readTool = [{
    id: 'call-read',
    type: 'function',
    function: { name: 'read_file', arguments: JSON.stringify({ path: '/tmp/los-stop-condition-fixture.txt' }) },
  }];
  t.mock.method(globalThis, 'fetch', async () => {
    calls += 1;
    const isFinalCheck = calls === 5;
    return new Response(JSON.stringify({
      choices: [{
        message: {
          content: isFinalCheck
            ? 'Stop conditions are all met. pnpm check passes and tests are green.'
            : `Working on it (turn ${calls}).`,
          tool_calls: readTool,
        },
        finish_reason: 'tool_calls',
      }],
      usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      model: 'fixture-model',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });

  const maxLoops = 6;
  const result = await runAgent('Complete the task.', {
    provider: 'fixture',
    toolMode: 'read-only',
    sandboxMode: 'readonly',
    skipPreExecutionPhases: true,
    maxLoops,
    runContractMetadata: { stopConditions: ['pnpm check passes', 'tests are green'] },
  });

  // Default interval is 5: the 5th turn is evaluated and the loop must exit
  // there instead of exhausting maxLoops or continuing to a 6th provider call.
  assert.ok(result.loopCount < maxLoops, `expected early exit, loopCount=${result.loopCount}`);
  assert.equal(result.loopCount, 5);
  assert.equal(calls, 5, 'stop-condition gate must not call the provider past turn 5');
});

test('runAgent exhausts maxLoops when stop conditions are never met', async (t: TestContext) => {
  await useFixtureProvider(t);
  const readTool = [{
    id: 'call-read',
    type: 'function',
    function: { name: 'read_file', arguments: JSON.stringify({ path: '/tmp/los-stop-condition-fixture.txt' }) },
  }];
  t.mock.method(globalThis, 'fetch', async () => {
    return new Response(JSON.stringify({
      choices: [{ message: { content: 'Still working on it.', tool_calls: readTool }, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      model: 'fixture-model',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });

  const maxLoops = 3;
  const result = await runAgent('Complete the task.', {
    provider: 'fixture',
    toolMode: 'read-only',
    sandboxMode: 'readonly',
    skipPreExecutionPhases: true,
    maxLoops,
    runContractMetadata: { stopConditions: ['pnpm check passes'] },
  });

  // Unmet conditions must not stop the loop: it runs to maxLoops and then the
  // forced final-summary turn (loopCount = maxLoops + 1), never a stop-condition exit.
  assert.equal(result.loopCount, maxLoops + 1, 'loop must exhaust maxLoops plus the final summary turn');
});
