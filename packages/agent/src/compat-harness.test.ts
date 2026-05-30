import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createCompatibilityRunSpecs,
  parseCompatibilityTargets,
  selectCompatibilityProbes,
  summarizeCompatibilityEvents,
} from './compat-harness.js';

test('compatibility harness creates provider-model probe specs', () => {
  const targets = parseCompatibilityTargets(['deepseek:deepseek-reasoner', 'openai:gpt-4o']);
  const probes = selectCompatibilityProbes(['read-context']);
  const specs = createCompatibilityRunSpecs({
    targets,
    probes,
    workspaceRoot: '/tmp/workspace',
    tracePrefix: 'trace',
    maxLoops: 3,
  });

  assert.equal(specs.length, 2);
  assert.equal(specs[0].id, 'deepseek:deepseek-reasoner/read-context');
  assert.equal(specs[0].request.provider, 'deepseek');
  assert.equal(specs[0].request.model, 'deepseek-reasoner');
  assert.equal(specs[0].request.toolMode, 'read-only');
  assert.equal(specs[0].request.maxLoops, 3);
  assert.equal(specs[0].request.workspaceRoot, '/tmp/workspace');
  assert.equal(specs[0].request.traceId, 'trace:deepseek:deepseek-reasoner/read-context');
});

test('compatibility harness summarizes SSE evidence', () => {
  const [spec] = createCompatibilityRunSpecs({
    targets: parseCompatibilityTargets(['deepseek:deepseek-reasoner']),
    probes: selectCompatibilityProbes(['read-context']),
  });
  const summary = summarizeCompatibilityEvents(spec, [
    {
      event: 'session.started',
      data: {
        sessionId: 'session-1',
        payload: {
          effectiveModel: 'deepseek-reasoner',
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
      data: { taskRunId: 'task-1' },
    },
  ]);

  assert.equal(summary.provider, 'deepseek');
  assert.equal(summary.model, 'deepseek-reasoner');
  assert.equal(summary.effectiveModel, 'deepseek-reasoner');
  assert.equal(summary.protocol, 'openai');
  assert.equal(summary.reasoningSupported, true);
  assert.equal(summary.reasoningObserved, true);
  assert.deepEqual(summary.toolCalls, ['read_file']);
  assert.equal(summary.toolResultCount, 1);
  assert.equal(summary.totalTokens, 42);
  assert.equal(summary.completed, true);
});
