import assert from 'node:assert/strict';
import test from 'node:test';
import {
  _consumeExecutionKernel,
  _createLosExecutionKernel,
  getLosExecutionKernelIdentity,
  type KernelEvent,
} from './execution-kernel.js';
import type { AgentResult } from './loop.js';

const resultFixture: AgentResult = {
  text: 'done',
  turns: [{ loopCount: 1, text: 'done', toolCalls: [], toolResults: [] }],
  loopCount: 1,
  totalTokens: { prompt: 10, completion: 4 },
  messages: [{ role: 'assistant', content: 'done' }],
};

test('LOS execution kernel preserves callbacks and emits canonical terminal evidence', async () => {
  const callbackOrder: string[] = [];
  const events: KernelEvent[] = [];
  const kernel = _createLosExecutionKernel({
    now: () => new Date('2026-07-22T00:00:00.000Z'),
    runner: async (_prompt, config) => {
      await config.onModelDelta?.({ turn: 1, provider: 'fixture', textDelta: 'done' });
      await config.onToolCall?.('call-1', 'read_file', { path: 'README.md' }, 1);
      await config.onToolCallState?.({
        callId: 'call-1',
        toolName: 'read_file',
        state: 'succeeded',
        turn: 1,
      });
      await config.onTurn?.(resultFixture.turns[0]);
      await config.onCheckpoint?.({ messages: resultFixture.messages, turns: resultFixture.turns });
      return resultFixture;
    },
  });

  const consumed = await _consumeExecutionKernel(kernel, {
    prompt: 'inspect',
    taskRunId: 'task-1',
    sessionId: 'session-1',
    traceId: 'trace-1',
    runSpecId: 'run-1',
    agentConfig: {
      sessionId: 'session-1',
      runSpecId: 'run-1',
      taskRunId: 'task-1',
      onModelDelta: () => { callbackOrder.push('delta'); },
      onToolCall: () => { callbackOrder.push('tool'); },
      onToolCallState: () => { callbackOrder.push('tool-state'); },
      onTurn: () => { callbackOrder.push('turn'); },
      onCheckpoint: () => { callbackOrder.push('checkpoint'); },
    },
  }, event => {
    events.push(event);
  });

  assert.equal(consumed.result, resultFixture);
  assert.deepEqual(callbackOrder, ['delta', 'tool', 'tool-state', 'turn', 'checkpoint']);
  assert.deepEqual(events.map(event => event.type), [
    'kernel.started',
    'turn.started',
    'message.delta',
    'tool.requested',
    'tool.completed',
    'message.completed',
    'turn.completed',
    'checkpoint.created',
    'usage.recorded',
    'kernel.finished',
  ]);
  assert.deepEqual(events.map(event => event.sequence), events.map((_event, index) => index));
  assert.equal(events.at(-1)?.kernel.protocolVersion, '0.1.0');
});

test('LOS execution kernel emits failure before rejecting the consumer', async () => {
  const events: KernelEvent[] = [];
  const kernel = _createLosExecutionKernel({
    runner: async () => { throw new Error('fixture failure'); },
  });

  await assert.rejects(
    _consumeExecutionKernel(kernel, {
      prompt: 'fail',
      taskRunId: 'task-fail',
      sessionId: 'session-fail',
      traceId: 'trace-fail',
      agentConfig: {},
    }, event => { events.push(event); }),
    /fixture failure/,
  );
  assert.equal(events.at(-1)?.type, 'kernel.failed');
  assert.equal(events.at(-1)?.payload.error, 'fixture failure');
});

test('LOS execution kernel advertises current lifecycle limits', async () => {
  const kernel = _createLosExecutionKernel();

  assert.deepEqual(kernel.identity, getLosExecutionKernelIdentity());
  assert.equal(kernel.capabilities().resume, false);
  assert.equal(kernel.capabilities().interrupt, false);
  assert.equal(kernel.capabilities().checkpoint, true);
  assert.deepEqual(await kernel.interrupt({ runSpecId: 'r', taskRunId: 't', reason: 'test' }), {
    accepted: false,
    reason: 'Interrupt is owned by the scheduler AbortSignal in the LOS adapter',
  });
});
