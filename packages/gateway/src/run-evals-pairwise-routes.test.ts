import assert from 'node:assert/strict';
import test from 'node:test';
import type { RunEvalRecord } from '@los/agent';
import { loadConfig } from '@los/infra/config';
import Fastify from 'fastify';
import { registerRequestContext } from './request-context.js';
import { registerProviderEvidenceRoutes } from './routes/providers/provider-evidence-routes.js';

test('pairwise run eval route records and returns separated rubric evidence', async () => {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const experimentId = `experiment-pairwise-route-${suffix}`;
  const baselineRunSpecId = `baseline-route-${suffix}`;
  const candidateRunSpecId = `candidate-route-${suffix}`;
  const pairId = `pair-route-${suffix}`;
  const records: RunEvalRecord[] = [];
  const app = Fastify({ logger: false });
  registerRequestContext(app, await loadConfig());
  registerProviderEvidenceRoutes(app, {
    async recordPairwiseRunEval(input) {
      if (input.rubricSnapshot.revision !== input.rubricRevision) {
        throw new Error('rubricSnapshot.revision must equal rubricRevision');
      }
      const now = new Date().toISOString();
      const record: RunEvalRecord = {
        id: input.id ?? `eval-${input.pairId}`,
        runSpecId: input.runSpecId ?? input.candidateRunSpecId,
        sessionId: input.sessionId,
        taskRunId: input.taskRunId,
        provider: input.provider,
        model: input.model,
        success: input.success ?? false,
        latencyMs: input.latencyMs,
        retryCount: input.retryCount ?? 0,
        toolErrorCount: input.toolErrorCount ?? 0,
        verificationStatus: input.verificationStatus === 'succeeded' ? 'succeeded' : 'unknown',
        modelCost: input.modelCost,
        evaluationKind: 'pairwise',
        pairId: input.pairId,
        experimentId: input.experimentId,
        baselineRunSpecId: input.baselineRunSpecId,
        candidateRunSpecId: input.candidateRunSpecId,
        rubricRevision: input.rubricRevision,
        rubricSnapshot: input.rubricSnapshot,
        human: input.human,
        judge: input.judge,
        deterministic: input.deterministic,
        pairwiseVerdict: input.verdict,
        summary: input.summary ?? {},
        createdAt: now,
        updatedAt: now,
      };
      records.push(record);
      return record;
    },
    async listPairwiseRunEvals(input) {
      const query = typeof input === 'string' ? { pairId: input } : input;
      return records.filter(record => (
        (!query.pairId || record.pairId === query.pairId)
        && (!query.experimentId || record.experimentId === query.experimentId)
        && (!query.verdict || record.pairwiseVerdict === query.verdict)
      ));
    },
  });

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
    await app.close();
  }
});
