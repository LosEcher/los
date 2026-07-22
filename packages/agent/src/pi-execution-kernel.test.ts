import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai';
import {
  _consumeExecutionKernel,
  type KernelCheckpoint,
  type KernelEvent,
  type ToolBroker,
} from './execution-kernel.js';
import {
  _createPiExecutionKernel,
  _getPiExecutionKernelIdentity,
  type PiKernelRunInput,
} from './pi-execution-kernel.js';
import type { AgentResult } from './loop.js';

const fixedNow = () => new Date('2026-07-22T00:00:00.000Z');

test('Pi deterministic adapter emits a canonical no-tool trace', async () => {
  const { input } = createFixtureInput([
    fauxAssistantMessage('done'),
  ]);
  const events: KernelEvent[] = [];

  const consumed = await _consumeExecutionKernel<PiKernelRunInput, AgentResult>(
    _createPiExecutionKernel({ now: fixedNow }),
    input,
    event => { events.push(event); },
  );

  assert.equal(consumed.result.text, 'done');
  assert.equal(consumed.result.loopCount, 1);
  assert.deepEqual(events.map(event => event.type), [
    'kernel.started',
    'turn.started',
    'message.delta',
    'message.completed',
    'usage.recorded',
    'turn.completed',
    'checkpoint.created',
    'kernel.finished',
  ]);
  assert.deepEqual(events.map(event => event.sequence), events.map((_event, index) => index));
  assert.deepEqual(events[0]?.kernel, _getPiExecutionKernelIdentity());
});

test('Pi tool trace delegates execution to LOS ToolBroker and preserves call identity', async () => {
  const requests: Array<{ callId: string; name: string; arguments: Record<string, unknown>; turn: number }> = [];
  const broker: ToolBroker = {
    execute: async request => {
      requests.push(request);
      return { callId: request.callId, content: 'file contents' };
    },
  };
  const { input } = createFixtureInput([
    fauxAssistantMessage(fauxToolCall('read_file', { path: 'README.md' }, { id: 'call-1' }), {
      stopReason: 'toolUse',
    }),
    fauxAssistantMessage('inspected'),
  ]);
  input.toolCatalog = [{
    name: 'read_file',
    description: 'Read one file',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
    parallelizable: true,
  }];
  input.toolBroker = broker;
  const events: KernelEvent[] = [];

  const consumed = await _consumeExecutionKernel<PiKernelRunInput, AgentResult>(
    _createPiExecutionKernel({ now: fixedNow }),
    input,
    event => { events.push(event); },
  );

  assert.deepEqual(requests, [{
    callId: 'call-1',
    name: 'read_file',
    arguments: { path: 'README.md' },
    turn: 1,
  }]);
  assert.equal(consumed.result.text, 'inspected');
  assert.equal(consumed.result.loopCount, 2);
  assert.equal(events.find(event => event.type === 'tool.requested')?.toolCallId, 'call-1');
  assert.equal(readTransition(events).state, 'succeeded');
});

test('Pi adapter fails closed without ToolBroker and preserves broker denial evidence', async () => {
  const fixture = createFixtureInput([
    fauxAssistantMessage(fauxToolCall('write_file', { path: 'x' }, { id: 'call-denied' }), {
      stopReason: 'toolUse',
    }),
    fauxAssistantMessage('blocked'),
  ]);
  fixture.input.toolCatalog = [{ name: 'write_file', description: 'Write', parameters: { type: 'object' } }];
  await assert.rejects(
    _consumeExecutionKernel(_createPiExecutionKernel(), fixture.input),
    /requires the LOS ToolBroker/,
  );

  fixture.input.toolBroker = {
    execute: async request => ({ callId: request.callId, content: '', error: 'policy denied', denied: true }),
  };
  const events: KernelEvent[] = [];
  await _consumeExecutionKernel(
    _createPiExecutionKernel({ now: fixedNow }),
    fixture.input,
    event => { events.push(event); },
  );
  assert.equal(readTransition(events).state, 'denied');
});

test('Pi adapter emits kernel.failed for a provider error', async () => {
  const { input } = createFixtureInput([
    fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'fixture provider failure' }),
  ]);
  const events: KernelEvent[] = [];

  await assert.rejects(
    _consumeExecutionKernel(
      _createPiExecutionKernel({ now: fixedNow }),
      input,
      event => { events.push(event); },
    ),
    /fixture provider failure/,
  );
  assert.equal(events.at(-1)?.type, 'kernel.failed');
  assert.equal(events.at(-1)?.payload.error, 'fixture provider failure');
});

test('Pi adapter accepts an interrupt for an active attempt', async () => {
  const { input } = createFixtureInput([fauxAssistantMessage('too late')]);
  const kernel = _createPiExecutionKernel({ now: fixedNow });
  const events: KernelEvent[] = [];

  for await (const event of kernel.run(input)) {
    events.push(event);
    if (event.type === 'kernel.started') {
      assert.deepEqual(await kernel.interrupt({
        runSpecId: input.runSpecId!,
        taskRunId: input.taskRunId,
        reason: 'operator stop',
      }), { accepted: true });
    }
  }

  assert.equal(events.at(-1)?.type, 'kernel.interrupted');
  assert.match(String(events.at(-1)?.payload.reason), /operator stop|aborted/);
});

test('Pi adapter settles an active attempt when the event consumer stops early', async () => {
  const { input } = createFixtureInput([fauxAssistantMessage('unused')]);
  const kernel = _createPiExecutionKernel({ now: fixedNow });

  for await (const event of kernel.run(input)) {
    assert.equal(event.type, 'kernel.started');
    break;
  }

  assert.deepEqual(await kernel.interrupt({
    runSpecId: input.runSpecId!,
    taskRunId: input.taskRunId,
    reason: 'after close',
  }), { accepted: false, reason: 'Pi kernel attempt is not active' });
});

test('Pi adapter resumes an exact-version checkpoint and rejects incompatible codecs', async () => {
  const first = createFixtureInput([fauxAssistantMessage('first')]);
  let checkpoint: KernelCheckpoint | undefined;
  await _consumeExecutionKernel(
    _createPiExecutionKernel({ now: fixedNow }),
    first.input,
    event => {
      if (event.type === 'checkpoint.created') checkpoint = event.payload.checkpoint as KernelCheckpoint;
    },
  );
  assert.ok(checkpoint);

  const resumed = createFixtureInput([fauxAssistantMessage('second')]);
  const events: KernelEvent[] = [];
  for await (const event of _createPiExecutionKernel({ now: fixedNow }).resume({
    run: resumed.input,
    checkpoint,
  })) {
    events.push(event);
  }
  const result = events.at(-1)?.payload.result as AgentResult;
  assert.equal(events.at(-1)?.type, 'kernel.finished');
  assert.equal(result.text, 'second');
  assert.ok(result.messages.some(message => message.role === 'assistant' && message.content === 'first'));

  const incompatible = { ...checkpoint, codec: 'future-codec' };
  const incompatibleEvents: KernelEvent[] = [];
  await assert.rejects(async () => {
    for await (const event of _createPiExecutionKernel({ now: fixedNow }).resume({
      run: resumed.input,
      checkpoint: incompatible,
    })) incompatibleEvents.push(event);
  }, /cannot resume/);
  assert.equal(incompatibleEvents.at(-1)?.type, 'kernel.failed');
});

function createFixtureInput(responses: Parameters<ReturnType<typeof fauxProvider>['setResponses']>[0]): {
  input: PiKernelRunInput;
} {
  const faux = fauxProvider({ tokensPerSecond: 0 });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(responses);
  return {
    input: {
      prompt: 'fixture prompt',
      systemPrompt: 'You are a fixture.',
      taskRunId: `task-${Math.random()}`,
      sessionId: `session-${Math.random()}`,
      traceId: `trace-${Math.random()}`,
      runSpecId: `run-${Math.random()}`,
      model: faux.getModel(),
      streamFn: models.streamSimple.bind(models),
    },
  };
}

function readTransition(events: KernelEvent[]): Record<string, unknown> {
  return events.find(event => event.type === 'tool.completed')?.payload.transition as Record<string, unknown>;
}
