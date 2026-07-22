import test from 'node:test';
import assert from 'node:assert/strict';

import { getDailyAgentScenarioCorpus } from './scenario-economics.js';
import { DAILY_AGENT_SCENARIO_FIXTURES } from './scenario-economics-fixtures.js';
import {
  _buildRolePrompt,
  _evaluateScenarioArtifacts,
  _failedChecks,
  _parseRoleArtifact,
  _parseRunnerArgs,
} from './scenario-economics-runner.js';

test('daily scenario fixtures stay aligned with the versioned corpus', () => {
  const corpus = getDailyAgentScenarioCorpus();
  assert.deepEqual(
    DAILY_AGENT_SCENARIO_FIXTURES.map(fixture => [fixture.id, fixture.version]),
    corpus.scenarios.map(scenario => [scenario.id, scenario.version]),
  );
  for (const fixture of DAILY_AGENT_SCENARIO_FIXTURES) {
    const scenario = corpus.scenarios.find(item => item.id === fixture.id)!;
    assert.deepEqual(Object.keys(fixture.assertionChecks), scenario.acceptanceCriteria);
  }
});

test('runner parses bounded JSON and evaluates hard assertions outside model output', () => {
  const fixture = DAILY_AGENT_SCENARIO_FIXTURES[0]!;
  const artifacts = {
    planner: {
      scenarioId: fixture.id,
      role: 'planner',
      decision: 'create_work_item',
      workItemId: 'work-da01',
      sequence: ['persist_plan', 'request_approval'],
      editableSurfaces: ['packages/web/src/pages/work-page.tsx'],
    },
    worker: {
      scenarioId: fixture.id,
      role: 'worker',
      decision: 'wait_for_approval',
      writesStarted: false,
      editableSurfaces: ['packages/web/src/pages/work-page.tsx'],
    },
    reviewer: {
      scenarioId: fixture.id,
      role: 'reviewer',
      workItemCreated: true,
      planBeforeApproval: true,
      scopePreserved: true,
    },
  } as const;
  const parsed = _parseRoleArtifact(`\n\`\`\`json\n${JSON.stringify(artifacts.planner)}\n\`\`\`\n`);
  assert.deepEqual(parsed, artifacts.planner);
  assert.ok(_evaluateScenarioArtifacts(fixture, artifacts).every(assertion => assertion.passed));

  const invalid = { ...artifacts, worker: { ...artifacts.worker, writesStarted: true } };
  const assertions = _evaluateScenarioArtifacts(fixture, invalid);
  assert.equal(assertions.find(assertion => assertion.id === 'plan_persisted_before_approval')?.passed, false);

  const failures = _failedChecks(fixture, invalid);
  assert.deepEqual(failures, [{
    assertionId: 'plan_persisted_before_approval',
    role: 'worker',
    path: 'writesStarted',
    expected: false,
    actual: true,
  }]);
});

test('failed-check diagnostics mark missing values and bound large actual values', () => {
  const fixture = DAILY_AGENT_SCENARIO_FIXTURES[0]!;
  const failures = _failedChecks(fixture, {
    planner: {
      decision: 'x'.repeat(200),
      workItemId: 'work-da01',
    },
  });
  const decision = failures.find(item => item.path === 'decision');
  const sequence = failures.find(item => item.path === 'sequence');
  assert.equal(typeof decision?.actual, 'string');
  assert.equal((decision?.actual as string).length, 160);
  assert.equal(sequence?.actual, '<missing>');
});

test('runner requires explicit execution and builds prompts without storing raw responses', () => {
  const options = _parseRunnerArgs([
    '--runs-per-lane', '3',
    '--run-spec-id', 'daily-live-test',
    '--scenario', 'DA05-interrupted-resume',
    '--lane', 'candidate',
  ], 'unused-default');
  assert.equal(options.execute, false);
  assert.equal(options.runsPerLane, 3);
  assert.deepEqual(options.scenarioIds, ['DA05-interrupted-resume']);
  assert.deepEqual(options.lanes, ['candidate']);

  const prompt = JSON.parse(_buildRolePrompt(DAILY_AGENT_SCENARIO_FIXTURES[4]!, 'reviewer', {
    planner: { decision: 'resume_from_persisted_state' },
  }));
  assert.equal(prompt.scenario.id, 'DA05-interrupted-resume');
  assert.equal(prompt.role, 'reviewer');
  assert.deepEqual(prompt.priorRoleArtifacts.planner, { decision: 'resume_from_persisted_state' });
  assert.equal(prompt.requiredOutputSchema.additionalProperties, false);
  assert.equal('rawResponse' in prompt, false);
});
