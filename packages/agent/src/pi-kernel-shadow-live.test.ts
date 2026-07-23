import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';
import { _collectPiKernelShadowLiveEvidence } from './pi-kernel-shadow-live.js';
import { _getPiKernelShadowScenario } from './pi-kernel-shadow-scenarios.js';
import type { ScheduledAgentTaskInput, ScheduledAgentTaskResult } from './scheduler/types.js';

const agentWorkspaceRoot = resolve(import.meta.dirname, '..');

test('live collector admits only fixed local read-only scheduler scenarios', async () => {
  const inputs: ScheduledAgentTaskInput[] = [];
  let sequence = 0;
  const observations = await _collectPiKernelShadowLiveEvidence({
    provider: 'deepseek',
    model: 'deepseek-v4-flash',
    counts: { 'PKS01-no-tool': 1, 'PKS02-read-only-tool': 1 },
    workspaceRoot: agentWorkspaceRoot,
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
      shadowScenario: item.executionKernelShadow?.scenario?.id,
      workspaceFixture: item.executionKernelShadow?.scenario?.workspaceFixture,
  })), [
    {
      prompt: 'Return exactly LOS_PI_SHADOW_OK and do not call tools.',
      tools: [], toolMode: 'read-only', sandboxMode: 'readonly', remote: undefined,
      shadowScenario: 'PKS01-no-tool', workspaceFixture: undefined,
    },
    {
      prompt: _getPiKernelShadowScenario('PKS02-read-only-tool').prompt,
      tools: ['read_file'], toolMode: 'read-only', sandboxMode: 'readonly', remote: undefined,
      shadowScenario: 'PKS02-read-only-tool',
      workspaceFixture: {
        kind: 'json_string_field',
        fixtureIdentityHash: 'sha256:8e7d7a4208a40bf5c2b29ecfa35bcdf2c5c93e30b89985d0dd80bd92fb1f32e7',
        contentValueHash: 'sha256:536c3bac9a86226cc74f5e8a226b9b006b0d965eb419883804f52a7ad553e7fa',
      },
    },
  ]);
});

test('live collector records a bounded scheduler failure without retrying it', async () => {
  let calls = 0;
  const observations = await _collectPiKernelShadowLiveEvidence({
    provider: 'deepseek', model: 'deepseek-v4-flash', counts: { 'PKS01-no-tool': 3 },
    workspaceRoot: agentWorkspaceRoot,
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
      workspaceRoot: agentWorkspaceRoot,
    }),
    /Invalid live observation count/,
  );
});

test('live collector validates every workspace fixture before any provider call', async () => {
  let calls = 0;
  await assert.rejects(
    _collectPiKernelShadowLiveEvidence({
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      counts: { 'PKS01-no-tool': 1, 'PKS02-read-only-tool': 1 },
      workspaceRoot: resolve(agentWorkspaceRoot, '..', '..'),
    }, {
      run: async () => {
        calls += 1;
        return {} as ScheduledAgentTaskResult;
      },
    }),
    /workspace fixture field mismatch/,
  );
  assert.equal(calls, 0);
});

test('live collector stops when the per-observation hook rejects further collection', async () => {
  let calls = 0;
  const observations = await _collectPiKernelShadowLiveEvidence({
    provider: 'deepseek', model: 'deepseek-v4-flash', counts: { 'PKS01-no-tool': 3 },
    workspaceRoot: agentWorkspaceRoot,
  }, {
    run: async input => {
      calls += 1;
      return { status: 'completed', sessionId: input.sessionId!, taskRun: {}, result: {} } as ScheduledAgentTaskResult;
    },
    afterObservation: async () => 'stop',
  });
  assert.equal(calls, 1);
  assert.equal(observations.length, 1);
});
