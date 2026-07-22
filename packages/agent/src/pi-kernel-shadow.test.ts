import assert from 'node:assert/strict';
import test from 'node:test';
import type { SessionEventWrite } from './session-events.js';
import type { AgentConfig, AgentResult } from './loop.js';
import type { KernelEvent } from './execution-kernel.js';
import { startPiKernelShadow } from './pi-kernel-shadow.js';

const productionResult: AgentResult = {
  text: 'production answer',
  turns: [],
  loopCount: 1,
  totalTokens: { prompt: 10, completion: 4 },
  messages: [],
};

test('Pi shadow forces derived read-only lineage and persists only bounded comparison evidence', async () => {
  const writes: SessionEventWrite[] = [];
  let candidateConfig: AgentConfig | undefined;
  const shadow = startPiKernelShadow(baseInput(), {
    now: sequenceNow(100, 125),
    runCandidate: async input => {
      candidateConfig = input.config;
      return {
        result: { ...productionResult, text: 'candidate secret answer', totalTokens: { prompt: 12, completion: 5 } },
        events: [startedEvent(), event('tool.requested'), event('tool.completed'), event('kernel.finished')],
        route: { provider: 'deepseek', model: 'deepseek-v4-flash', api: 'openai-completions' },
      };
    },
    appendEvent: async input => {
      writes.push(input);
      return {} as never;
    },
  });

  const outcome = await shadow.settle(productionResult);

  assert.equal(candidateConfig?.toolMode, 'read-only');
  assert.equal(candidateConfig?.sandboxMode, 'readonly');
  assert.equal(candidateConfig?.sessionId, 'session-main:shadow:pi');
  assert.equal(candidateConfig?.taskRunId, 'task-main:shadow:pi');
  assert.equal(candidateConfig?.traceId, 'trace-main:shadow:pi');
  assert.equal(candidateConfig?.onToolCallState, undefined);
  assert.equal(outcome.status, 'completed');
  assert.equal(outcome.toolCallCount, 1);
  assert.equal(outcome.latencyMs, 25);
  assert.deepEqual(outcome.route, { provider: 'deepseek', model: 'deepseek-v4-flash', api: 'openai-completions' });
  assert.equal(typeof outcome.estimatedCostUsd, 'number');
  assert.match(outcome.outputHash ?? '', /^sha256:/);
  assert.equal(writes[0]?.sessionId, 'session-main');
  assert.equal(writes[0]?.type, 'kernel.shadow.compared');
  assert.equal(JSON.stringify(writes[0]?.payload).includes('candidate secret answer'), false);
  assert.equal(JSON.stringify(writes[0]?.payload).includes('production answer'), false);
});

test('Pi shadow attaches preregistered scenario assertions to bounded evidence', async () => {
  const writes: SessionEventWrite[] = [];
  const input = baseInput();
  input.shadow.scenario = { id: 'PKS01-no-tool' };
  input.prompt = 'Return exactly LOS_PI_SHADOW_OK and do not call tools.';
  input.config.allowedTools = [];
  const shadow = startPiKernelShadow(input, {
    runCandidate: async () => ({
      result: { ...productionResult, text: productionResult.text },
      events: [startedEvent(), event('kernel.finished')],
    }),
    appendEvent: async eventInput => { writes.push(eventInput); return {} as never; },
  });

  const outcome = await shadow.settle(productionResult);
  assert.equal(outcome.scenarioEvidence?.passed, true);
  assert.equal(outcome.scenarioEvidence?.evidenceClass, 'deterministic');
  assert.equal(outcome.scenarioEvidence?.scenarioId, 'PKS01-no-tool');
  assert.equal(writes[0]?.payload?.scenarioEvidence && typeof writes[0].payload.scenarioEvidence, 'object');
});

test('Pi shadow contains invalid scenario evidence without affecting settlement', async () => {
  const input = baseInput();
  input.shadow.scenario = { id: 'unknown' as 'PKS01-no-tool' };
  const shadow = startPiKernelShadow(input, {
    runCandidate: async () => ({ result: productionResult, events: [startedEvent(), event('kernel.finished')] }),
    appendEvent: async () => ({} as never),
  });

  const outcome = await shadow.settle(productionResult);
  assert.equal(outcome.status, 'completed');
  assert.match(outcome.scenarioEvidenceError ?? '', /Unknown Pi kernel shadow scenario/);
});

test('Pi shadow turns candidate failure and interruption into evidence without throwing', async () => {
  const writes: SessionEventWrite[] = [];
  const failed = startPiKernelShadow(baseInput(), {
    runCandidate: async () => ({ events: [startedEvent(), event('kernel.failed')], error: new Error('provider credential leaked? no') }),
    appendEvent: async input => { writes.push(input); return {} as never; },
  });
  const interrupted = startPiKernelShadow(baseInput(), {
    runCandidate: async () => ({ events: [startedEvent(), event('kernel.interrupted')] }),
    appendEvent: async input => { writes.push(input); return {} as never; },
  });

  assert.equal((await failed.settle(productionResult)).status, 'failed');
  assert.equal((await interrupted.settle(productionResult)).status, 'interrupted');
  assert.equal(writes.length, 2);
});

test('Pi shadow cancellation aborts the candidate and records failed production status', async () => {
  const writes: SessionEventWrite[] = [];
  let candidateSignal: AbortSignal | undefined;
  const shadow = startPiKernelShadow(baseInput(), {
    runCandidate: async input => {
      candidateSignal = input.config.signal;
      await new Promise<void>(resolve => candidateSignal?.addEventListener('abort', () => resolve(), { once: true }));
      return { events: [startedEvent(), event('kernel.interrupted')] };
    },
    appendEvent: async input => { writes.push(input); return {} as never; },
  });

  const outcome = await shadow.cancel('production failed');

  assert.equal(candidateSignal?.aborted, true);
  assert.equal(outcome.status, 'interrupted');
  assert.equal(writes[0]?.payload?.productionStatus, 'failed');
  assert.equal(writes.length, 1);
});

test('Pi shadow skips non-read-only and unsupported requests before candidate execution', async () => {
  let runs = 0;
  const shadow = startPiKernelShadow({
    ...baseInput(),
    effectiveToolMode: 'project-write',
    config: { ...baseInput().config, contextCompression: { enabled: true } },
  }, {
    runCandidate: async () => { runs += 1; return { events: [] }; },
    appendEvent: async () => ({} as never),
  });

  const outcome = await shadow.settle(productionResult);
  assert.equal(runs, 0);
  assert.equal(outcome.status, 'skipped');
  assert.deepEqual(outcome.admissionIssues?.map(issue => issue.code), [
    'context_compression',
    'non_read_only_shadow',
  ]);
});

function baseInput(): Parameters<typeof startPiKernelShadow>[0] {
  return {
    shadow: { kind: 'pi', maxTurns: 3 },
    prompt: 'compare this',
    productionKernel: { kind: 'los', version: '0.1.0', protocolVersion: '0.1.0' },
    productionSessionId: 'session-main',
    productionTaskRunId: 'task-main',
    productionTraceId: 'trace-main',
    effectiveToolMode: 'read-only',
    remoteExecutor: false,
    config: {
      sessionId: 'session-main', taskRunId: 'task-main', traceId: 'trace-main',
      provider: 'fixture', model: 'fixture-model', toolMode: 'read-only', sandboxMode: 'readonly',
    },
  };
}

function event(type: KernelEvent['type']): KernelEvent {
  return {
    sequence: 0,
    type,
    occurredAt: '2026-07-22T00:00:00.000Z',
    kernel: { kind: 'pi', version: '0.81.1', protocolVersion: '0.1.0' },
    payload: {},
  };
}

function startedEvent(): KernelEvent {
  return {
    ...event('kernel.started'),
    payload: {
      sessionId: 'session-main:shadow:pi',
      taskRunId: 'task-main:shadow:pi',
      traceId: 'trace-main:shadow:pi',
    },
  };
}

function sequenceNow(...values: number[]): () => number {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)]!;
}
