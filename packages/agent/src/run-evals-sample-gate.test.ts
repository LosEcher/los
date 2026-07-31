import assert from 'node:assert/strict';
import test from 'node:test';
import { createExecutionExperiment, setExecutionExperimentCandidate } from './execution-experiments.js';
import { recordPairwiseRunEval } from './run-evals/pairwise.js';
import {
  cancelPairwiseSampleGate, evaluatePairwiseSampleGate, listPairwiseSampleGates,
  loadPairwiseSampleGate, registerPairwiseSampleGate, type SampleGateScenario,
} from './run-evals/sample-gate.js';

function rubricFor(suffix: string) {
  return {
    id: 'quality-rubric',
    revision: `revision-${suffix}`,
    criteria: [
      { id: 'correctness', label: 'Correctness', maxScore: 5 },
      { id: 'efficiency', label: 'Efficiency', maxScore: 3 },
    ],
  };
}

function uniqueSuffix(): string {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function createRealPair(suffix: string, index: number, scenarioId: string) {
  const experimentId = `gate-experiment-${suffix}-${index}`;
  const baselineRunSpecId = `gate-baseline-${suffix}-${index}`;
  const candidateRunSpecId = `gate-candidate-${suffix}-${index}`;
  const rubric = rubricFor(suffix);
  await createExecutionExperiment({
    id: experimentId,
    source: { sessionId: `gate-session-${suffix}`, runSpecId: baselineRunSpecId, eventCursor: index, evidenceHash: `sha256:${suffix}-${index}` },
    configDiff: [{ path: 'model', value: 'candidate-model' }],
    createdBy: 'operator:test',
  });
  await setExecutionExperimentCandidate(experimentId, candidateRunSpecId);
  return recordPairwiseRunEval({
    pairId: `gate-pair-${suffix}-${index}`,
    experimentId,
    baselineRunSpecId,
    candidateRunSpecId,
    rubricRevision: rubric.revision,
    rubricSnapshot: rubric,
    verdict: 'candidate',
    deterministic: { source: 'verification-records', verificationStatus: 'succeeded' },
    summary: { scenarioId },
  });
}

function registrationInput(suffix: string, overrides: Partial<{ minimumPairs: number; scenarios: SampleGateScenario[] }> = {}) {
  return {
    id: `gate-${suffix}`,
    tenantId: 'tenant-test',
    projectId: 'project-test',
    minimumPairs: overrides.minimumPairs ?? 2,
    scenarios: overrides.scenarios ?? [
      { id: 'scenario-a', label: 'Scenario A', requiredPairs: 1 },
      { id: 'scenario-b', label: 'Scenario B', requiredPairs: 1 },
    ],
    baselineRef: { experimentId: `gate-experiment-${suffix}-1`, runSpecId: `gate-baseline-${suffix}-1` },
    candidateRef: { experimentId: `gate-experiment-${suffix}-1`, runSpecId: `gate-candidate-${suffix}-1` },
    rubricRef: { id: 'quality-rubric', revision: `revision-${suffix}` },
    registeredBy: 'operator:test',
  };
}

test('sample gate stays blocked until real pairwise samples cover threshold and scenarios', async () => {
  const suffix = uniqueSuffix();
  const registration = await registerPairwiseSampleGate(registrationInput(suffix));
  assert.equal(registration.status, 'registered');
  assert.equal(registration.minimumPairs, 2);

  const before = await evaluatePairwiseSampleGate(registration.id, { tenantId: 'tenant-test', projectId: 'project-test' });
  assert.equal(before.passed, false);
  assert.equal(before.optimizationAnalysisEligible, false);
  assert.equal(before.collectedPairs, 0);

  await createRealPair(suffix, 1, 'scenario-a');
  const partial = await evaluatePairwiseSampleGate(registration.id, { tenantId: 'tenant-test', projectId: 'project-test' });
  assert.equal(partial.passed, false);
  assert.equal(partial.scenarioCoverage.find(item => item.scenarioId === 'scenario-b')!.covered, false);

  await createRealPair(suffix, 2, 'scenario-b');
  const passed = await evaluatePairwiseSampleGate(registration.id, { tenantId: 'tenant-test', projectId: 'project-test' });
  assert.equal(passed.passed, true);
  assert.equal(passed.optimizationAnalysisEligible, true);
  assert.equal(passed.collectedPairs, 2);
  assert.equal(passed.status, 'passed');
  assert.equal(passed.scenarioCoverage.every(item => item.covered), true);
  assert.ok(passed.effectiveRoutes.length >= 1);

  const persisted = await loadPairwiseSampleGate(registration.id, { tenantId: 'tenant-test', projectId: 'project-test' });
  assert.equal(persisted!.status, 'passed');
  assert.ok(persisted!.passedAt);
});

test('sample gate ignores pairs without any evidence channel', async () => {
  const suffix = uniqueSuffix();
  const registration = await registerPairwiseSampleGate({
    ...registrationInput(suffix),
    minimumPairs: 2,
    scenarios: [{ id: 'scenario-a', label: 'Scenario A', requiredPairs: 1 }],
  });
  const experimentId = `gate-empty-${suffix}`;
  const baselineRunSpecId = `gate-empty-baseline-${suffix}`;
  const candidateRunSpecId = `gate-empty-candidate-${suffix}`;
  const rubric = rubricFor(suffix);
  await createExecutionExperiment({
    id: experimentId,
    source: { sessionId: `gate-empty-session-${suffix}`, runSpecId: baselineRunSpecId, eventCursor: 1, evidenceHash: `sha256:${suffix}` },
    configDiff: [{ path: 'model', value: 'candidate-model' }],
    createdBy: 'operator:test',
  });
  await setExecutionExperimentCandidate(experimentId, candidateRunSpecId);
  await recordPairwiseRunEval({
    pairId: `gate-empty-pair-${suffix}`,
    experimentId,
    baselineRunSpecId,
    candidateRunSpecId,
    rubricRevision: rubric.revision,
    rubricSnapshot: rubric,
    verdict: 'candidate',
    summary: { scenarioId: 'scenario-a' },
  });
  await createRealPair(suffix, 1, 'scenario-a');

  const evaluation = await evaluatePairwiseSampleGate(registration.id, { tenantId: 'tenant-test', projectId: 'project-test' });
  assert.equal(evaluation.collectedPairs, 1);
  assert.equal(evaluation.passed, false);
});

test('sample gate registration rejects invalid thresholds and duplicate scenarios', async () => {
  const suffix = uniqueSuffix();
  await assert.rejects(
    registerPairwiseSampleGate({ ...registrationInput(suffix), minimumPairs: 0 }),
    /contract validation failed|must be >= 1|positive integer/,
  );
  await assert.rejects(
    registerPairwiseSampleGate({
      ...registrationInput(suffix),
      scenarios: [
        { id: 'scenario-a', label: 'A', requiredPairs: 1 },
        { id: 'scenario-a', label: 'A duplicate', requiredPairs: 1 },
      ],
    }),
    /scenario ids must be unique/,
  );
});

test('cancel records actor and rejects cancelling a passed gate', async () => {
  const suffix = uniqueSuffix();
  const registration = await registerPairwiseSampleGate(registrationInput(suffix));
  await createRealPair(suffix, 1, 'scenario-a');
  await createRealPair(suffix, 2, 'scenario-b');
  await evaluatePairwiseSampleGate(registration.id, { tenantId: 'tenant-test', projectId: 'project-test' });
  await assert.rejects(
    cancelPairwiseSampleGate(registration.id, { tenantId: 'tenant-test', projectId: 'project-test' }, 'operator:cancel'),
    /already passed/,
  );

  const cancellable = await registerPairwiseSampleGate(registrationInput(`${suffix}-cancellable`));
  const cancelled = await cancelPairwiseSampleGate(
    cancellable.id,
    { tenantId: 'tenant-test', projectId: 'project-test' },
    'operator:cancel',
  );
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.cancelledBy, 'operator:cancel');
  assert.ok(cancelled.cancelledAt);

  const gates = await listPairwiseSampleGates({ tenantId: 'tenant-test', projectId: 'project-test' }, 'cancelled');
  assert.ok(gates.some(gate => gate.id === cancellable.id));
});
