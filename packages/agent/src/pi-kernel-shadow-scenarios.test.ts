import assert from 'node:assert/strict';
import test from 'node:test';
import {
  _PI_KERNEL_SHADOW_CORPUS_VERSION,
  _PI_KERNEL_SHADOW_RUBRIC_REVISION,
  _PI_KERNEL_SHADOW_SCENARIOS,
  evaluatePiKernelShadowScenario,
  _summarizePiKernelShadowScenarioEvidence,
} from './pi-kernel-shadow-scenarios.js';
import type { AgentResult } from './loop.js';

const productionResult: AgentResult = {
  text: 'LOS_PI_SHADOW_OK',
  turns: [], loopCount: 1,
  totalTokens: { prompt: 10, completion: 4 },
  messages: [],
};

test('Pi shadow corpus preregisters bounded read-only scenario requirements', () => {
  assert.deepEqual(_PI_KERNEL_SHADOW_SCENARIOS.map(item => item.id), [
    'PKS01-no-tool',
    'PKS02-read-only-tool',
    'PKS03-policy-denial',
    'PKS04-provider-failure',
    'PKS05-interruption',
  ]);
  assert.ok(_PI_KERNEL_SHADOW_SCENARIOS.every(item => item.version === '1.1.0'));
  assert.deepEqual(_PI_KERNEL_SHADOW_SCENARIOS[1]?.allowedTools, ['read_file']);
  assert.deepEqual(_PI_KERNEL_SHADOW_SCENARIOS[2]?.allowedEvidenceClasses, ['deterministic']);
});

test('Pi shadow scenario evaluation binds output, tool, terminal, and lineage assertions', () => {
  const noTool = evaluatePiKernelShadowScenario({
    ...baseEvidence(), scenarioId: 'PKS01-no-tool', evidenceClass: 'live-provider',
    candidateStatus: 'completed', candidateEventCounts: { 'kernel.finished': 1 },
    candidateToolNames: [], candidateToolCompletionStates: [],
    candidateOutputHash: 'sha256:same', productionOutputHash: 'sha256:same',
  });
  assert.equal(noTool.passed, true);

  const denied = evaluatePiKernelShadowScenario({
    ...baseEvidence('PKS03-policy-denial'), scenarioId: 'PKS03-policy-denial', evidenceClass: 'deterministic',
    candidateStatus: 'completed', candidateEventCounts: { 'kernel.finished': 1, 'tool.requested': 1 },
    candidateToolNames: ['read_file'], candidateToolCompletionStates: ['denied'],
  });
  assert.equal(denied.passed, true);

  const mismatched = evaluatePiKernelShadowScenario({
    ...baseEvidence(), scenarioId: 'PKS01-no-tool', evidenceClass: 'live-provider',
    candidateStatus: 'completed', candidateEventCounts: { 'kernel.finished': 1 },
    candidateToolNames: [], candidateToolCompletionStates: [],
    candidateOutputHash: 'sha256:candidate', productionOutputHash: 'sha256:production',
  });
  assert.equal(mismatched.passed, false);
  assert.equal(mismatched.assertions.find(item => item.id === 'output_hash_equal')?.passed, false);

  assert.throws(
    () => evaluatePiKernelShadowScenario({
      ...baseEvidence('PKS04-provider-failure'), scenarioId: 'PKS04-provider-failure', evidenceClass: 'live-provider',
      candidateStatus: 'failed', candidateEventCounts: { 'kernel.failed': 1 },
      candidateToolNames: [], candidateToolCompletionStates: [],
    }),
    /does not admit live-provider evidence/,
  );
});

test('Pi shadow read-only scenario compares typed task values without persisting raw output', () => {
  const compared = evaluatePiKernelShadowScenario({
    ...baseEvidence('PKS02-read-only-tool'), scenarioId: 'PKS02-read-only-tool', evidenceClass: 'live-provider',
    candidateStatus: 'completed', candidateEventCounts: { 'kernel.finished': 1 },
    candidateToolNames: ['read_file'], candidateToolCompletionStates: ['succeeded'],
    productionText: '{"packageName":"@los/agent"}',
    candidateText: '```json\n{"packageName":"@los/agent"}\n```',
  });
  assert.equal(compared.passed, true);
  assert.equal(compared.assertions.find(item => item.id === 'task_value_equal')?.passed, true);
  assert.equal(compared.resultComparison?.productionValueHash, compared.resultComparison?.candidateValueHash);
  assert.equal(JSON.stringify(compared).includes('@los/agent'), false);

  const wrongValue = evaluatePiKernelShadowScenario({
    ...baseEvidence('PKS02-read-only-tool'), scenarioId: 'PKS02-read-only-tool', evidenceClass: 'live-provider',
    candidateStatus: 'completed', candidateEventCounts: { 'kernel.finished': 1 },
    candidateToolNames: ['read_file'], candidateToolCompletionStates: ['succeeded'],
    productionText: '{"packageName":"@los/agent"}', candidateText: '{"packageName":"los"}',
  });
  assert.equal(wrongValue.passed, false);
  assert.equal(wrongValue.assertions.find(item => item.id === 'task_value_expected')?.passed, false);
});

test('Pi shadow report requires every preregistered cell for one exact Pi version', () => {
  const payloads: Record<string, unknown>[] = [];
  for (const scenario of _PI_KERNEL_SHADOW_SCENARIOS) {
    for (const [evidenceClass, required] of Object.entries(scenario.requiredObservations)) {
      for (let index = 0; index < (required ?? 0); index++) {
        payloads.push(payload(
          scenario.id,
          scenario.version,
          evidenceClass as 'deterministic' | 'live-provider',
          true,
        ));
      }
    }
  }
  payloads.push({ ...payload('PKS01-no-tool', '1.1.0', 'live-provider', true), candidate: { kind: 'pi', version: '0.82.0' } });

  const identity = { kind: 'pi' as const, version: '0.81.1+los.1', protocolVersion: '0.1.0' };
  const report = _summarizePiKernelShadowScenarioEvidence(payloads, identity);
  assert.equal(report.status, 'ready_for_k4_policy_review');
  assert.equal(report.observedCount, 17);
  assert.equal(report.ignoredCount, 1);
  assert.equal(report.automaticAdmission.status, 'disabled');

  const failed = payloads.map(item => structuredClone(item));
  const evidence = (failed[0]?.scenarioEvidence as Record<string, unknown>);
  evidence.passed = false;
  evidence.assertions = [{ id: 'fixture', passed: false }];
  const collecting = _summarizePiKernelShadowScenarioEvidence(failed, identity);
  assert.equal(collecting.status, 'collecting');
  assert.equal(collecting.requirements[0]?.failing, 1);

  const inconsistent = payloads.map(item => structuredClone(item));
  (inconsistent[0]?.scenarioEvidence as Record<string, unknown>).passed = false;
  const rejected = _summarizePiKernelShadowScenarioEvidence(inconsistent, identity);
  assert.equal(rejected.ignoredCount, 2);
});

function baseEvidence(scenarioId = 'PKS01-no-tool') {
  const scenario = _PI_KERNEL_SHADOW_SCENARIOS.find(item => item.id === scenarioId)!;
  return {
    productionStatus: 'completed' as const,
    prompt: scenario.prompt,
    allowedTools: scenario.allowedTools,
    productionSessionId: 'session-main',
    productionTaskRunId: 'task-main',
    productionTraceId: 'trace-main',
    candidateSessionId: 'session-main:shadow:pi',
    candidateTaskRunId: 'task-main:shadow:pi',
    candidateTraceId: 'trace-main:shadow:pi',
    candidateEventLineageMatches: true,
    productionResult: scenarioId === 'PKS02-read-only-tool'
      ? {
          ...productionResult,
          turns: [{
            loopCount: 1,
            text: '{"packageName":"@los/agent"}',
            toolCalls: [{ id: 'read', type: 'function' as const, function: { name: 'read_file', arguments: '{}' } }],
            toolResults: ['{"name":"@los/agent"}'],
          }],
        }
      : productionResult,
  };
}

function payload(
  scenarioId: string,
  scenarioVersion: string,
  evidenceClass: 'deterministic' | 'live-provider',
  passed: boolean,
): Record<string, unknown> {
  return {
    candidate: { kind: 'pi', version: '0.81.1+los.1', protocolVersion: '0.1.0' },
    scenarioEvidence: {
      corpusVersion: _PI_KERNEL_SHADOW_CORPUS_VERSION,
      rubricRevision: _PI_KERNEL_SHADOW_RUBRIC_REVISION,
      scenarioId, scenarioVersion, evidenceClass, passed,
      assertions: [{ id: 'fixture', passed }],
    },
  };
}
