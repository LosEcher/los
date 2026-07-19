import assert from 'node:assert/strict';
import test from 'node:test';
import { createExecutionExperiment, setExecutionExperimentCandidate } from '@los/agent';
import { loadConfig } from '@los/infra/config';
import { closeDb, getDb, initDb } from '@los/infra/db';
import { createServer } from './server.js';

test('pairwise run eval route records and returns separated rubric evidence', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const experimentId = `experiment-pairwise-route-${suffix}`;
  const baselineRunSpecId = `baseline-route-${suffix}`;
  const candidateRunSpecId = `candidate-route-${suffix}`;
  const pairId = `pair-route-${suffix}`;
  const app = await createServer({
    serviceId: `gateway-pairwise-route-test-${suffix}`,
    bindUrl: 'http://127.0.0.1:0',
    publicUrl: 'http://127.0.0.1:0',
    hostLabel: 'test',
  });

  await createExecutionExperiment({
    id: experimentId,
    source: {
      sessionId: `session-route-${suffix}`,
      runSpecId: baselineRunSpecId,
      eventCursor: 3,
      evidenceHash: `sha256:${suffix}`,
    },
    configDiff: [{ path: 'maxLoops', value: 4 }],
    createdBy: 'operator:test',
  });
  await setExecutionExperimentCandidate(experimentId, candidateRunSpecId);

  try {
    const response = await app.inject({
      method: 'POST',
      url: '/run-evals/pairwise',
      payload: {
        pairId,
        experimentId,
        baselineRunSpecId,
        candidateRunSpecId,
        rubricRevision: 'route-r1',
        rubricSnapshot: {
          id: 'route-rubric',
          revision: 'route-r1',
          criteria: [{ id: 'correctness', label: 'Correctness', maxScore: 5 }],
        },
        verdict: 'candidate',
        human: {
          source: 'operator:test',
          verdict: 'candidate',
          criterionScores: [{ criterionId: 'correctness', score: 5 }],
        },
        deterministic: {
          source: 'verification-records',
          verificationStatus: 'succeeded',
        },
        metrics: {
          success: true,
          latencyMs: 900,
          retryCount: 0,
          toolErrorCount: 0,
          verificationStatus: 'succeeded',
        },
      },
    });
    assert.equal(response.statusCode, 201, response.body);
    assert.equal(response.json().eval.pairwiseVerdict, 'candidate');
    assert.equal(response.json().eval.human.source, 'operator:test');
    assert.equal(response.json().eval.deterministic.verificationStatus, 'succeeded');

    const fetched = await app.inject({ method: 'GET', url: `/run-evals/pairwise/${pairId}` });
    assert.equal(fetched.statusCode, 200);
    assert.equal(fetched.json().count, 1);
    assert.equal(fetched.json().evals[0].rubricSnapshot.revision, 'route-r1');

    const filtered = await app.inject({ method: 'GET', url: `/run-evals/pairwise?experimentId=${experimentId}&verdict=candidate` });
    assert.equal(filtered.statusCode, 200);
    assert.equal(filtered.json().count, 1);
    assert.equal(filtered.json().evals[0].pairwiseVerdict, 'candidate');

    const invalid = await app.inject({
      method: 'POST',
      url: '/run-evals/pairwise',
      payload: {
        experimentId,
        baselineRunSpecId,
        candidateRunSpecId,
        rubricRevision: 'route-r2',
        rubricSnapshot: { id: 'route-rubric', revision: 'route-r1', criteria: [] },
        verdict: 'tie',
      },
    });
    assert.equal(invalid.statusCode, 422);
    assert.match(invalid.json().error, /revision/);
  } finally {
    await getDb().query('DELETE FROM run_evals WHERE experiment_id = $1', [experimentId]).catch(() => undefined);
    await getDb().query('DELETE FROM execution_experiments WHERE id = $1', [experimentId]).catch(() => undefined);
    await app.close();
    await closeDb().catch(() => undefined);
  }
});
