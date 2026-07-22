import test from 'node:test';
import assert from 'node:assert/strict';

import { createRunSpec } from '@los/agent';
import { loadConfig } from '@los/infra/config';
import { closeDb, getDb, initDb } from '@los/infra/db';

import { createServer } from './server.js';

test('scenario economics routes expose the corpus and persist role evidence with routing disabled', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const runSpecId = `scenario-economics-route-${suffix}`;
  const scenarioRunId = `${runSpecId}-baseline-1`;
  const app = await createServer({
    serviceId: `gateway-scenario-economics-${suffix}`,
    bindUrl: 'http://127.0.0.1:0',
    publicUrl: 'http://127.0.0.1:0',
    hostLabel: 'test',
  });
  const headers: Record<string, string> = {
    'x-tenant-id': 'local',
    'x-project-id': 'los',
    'x-user-id': 'scenario-economics-test',
  };
  if (config.auth.operatorToken) headers['x-los-operator-token'] = config.auth.operatorToken;

  try {
    await createRunSpec({
      id: runSpecId,
      sessionId: `session-${runSpecId}`,
      prompt: 'scenario economics route fixture',
      workspaceRoot: process.cwd(),
      toolMode: 'project-write',
    });

    const corpus = await app.inject({ method: 'GET', url: '/run-evals/scenario-economics/corpus', headers });
    assert.equal(corpus.statusCode, 200);
    assert.equal(corpus.json().version, '2026-07-21.v3');
    assert.equal(corpus.json().scenarios.length, 5);
    const scenarioVersion = corpus.json().scenarios[0].version as string;

    for (const role of ['planner', 'worker', 'reviewer']) {
      const response = await app.inject({
        method: 'POST',
        url: '/run-evals/scenario-economics',
        headers,
        payload: rolePayload({ runSpecId, scenarioRunId, role, scenarioVersion }),
      });
      assert.equal(response.statusCode, 201, response.body);
      assert.equal(response.json().eval.summary.requestedModel, null);
      assert.equal(response.json().eval.summary.effectiveModel, 'deepseek-v4-flash');
    }

    const invalidCandidate = await app.inject({
      method: 'POST',
      url: '/run-evals/scenario-economics',
      headers,
      payload: {
        ...rolePayload({ runSpecId, scenarioRunId: `${runSpecId}-candidate-invalid`, role: 'planner', scenarioVersion }),
        lane: 'candidate',
        routeReason: 'configured_default',
      },
    });
    assert.equal(invalidCandidate.statusCode, 422);
    assert.match(invalidCandidate.json().error, /candidate scenario records require explicit_provider or explicit_model/);

    const report = await app.inject({
      method: 'GET',
      url: `/run-evals/scenario-economics?runSpecId=${encodeURIComponent(runSpecId)}`,
      headers,
    });
    assert.equal(report.statusCode, 200, report.body);
    const body = report.json();
    assert.equal(body.evidence.status, 'collecting');
    assert.equal(body.evidence.acceptedRecordCount, 3);
    assert.equal(body.evidence.scenarioRunCount, 1);
    assert.equal(body.evidence.completedScenarioRunCount, 1);
    assert.equal(body.automaticRouting.status, 'disabled');
    assert.equal(body.byScenario.find((group: { scenarioId: string }) => group.scenarioId === 'DA01-work-first-intake').modelCost, 0.03);
    assert.deepEqual(body.byRole.map((group: { role: string; recordCount: number }) => [group.role, group.recordCount]), [
      ['planner', 1], ['worker', 1], ['reviewer', 1],
    ]);
  } finally {
    await getDb().query('DELETE FROM run_evals WHERE run_spec_id=$1', [runSpecId]).catch(() => undefined);
    await getDb().query('DELETE FROM run_specs WHERE id=$1', [runSpecId]).catch(() => undefined);
    await app.close().catch(() => undefined);
    await closeDb().catch(() => undefined);
  }
});

function rolePayload(input: { runSpecId: string; scenarioRunId: string; role: string; scenarioVersion: string }) {
  return {
    runSpecId: input.runSpecId,
    scenarioId: 'DA01-work-first-intake',
    scenarioVersion: input.scenarioVersion,
    scenarioRunId: input.scenarioRunId,
    lane: 'baseline',
    role: input.role,
    requestedProvider: null,
    requestedModel: null,
    effectiveProvider: 'deepseek',
    effectiveModel: 'deepseek-v4-flash',
    routeReason: 'configured_default',
    success: true,
    latencyMs: 1000,
    retryCount: 0,
    toolErrorCount: 0,
    verificationStatus: input.role === 'reviewer' ? 'succeeded' : 'not_required',
    modelCost: 0.01,
    promptTokens: 100,
    completionTokens: 50,
    operatorInterventionCount: 0,
    hardAssertions: [
      { id: 'work_item_created', passed: true },
      { id: 'plan_persisted_before_approval', passed: true },
      { id: 'editable_scope_preserved', passed: true },
    ],
  };
}
