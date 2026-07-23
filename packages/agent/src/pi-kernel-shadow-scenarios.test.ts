import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';
import {
  _PI_KERNEL_SHADOW_CORPUS_VERSION,
  _PI_KERNEL_SHADOW_RUBRIC_REVISION,
  _PI_KERNEL_SHADOW_SCENARIOS,
  evaluatePiKernelShadowScenario,
  _summarizePiKernelShadowScenarioEvidence,
} from './pi-kernel-shadow-scenarios.js';
import { _verifyPiKernelShadowWorkspaceFixture } from './pi-kernel-shadow-workspace-fixture.js';
import type { AgentResult } from './loop.js';

const productionResult: AgentResult = {
  text: 'LOS_PI_SHADOW_OK',
  turns: [], loopCount: 1,
  totalTokens: { prompt: 10, completion: 4 },
  messages: [],
};
const pks02Scenario = _PI_KERNEL_SHADOW_SCENARIOS[1]!;
const pks02WorkspaceFixture = await _verifyPiKernelShadowWorkspaceFixture(
  pks02Scenario.workspaceFixture!,
  resolve(import.meta.dirname, '..'),
);

test('Pi shadow corpus preregisters bounded read-only scenario requirements', () => {
  assert.deepEqual(_PI_KERNEL_SHADOW_SCENARIOS.map(item => item.id), [
    'PKS01-no-tool',
    'PKS02-read-only-tool',
    'PKS03-policy-denial',
    'PKS04-provider-failure',
    'PKS05-interruption',
  ]);
  assert.ok(_PI_KERNEL_SHADOW_SCENARIOS.every(item => item.version === '1.1.2'));
  assert.deepEqual(_PI_KERNEL_SHADOW_SCENARIOS[1]?.allowedTools, ['read_file']);
  assert.deepEqual(_PI_KERNEL_SHADOW_SCENARIOS[1]?.workspaceFixture, {
    kind: 'json_string_field', relativePath: 'package.json', field: 'name', expectedValue: '@los/agent',
  });
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
  assert.equal(compared.resultComparison?.productionEnvelopeShape, 'json_object');
  assert.equal(compared.resultComparison?.candidateEnvelopeShape, 'fenced_json');
  assert.equal(JSON.stringify(compared).includes('@los/agent'), false);

  const prefixedFence = evaluatePiKernelShadowScenario({
    ...baseEvidence('PKS02-read-only-tool'), scenarioId: 'PKS02-read-only-tool', evidenceClass: 'live-provider',
    candidateStatus: 'completed', candidateEventCounts: { 'kernel.finished': 1 },
    candidateToolNames: ['read_file'], candidateToolCompletionStates: ['succeeded'],
    productionText: '{"packageName":"@los/agent"}',
    candidateText: 'Here is the result:\n\n```json\n{"packageName":"@los/agent"}\n```',
  });
  assert.equal(prefixedFence.passed, false);
  assert.equal(prefixedFence.resultComparison?.candidateEnvelopeShape, 'prefixed_fenced_json');
  assert.equal(prefixedFence.resultComparison?.candidateTextLength, 61);
  assert.equal(prefixedFence.resultComparison?.candidateValueHash, undefined);
  assert.equal(JSON.stringify(prefixedFence).includes('Here is the result'), false);

  const wrongValue = evaluatePiKernelShadowScenario({
    ...baseEvidence('PKS02-read-only-tool'), scenarioId: 'PKS02-read-only-tool', evidenceClass: 'live-provider',
    candidateStatus: 'completed', candidateEventCounts: { 'kernel.finished': 1 },
    candidateToolNames: ['read_file'], candidateToolCompletionStates: ['succeeded'],
    productionText: '{"packageName":"@los/agent"}', candidateText: '{"packageName":"los"}',
  });
  assert.equal(wrongValue.passed, false);
  assert.equal(wrongValue.assertions.find(item => item.id === 'task_value_expected')?.passed, false);

  const missingFixture = evaluatePiKernelShadowScenario({
    ...baseEvidence('PKS02-read-only-tool'), workspaceFixture: undefined,
    scenarioId: 'PKS02-read-only-tool', evidenceClass: 'live-provider',
    candidateStatus: 'completed', candidateEventCounts: { 'kernel.finished': 1 },
    candidateToolNames: ['read_file'], candidateToolCompletionStates: ['succeeded'],
    productionText: '{"packageName":"@los/agent"}', candidateText: '{"packageName":"@los/agent"}',
  });
  assert.equal(missingFixture.passed, false);
  assert.equal(missingFixture.assertions.find(item => item.id === 'scenario_contract_match')?.passed, false);
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
  payloads.push({ ...payload('PKS01-no-tool', '1.1.2', 'live-provider', true), candidate: { kind: 'pi', version: '0.82.0' } });
  payloads.push({
    candidate: { kind: 'pi', version: '0.81.1+los.1', protocolVersion: '0.1.0' },
    scenarioEvidence: {
      corpusVersion: '1.1.0', rubricRevision: 'pi-shadow-readonly-v2',
      scenarioId: 'PKS01-no-tool', scenarioVersion: '1.1.0', evidenceClass: 'live-provider',
      passed: true, assertions: [{ id: 'fixture', passed: true }],
    },
  });
  payloads.push(payload('PKS01-no-tool', '1.1.0', 'live-provider', true));

  const identity = { kind: 'pi' as const, version: '0.81.1+los.3', protocolVersion: '0.1.0' };
  const report = _summarizePiKernelShadowScenarioEvidence(payloads, identity);
  assert.equal(report.status, 'ready_for_k4_policy_review');
  assert.equal(report.observedCount, 17);
  assert.equal(report.ignoredCount, 3);
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
  assert.equal(rejected.ignoredCount, 4);
});

function baseEvidence(scenarioId = 'PKS01-no-tool') {
  const scenario = _PI_KERNEL_SHADOW_SCENARIOS.find(item => item.id === scenarioId)!;
  return {
    productionStatus: 'completed' as const,
    prompt: scenario.prompt,
    allowedTools: scenario.allowedTools,
    ...(scenario.workspaceFixture ? { workspaceFixture: pks02WorkspaceFixture } : {}),
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
    candidate: { kind: 'pi', version: '0.81.1+los.3', protocolVersion: '0.1.0' },
    scenarioEvidence: {
      corpusVersion: _PI_KERNEL_SHADOW_CORPUS_VERSION,
      rubricRevision: _PI_KERNEL_SHADOW_RUBRIC_REVISION,
      scenarioId, scenarioVersion, evidenceClass, passed,
      assertions: [{ id: 'fixture', passed }],
      ...(scenarioId === 'PKS02-read-only-tool' ? { workspaceFixture: pks02WorkspaceFixture } : {}),
    },
  };
}
