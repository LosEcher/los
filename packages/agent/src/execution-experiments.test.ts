import assert from 'node:assert/strict';
import test from 'node:test';
import { getDb } from '@los/infra/db';
import {
  approveExecutionExperiment,
  createExecutionExperiment,
  ensureExecutionExperimentStore,
  loadExecutionExperiment,
  setExecutionExperimentCandidate,
  transitionExecutionExperiment,
} from './execution-experiments.js';

function id(prefix: string): string { return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`; }

test('execution experiment persists immutable source evidence and enumerable config diff', async () => {
  await ensureExecutionExperimentStore();
  const experimentId = id('experiment-provenance');
  const source = { sessionId: id('session'), runSpecId: id('run'), eventCursor: 42, evidenceHash: 'sha256:evidence', fingerprint: { prompt: 'p1', spec: 's1' } };
  const record = await createExecutionExperiment({
    id: experimentId, tenantId: 'tenant-test', projectId: 'los', source,
    configDiff: [{ path: 'model', value: 'candidate-model' }, { path: 'maxLoops', value: 8, inherited: false }],
    createdBy: 'operator:test',
  });
  assert.equal(record.status, 'draft');
  assert.deepEqual(record.source, source);
  assert.deepEqual(record.configDiff[0], { path: 'model', value: 'candidate-model' });
  const loaded = await loadExecutionExperiment(experimentId);
  assert.deepEqual(loaded, record);
  await getDb().query('DELETE FROM execution_experiments WHERE id = $1', [experimentId]);
});

test('approval is explicit and AP3 blocks experiment success without a verified candidate run', async () => {
  const experimentId = id('experiment-gate');
  const candidateRunSpecId = id('candidate');
  await createExecutionExperiment({
    id: experimentId,
    source: { sessionId: id('session'), runSpecId: id('source-run'), eventCursor: 1, evidenceHash: 'sha256:gate' },
    configDiff: [], createdBy: 'operator:test',
  });
  const approved = await approveExecutionExperiment(experimentId, 'operator:test');
  assert.equal(approved.status, 'approved');
  assert.equal(approved.approvedBy, 'operator:test');
  await setExecutionExperimentCandidate(experimentId, candidateRunSpecId);
  await transitionExecutionExperiment(experimentId, 'running', 'harness_start');
  await assert.rejects(
    transitionExecutionExperiment(experimentId, 'succeeded', 'harness_success_without_candidate'),
    /candidate run spec is not succeeded|has no candidate run spec/,
  );
  const blocked = await loadExecutionExperiment(experimentId);
  assert.equal(blocked?.status, 'running');
  await getDb().query('DELETE FROM execution_experiments WHERE id = $1', [experimentId]);
});
