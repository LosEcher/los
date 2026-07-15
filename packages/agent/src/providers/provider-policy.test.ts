import test from 'node:test';
import assert from 'node:assert/strict';

import type { AgentTaskRecord } from '../agent-task-graph.js';
import { resolveAgentRunProviderModelSelection } from '../loop/provider-selection.js';
import { resolveGraphTaskProviderModelSelection } from '../scheduler/provider-selection.js';
import { resolveProviderModelPolicy } from './provider-policy.js';

test('provider policy prefers passing compatibility evidence in target order', () => {
  const selection = resolveProviderModelPolicy({
    targets: [
      { provider: 'provider-a', model: 'model-a' },
      { provider: 'provider-b', model: 'model-b' },
    ],
    evidence: [
      { id: 'evidence-b', provider: 'provider-b', model: 'model-b', passed: true },
    ],
    fallback: { provider: 'provider-c', model: 'model-c' },
    sources: {
      evidence: 'provider_compat_evidence',
      target: 'graph_task_target',
      explicit: 'task_metadata',
      fallback: 'scheduler_input',
    },
  });

  assert.equal(selection.provider, 'provider-b');
  assert.equal(selection.model, 'model-b');
  assert.equal(selection.source, 'provider_compat_evidence');
  assert.equal(selection.evidenceId, 'evidence-b');
  assert.deepEqual(selection.rejectedTargetLabels, ['provider-a:model-a']);
});

test('provider policy blocks required targets without passing evidence', () => {
  assert.throws(
    () => resolveProviderModelPolicy({
      targets: [{ provider: 'provider-a', model: 'model-a' }],
      evidence: [],
      requireProviderCompat: true,
      contextLabel: 'graph task task-a',
      sources: {
        evidence: 'provider_compat_evidence',
        target: 'graph_task_target',
        explicit: 'task_metadata',
        fallback: 'scheduler_input',
      },
    }),
    /graph task task-a requires passing provider compatibility evidence/,
  );
});

test('chat and scheduler resolve the same provider for the same task input', async () => {
  const provider = 'deepseek';
  const model = 'deepseek-v4-flash';
  const chat = resolveAgentRunProviderModelSelection({ provider, model });
  const task: AgentTaskRecord = {
    id: 'same-task',
    graphId: 'same-task-graph',
    role: 'executor',
    title: 'same task',
    status: 'running',
    priority: 100,
    maxAttempts: 1,
    metadata: {},
    createdAt: '2026-07-15T00:00:00.000Z',
    updatedAt: '2026-07-15T00:00:00.000Z',
  };
  const scheduler = await resolveGraphTaskProviderModelSelection(task, {
    graphId: task.graphId,
    provider,
    model,
  });

  assert.equal(chat.provider, scheduler.provider);
  assert.equal(chat.model, scheduler.model);
});

test('scheduler preserves input selection when task metadata only names a model', async () => {
  const task: AgentTaskRecord = {
    id: 'model-only-task',
    graphId: 'model-only-graph',
    role: 'executor',
    title: 'model-only task',
    status: 'running',
    priority: 100,
    maxAttempts: 1,
    metadata: { model: 'metadata-model' },
    createdAt: '2026-07-15T00:00:00.000Z',
    updatedAt: '2026-07-15T00:00:00.000Z',
  };
  const selection = await resolveGraphTaskProviderModelSelection(task, {
    graphId: task.graphId,
    provider: 'deepseek',
    model: 'deepseek-v4-flash',
  });

  assert.equal(selection.provider, 'deepseek');
  assert.equal(selection.model, 'deepseek-v4-flash');
  assert.equal(selection.source, 'scheduler_input');
});
