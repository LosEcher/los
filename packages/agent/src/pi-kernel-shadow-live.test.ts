import assert from 'node:assert/strict';
import test from 'node:test';
import { _collectPiKernelShadowLiveEvidence } from './pi-kernel-shadow-live.js';
import type { ScheduledAgentTaskInput, ScheduledAgentTaskResult } from './scheduler/types.js';

test('live collector admits only fixed local read-only scheduler scenarios', async () => {
  const inputs: ScheduledAgentTaskInput[] = [];
  let sequence = 0;
  const observations = await _collectPiKernelShadowLiveEvidence({
    provider: 'deepseek',
    model: 'deepseek-v4-flash',
    counts: { 'PKS01-no-tool': 1, 'PKS02-read-only-tool': 1 },
    workspaceRoot: '/fixture/workspace',
  }, {
    id: () => `test-${sequence++}`,
    run: async input => {
      inputs.push(input);
      return { status: 'completed', sessionId: input.sessionId!, taskRun: {}, result: {} } as ScheduledAgentTaskResult;
    },
  });

  assert.deepEqual(observations.map(item => item.status), ['completed', 'completed']);
  assert.deepEqual(inputs.map(item => ({
    prompt: item.prompt,
    tools: item.allowedTools,
    toolMode: item.toolMode,
    sandboxMode: item.sandboxMode,
    remote: item.executor,
    shadow: item.executionKernelShadow,
  })), [
    {
      prompt: 'Return exactly LOS_PI_SHADOW_OK and do not call tools.',
      tools: [], toolMode: 'read-only', sandboxMode: 'readonly', remote: undefined,
      shadow: { kind: 'pi', maxTurns: 3, scenario: { id: 'PKS01-no-tool' } },
    },
    {
      prompt: 'Use read_file on package.json, then return one JSON object with exactly one field: {"packageName":"<package name>"}.',
      tools: ['read_file'], toolMode: 'read-only', sandboxMode: 'readonly', remote: undefined,
      shadow: { kind: 'pi', maxTurns: 3, scenario: { id: 'PKS02-read-only-tool' } },
    },
  ]);
});

test('live collector records a bounded scheduler failure without retrying it', async () => {
  let calls = 0;
  const observations = await _collectPiKernelShadowLiveEvidence({
    provider: 'deepseek', model: 'deepseek-v4-flash', counts: { 'PKS01-no-tool': 1 },
  }, {
    run: async () => { calls += 1; throw new Error('fixture live failure'); },
  });
  assert.equal(calls, 1);
  assert.equal(observations[0]?.status, 'failed');
  assert.equal(observations[0]?.error, 'fixture live failure');
});

test('live collector caps each scenario at the preregistered repeat count', async () => {
  await assert.rejects(
    _collectPiKernelShadowLiveEvidence({
      provider: 'deepseek', model: 'deepseek-v4-flash', counts: { 'PKS01-no-tool': 4 },
    }),
    /Invalid live observation count/,
  );
});
