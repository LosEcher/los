import test from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig } from '@los/infra/config';
import { closeDb, getDb, initDb } from '@los/infra/db';

import { createRunSpec } from './run-specs.js';
import { recordRunEval } from './run-evals.js';
import {
  getDailyAgentScenarioCorpus,
  recordDailyAgentScenarioEconomics,
  summarizeDailyAgentScenarioEconomics,
  type DailyAgentScenarioDefinition,
  type DailyAgentScenarioLane,
  type DailyAgentScenarioRole,
  type RecordDailyAgentScenarioEconomicsInput,
} from './scenario-economics.js';

const DAILY_AGENT_SCENARIO_CORPUS = getDailyAgentScenarioCorpus();

test('daily-agent scenario corpus fixes the five P0 paths and required roles', () => {
  const corpus = getDailyAgentScenarioCorpus();
  assert.equal(corpus.version, '2026-07-21.v3');
  assert.deepEqual(corpus.scenarios.map(scenario => scenario.id), [
    'DA01-work-first-intake',
    'DA02-approval-resume',
    'DA03-verification-block',
    'DA04-revision-recovery',
    'DA05-interrupted-resume',
  ]);
  for (const scenario of corpus.scenarios) {
    assert.deepEqual(scenario.requiredRoles, ['planner', 'worker', 'reviewer']);
    assert.ok(scenario.acceptanceCriteria.length >= 3);
  }
});

test('daily-agent scenario records reject implicit candidate routing and incomplete assertions', async () => {
  const scenario = DAILY_AGENT_SCENARIO_CORPUS.scenarios[0]!;
  await assert.rejects(
    recordDailyAgentScenarioEconomics(makeInput({
      scenario,
      scenarioRunId: 'candidate-implicit',
      lane: 'candidate',
      role: 'planner',
      routeReason: 'configured_default',
    })),
    /candidate scenario records require explicit_provider or explicit_model/,
  );
  await assert.rejects(
    recordDailyAgentScenarioEconomics({
      ...makeInput({ scenario, scenarioRunId: 'missing-assertion', lane: 'baseline', role: 'planner' }),
      hardAssertions: [{ id: scenario.acceptanceCriteria[0]!, passed: true }],
    }),
    /missing hard assertions/,
  );
});

test('scenario economics reports cost by scenario and role without enabling automatic routing', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const runSpecId = `daily-scenario-economics-${suffix}`;

  try {
    await createRunSpec({
      id: runSpecId,
      sessionId: `session-${runSpecId}`,
      prompt: 'daily-agent scenario economics fixture',
      workspaceRoot: '/tmp/workspace',
      toolMode: 'project-write',
    });

    for (const scenario of DAILY_AGENT_SCENARIO_CORPUS.scenarios) {
      for (const lane of ['baseline', 'candidate'] as const) {
        for (let attempt = 1; attempt <= 3; attempt++) {
          const scenarioRunId = `${runSpecId}-${lane}-${scenario.id}-${attempt}`;
          for (const role of ['planner', 'worker', 'reviewer'] as const) {
            const recorded = await recordDailyAgentScenarioEconomics(makeInput({
              runSpecId,
              scenario,
              scenarioRunId,
              lane,
              role,
              routeReason: lane === 'baseline' ? 'configured_default' : 'explicit_model',
              modelCost: lane === 'baseline' ? 0.01 : 0.02,
            }));
            assert.equal(recorded.provider, 'deepseek');
            assert.equal(recorded.model, lane === 'baseline' ? 'deepseek-v4-flash' : 'deepseek-v4-pro');
            assert.equal(recorded.summary.requestedModel, lane === 'baseline' ? null : 'deepseek-v4-pro');
            assert.equal(recorded.summary.effectiveModel, lane === 'baseline' ? 'deepseek-v4-flash' : 'deepseek-v4-pro');
          }
        }
      }
    }

    await recordRunEval({
      id: `${runSpecId}-malformed`,
      runSpecId,
      success: true,
      summary: {
        kind: 'daily_agent_scenario_economics',
        corpusVersion: DAILY_AGENT_SCENARIO_CORPUS.version,
        scenarioId: 'unknown',
      },
    });

    const report = await summarizeDailyAgentScenarioEconomics({ runSpecId });
    assert.equal(report.evidence.status, 'ready_for_policy_review');
    assert.equal(report.evidence.acceptedRecordCount, 90);
    assert.equal(report.evidence.rejectedRecordCount, 1);
    assert.equal(report.evidence.scenarioRunCount, 30);
    assert.equal(report.evidence.completedScenarioRunCount, 30);
    assert.deepEqual(report.evidence.missingCells, []);
    assert.equal(report.automaticRouting.status, 'disabled');
    assert.equal(report.totals.runCount, 30);
    assert.equal(report.totals.completedRunCount, 30);
    assert.ok(Math.abs(report.totals.modelCost - 1.35) < 0.000001);
    assert.equal(report.totals.promptTokens, 9000);
    assert.equal(report.totals.completionTokens, 4500);
    assert.equal(report.totals.planningAttemptCount, 30);
    assert.equal(report.totals.executionAttemptCount, 30);
    assert.equal(report.totals.diffAcceptedCount, 30);
    assert.equal(report.totals.recoveredRunCount, 6);
    assert.equal(report.byScenario.length, 5);
    assert.ok(report.byScenario.every(group => group.runCount === 6 && group.completedRunCount === 6));
    assert.equal(report.byRole.length, 3);
    assert.ok(report.byRole.every(group => group.recordCount === 30 && group.successCount === 30));
    assert.deepEqual(report.byLane.map(group => [group.lane, group.runCount]), [['baseline', 15], ['candidate', 15]]);
    assert.equal(report.byRoute.length, 6);
    assert.ok(report.byRoute.some(group => group.lane === 'baseline'
      && group.requestedModel === null
      && group.effectiveModel === 'deepseek-v4-flash'));
    assert.ok(report.byRoute.some(group => group.lane === 'candidate'
      && group.requestedModel === 'deepseek-v4-pro'
      && group.effectiveModel === 'deepseek-v4-pro'
      && group.routeReason === 'explicit_model'));
  } finally {
    await getDb().query('DELETE FROM run_evals WHERE run_spec_id = $1', [runSpecId]).catch(() => undefined);
    await getDb().query('DELETE FROM run_specs WHERE id = $1', [runSpecId]).catch(() => undefined);
    await closeDb().catch(() => undefined);
  }
});

function makeInput(input: {
  scenario: DailyAgentScenarioDefinition;
  scenarioRunId: string;
  lane: DailyAgentScenarioLane;
  role: DailyAgentScenarioRole;
  runSpecId?: string;
  routeReason?: RecordDailyAgentScenarioEconomicsInput['routeReason'];
  modelCost?: number;
}): RecordDailyAgentScenarioEconomicsInput {
  const candidate = input.lane === 'candidate';
  return {
    runSpecId: input.runSpecId ?? 'not-written-validation-fixture',
    scenarioId: input.scenario.id,
    scenarioVersion: input.scenario.version,
    scenarioRunId: input.scenarioRunId,
    lane: input.lane,
    role: input.role,
    requestedProvider: candidate ? 'deepseek' : null,
    requestedModel: candidate ? 'deepseek-v4-pro' : null,
    effectiveProvider: 'deepseek',
    effectiveModel: candidate ? 'deepseek-v4-pro' : 'deepseek-v4-flash',
    routeReason: input.routeReason ?? (candidate ? 'explicit_model' : 'configured_default'),
    success: true,
    latencyMs: 1000,
    retryCount: 0,
    toolErrorCount: 0,
    verificationStatus: input.role === 'reviewer' ? 'succeeded' : 'not_required',
    modelCost: input.modelCost ?? 0.01,
    promptTokens: 100,
    completionTokens: 50,
    operatorInterventionCount: 0,
    operatorWaitMs: 0,
    planningAttemptCount: input.role === 'planner' ? 1 : 0,
    executionAttemptCount: input.role === 'worker' ? 1 : 0,
    revisionCount: 0,
    diffOutcome: input.role === 'reviewer' ? 'accepted' : 'not_reviewed',
    recoveryResult: input.scenario.id === 'DA05-interrupted-resume' ? 'resumed' : 'not_required',
    hardAssertions: input.scenario.acceptanceCriteria.map(id => ({ id, passed: true })),
  };
}
