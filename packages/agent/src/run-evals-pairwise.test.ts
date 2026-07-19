import assert from 'node:assert/strict';
import test from 'node:test';
import { getDb } from '@los/infra/db';
import { createExecutionExperiment, setExecutionExperimentCandidate } from './execution-experiments.js';
import { listPairwiseRunEvals, recordPairwiseRunEval } from './run-evals/pairwise.js';

test('pairwise run eval preserves immutable rubric and separated evidence channels', async () => {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const experimentId = `experiment-pairwise-${suffix}`;
  const baselineRunSpecId = `baseline-${suffix}`;
  const candidateRunSpecId = `candidate-${suffix}`;
  const pairId = `pair-${suffix}`;
  const rubricSnapshot = {
    id: 'quality-rubric',
    revision: 'revision-1',
    criteria: [
      { id: 'correctness', label: 'Correctness', maxScore: 5 },
      { id: 'efficiency', label: 'Efficiency', maxScore: 3 },
    ],
  };

  await createExecutionExperiment({
    id: experimentId,
    source: {
      sessionId: `session-${suffix}`,
      runSpecId: baselineRunSpecId,
      eventCursor: 12,
      evidenceHash: `sha256:${suffix}`,
    },
    configDiff: [{ path: 'model', value: 'candidate-model' }],
    createdBy: 'operator:test',
  });
  await setExecutionExperimentCandidate(experimentId, candidateRunSpecId);

  try {
    const record = await recordPairwiseRunEval({
      id: `eval-${pairId}`,
      pairId,
      experimentId,
      baselineRunSpecId,
      candidateRunSpecId,
      rubricRevision: 'revision-1',
      rubricSnapshot,
      verdict: 'candidate',
      human: {
        source: 'operator:test',
        verdict: 'candidate',
        criterionScores: [{ criterionId: 'correctness', score: 5 }],
      },
      judge: {
        source: 'judge:model-a',
        verdict: 'candidate',
        confidence: 0.8,
        criterionScores: [{ criterionId: 'correctness', score: 4 }],
      },
      deterministic: {
        source: 'verification-records',
        verificationStatus: 'succeeded',
        criterionScores: [{ criterionId: 'efficiency', score: 3 }],
      },
      success: true,
      latencyMs: 1200,
      retryCount: 1,
      verificationStatus: 'succeeded',
    });

    assert.equal(record.evaluationKind, 'pairwise');
    assert.equal(record.pairId, pairId);
    assert.equal(record.rubricSnapshot?.revision, 'revision-1');
    assert.equal(record.human?.source, 'operator:test');
    assert.equal(record.judge?.source, 'judge:model-a');
    assert.equal(record.deterministic?.verificationStatus, 'succeeded');
    assert.equal(record.summary.metricSource, 'execution_projection');

    const listed = await listPairwiseRunEvals(pairId);
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.candidateRunSpecId, candidateRunSpecId);

    await assert.rejects(
      recordPairwiseRunEval({
        id: `eval-${pairId}-replacement`,
        pairId: `${pairId}-replacement`,
        experimentId,
        baselineRunSpecId,
        candidateRunSpecId,
        rubricRevision: 'revision-1',
        rubricSnapshot,
        verdict: 'baseline',
      }),
      /already exists/,
    );

    const unchanged = await listPairwiseRunEvals(pairId);
    assert.equal(unchanged[0]?.pairwiseVerdict, 'candidate');
  } finally {
    await getDb().query('DELETE FROM run_evals WHERE experiment_id = $1', [experimentId]).catch(() => undefined);
    await getDb().query('DELETE FROM execution_experiments WHERE id = $1', [experimentId]).catch(() => undefined);
  }
});
