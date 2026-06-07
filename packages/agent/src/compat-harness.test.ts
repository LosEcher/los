import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ADVISORY_COMPATIBILITY_TARGETS,
  createCompatibilityRunSpecs,
  parseCompatibilityTargets,
  selectCompatibilityProbes,
  summarizeCompatibilityEvents,
} from './compat-harness.js';

test('compatibility harness defaults to required provider gates only', () => {
  const targets = parseCompatibilityTargets(undefined);

  assert.deepEqual(targets.map(item => item.label), ['deepseek:deepseek-v4-flash']);
  assert.ok(ADVISORY_COMPATIBILITY_TARGETS.some(item => item.label === 'codex:gpt-5.5'));
  assert.ok(ADVISORY_COMPATIBILITY_TARGETS.some(item => item.label === 'openai:gpt-5.5'));
});

test('compatibility harness creates provider-model probe specs', () => {
  const targets = parseCompatibilityTargets(['deepseek:deepseek-v4-pro', 'openai:gpt-5.5']);
  const probes = selectCompatibilityProbes(['read-context']);
  const specs = createCompatibilityRunSpecs({
    targets,
    probes,
    workspaceRoot: '/tmp/workspace',
    tracePrefix: 'trace',
    maxLoops: 3,
  });

  assert.equal(specs.length, 2);
  assert.equal(specs[0].id, 'deepseek:deepseek-v4-pro/read-context');
  assert.equal(specs[0].request.provider, 'deepseek');
  assert.equal(specs[0].request.model, 'deepseek-v4-pro');
  assert.equal(specs[0].request.toolMode, 'read-only');
  assert.equal(specs[0].request.maxLoops, 3);
  assert.equal(specs[0].request.workspaceRoot, '/tmp/workspace');
  assert.equal(specs[0].request.traceId, 'trace:deepseek:deepseek-v4-pro/read-context');
});

test('compatibility harness summarizes SSE evidence', () => {
  const [spec] = createCompatibilityRunSpecs({
    targets: parseCompatibilityTargets(['deepseek:deepseek-v4-pro']),
    probes: selectCompatibilityProbes(['read-context']),
  });
  const summary = summarizeCompatibilityEvents(spec, [
    {
      event: 'session.started',
      data: {
        sessionId: 'session-1',
        requestId: 'request-1',
        traceId: 'trace-1',
        nodeId: 'node-1',
        payload: {
          effectiveModel: 'deepseek-v4-pro',
          modelProfile: {
            protocol: 'openai',
            supportsReasoning: true,
          },
        },
      },
    },
    {
      event: 'model.response',
      data: {
        usage: { totalTokens: 42 },
        payload: { reasoningLength: 10 },
      },
    },
    {
      event: 'tool.call',
      data: { toolName: 'read_file' },
    },
    {
      event: 'tool.result',
      data: { payload: { ok: true } },
    },
    {
      event: 'done',
      data: {
        payload: { taskRunId: 'task-1' },
      },
    },
    {
      event: 'run_spec.succeeded',
      data: {
        payload: {
          entityId: 'run-1',
        },
      },
    },
  ]);

  assert.equal(summary.provider, 'deepseek');
  assert.equal(summary.model, 'deepseek-v4-pro');
  assert.equal(summary.effectiveModel, 'deepseek-v4-pro');
  assert.equal(summary.protocol, 'openai');
  assert.equal(summary.reasoningSupported, true);
  assert.equal(summary.reasoningObserved, true);
  assert.equal(summary.sessionId, 'session-1');
  assert.equal(summary.taskRunId, 'task-1');
  assert.equal(summary.runSpecId, 'run-1');
  assert.equal(summary.requestId, 'request-1');
  assert.equal(summary.traceId, 'trace-1');
  assert.equal(summary.nodeId, 'node-1');
  assert.deepEqual(summary.toolCalls, ['read_file']);
  assert.equal(summary.toolResultCount, 1);
  assert.equal(summary.totalTokens, 42);
  assert.equal(summary.completed, true);
  assert.equal(summary.passed, false);
  assert.deepEqual(summary.failures, ['missing expected tool(s): list_directory']);
});

test('compatibility harness marks complete expected-tool runs as passing', () => {
  const [spec] = createCompatibilityRunSpecs({
    targets: parseCompatibilityTargets(['deepseek:deepseek-v4-flash']),
    probes: selectCompatibilityProbes(['read-context']),
  });
  const summary = summarizeCompatibilityEvents(spec, [
    { event: 'session.started', data: { sessionId: 'session-1', payload: { effectiveModel: 'deepseek-v4-flash' } } },
    { event: 'tool.call', data: { toolName: 'list_directory' } },
    { event: 'tool.result', data: { payload: { ok: true } } },
    { event: 'tool.call', data: { toolName: 'read_file' } },
    { event: 'tool.result', data: { payload: { ok: true } } },
    { event: 'session.completed', data: { taskRunId: 'task-1' } },
  ]);

  assert.equal(summary.passed, true);
  assert.deepEqual(summary.failures, []);
});
