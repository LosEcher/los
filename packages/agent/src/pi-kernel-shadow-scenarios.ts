import { getDb } from '@los/infra/db';
import { ensureSessionEventStore } from './session-events.js';
import type { KernelIdentity } from './execution-kernel.js';
import type { AgentResult } from './loop.js';

export const _PI_KERNEL_SHADOW_CORPUS_VERSION = '1.0.0';
export const _PI_KERNEL_SHADOW_RUBRIC_REVISION = 'pi-shadow-readonly-v1';

export type PiKernelShadowScenarioId =
  | 'PKS01-no-tool'
  | 'PKS02-read-only-tool'
  | 'PKS03-policy-denial'
  | 'PKS04-provider-failure'
  | 'PKS05-interruption';

export type PiKernelShadowEvidenceClass = 'deterministic' | 'live-provider';
export type PiKernelShadowTerminalStatus = 'completed' | 'failed' | 'interrupted' | 'skipped';

export interface PiKernelShadowScenarioDefinition {
  id: PiKernelShadowScenarioId;
  version: string;
  family: string;
  description: string;
  prompt: string;
  allowedTools: string[];
  expectedCandidateStatus: PiKernelShadowTerminalStatus;
  allowedEvidenceClasses: PiKernelShadowEvidenceClass[];
  requiredObservations: Partial<Record<PiKernelShadowEvidenceClass, number>>;
}

export interface PiKernelShadowScenarioAssertion {
  id: string;
  passed: boolean;
}

export interface PiKernelShadowScenarioEvidence {
  corpusVersion: string;
  rubricRevision: string;
  scenarioId: PiKernelShadowScenarioId;
  scenarioVersion: string;
  evidenceClass: PiKernelShadowEvidenceClass;
  passed: boolean;
  assertions: PiKernelShadowScenarioAssertion[];
}

export interface PiKernelShadowScenarioReport {
  corpusVersion: string;
  rubricRevision: string;
  candidate: KernelIdentity & { kind: 'pi' };
  status: 'collecting' | 'ready_for_k4_policy_review';
  requirements: Array<{
    scenarioId: PiKernelShadowScenarioId;
    evidenceClass: PiKernelShadowEvidenceClass;
    required: number;
    observed: number;
    passing: number;
    failing: number;
  }>;
  observedCount: number;
  ignoredCount: number;
  automaticAdmission: { status: 'disabled'; reason: string };
}

export const _PI_KERNEL_SHADOW_SCENARIOS: readonly PiKernelShadowScenarioDefinition[] = Object.freeze([
  {
    id: 'PKS01-no-tool', version: '1.0.0', family: 'no_tool',
    description: 'Both kernels complete a fixed no-tool answer with equal output hashes.',
    prompt: 'Return exactly LOS_PI_SHADOW_OK and do not call tools.', allowedTools: [],
    expectedCandidateStatus: 'completed', allowedEvidenceClasses: ['deterministic', 'live-provider'],
    requiredObservations: { deterministic: 1, 'live-provider': 3 },
  },
  {
    id: 'PKS02-read-only-tool', version: '1.0.0', family: 'read_only_tool',
    description: 'Both kernels complete the same brokered read-only tool sequence.',
    prompt: 'Use read_file on package.json, then return exactly the package name.', allowedTools: ['read_file'],
    expectedCandidateStatus: 'completed', allowedEvidenceClasses: ['deterministic', 'live-provider'],
    requiredObservations: { deterministic: 1, 'live-provider': 3 },
  },
  {
    id: 'PKS03-policy-denial', version: '1.0.0', family: 'denied_tool',
    description: 'A deterministic broker denial remains bounded candidate evidence.',
    prompt: 'Deterministic fixture requests a broker-denied tool.', allowedTools: ['read_file'],
    expectedCandidateStatus: 'completed', allowedEvidenceClasses: ['deterministic'],
    requiredObservations: { deterministic: 3 },
  },
  {
    id: 'PKS04-provider-failure', version: '1.0.0', family: 'provider_failure',
    description: 'A deterministic candidate provider failure does not change production completion.',
    prompt: 'Deterministic fixture returns a candidate provider failure.', allowedTools: [],
    expectedCandidateStatus: 'failed', allowedEvidenceClasses: ['deterministic'],
    requiredObservations: { deterministic: 3 },
  },
  {
    id: 'PKS05-interruption', version: '1.0.0', family: 'interruption_timeout',
    description: 'A deterministic candidate interruption or timeout does not change production completion.',
    prompt: 'Deterministic fixture interrupts the candidate before completion.', allowedTools: [],
    expectedCandidateStatus: 'interrupted', allowedEvidenceClasses: ['deterministic'],
    requiredObservations: { deterministic: 3 },
  },
]);

export function _getPiKernelShadowScenario(id: string): PiKernelShadowScenarioDefinition {
  const scenario = _PI_KERNEL_SHADOW_SCENARIOS.find(item => item.id === id);
  if (!scenario) throw new Error(`Unknown Pi kernel shadow scenario: ${id}`);
  return scenario;
}

export function evaluatePiKernelShadowScenario(input: {
  scenarioId: PiKernelShadowScenarioId;
  evidenceClass: PiKernelShadowEvidenceClass;
  productionStatus: 'completed' | 'failed';
  productionResult?: AgentResult;
  prompt: string;
  allowedTools: readonly string[] | undefined;
  productionSessionId: string;
  productionTaskRunId: string;
  productionTraceId: string;
  candidateStatus: PiKernelShadowTerminalStatus;
  candidateSessionId: string;
  candidateTaskRunId: string;
  candidateTraceId: string;
  candidateEventCounts: Record<string, number>;
  candidateToolNames: string[];
  candidateToolCompletionStates: string[];
  candidateOutputHash?: string;
  productionOutputHash?: string;
}): PiKernelShadowScenarioEvidence {
  const scenario = _getPiKernelShadowScenario(input.scenarioId);
  if (!scenario.allowedEvidenceClasses.includes(input.evidenceClass)) {
    throw new Error(`${scenario.id} does not admit ${input.evidenceClass} evidence`);
  }
  const productionToolNames = input.productionResult?.turns.flatMap(turn =>
    turn.toolCalls.map(call => call.function.name)
  ) ?? [];
  const assertions: PiKernelShadowScenarioAssertion[] = [
    assertion('scenario_contract_match', input.prompt === scenario.prompt
      && equalStrings([...(input.allowedTools ?? [])], scenario.allowedTools)),
    assertion('production_completed', input.productionStatus === 'completed'),
    assertion('candidate_expected_status', input.candidateStatus === scenario.expectedCandidateStatus),
    assertion('derived_lineage_isolated',
      input.candidateSessionId === `${input.productionSessionId}:shadow:pi`
      && input.candidateTaskRunId === `${input.productionTaskRunId}:shadow:pi`
      && input.candidateTraceId === `${input.productionTraceId}:shadow:pi`),
    ...scenarioAssertions(scenario.id, input, productionToolNames),
  ];
  return {
    corpusVersion: _PI_KERNEL_SHADOW_CORPUS_VERSION,
    rubricRevision: _PI_KERNEL_SHADOW_RUBRIC_REVISION,
    scenarioId: scenario.id,
    scenarioVersion: scenario.version,
    evidenceClass: input.evidenceClass,
    passed: assertions.every(item => item.passed),
    assertions,
  };
}

export function _summarizePiKernelShadowScenarioEvidence(
  payloads: readonly Record<string, unknown>[],
  candidateIdentity: KernelIdentity & { kind: 'pi' },
): PiKernelShadowScenarioReport {
  if (!candidateIdentity.version.trim() || !candidateIdentity.protocolVersion.trim()) {
    throw new Error('candidate identity version and protocolVersion are required');
  }
  let ignoredCount = 0;
  const evidence: PiKernelShadowScenarioEvidence[] = [];
  for (const payload of payloads) {
    const candidate = asRecord(payload.candidate);
    const parsed = parseEvidence(payload.scenarioEvidence);
    if (candidate.kind !== candidateIdentity.kind
      || candidate.version !== candidateIdentity.version
      || candidate.protocolVersion !== candidateIdentity.protocolVersion
      || !parsed) {
      ignoredCount += 1;
      continue;
    }
    evidence.push(parsed);
  }
  const requirements = _PI_KERNEL_SHADOW_SCENARIOS.flatMap(scenario =>
    Object.entries(scenario.requiredObservations).map(([evidenceClass, required]) => {
      const matched = evidence.filter(item =>
        item.scenarioId === scenario.id
        && item.scenarioVersion === scenario.version
        && item.evidenceClass === evidenceClass
      );
      return {
        scenarioId: scenario.id,
        evidenceClass: evidenceClass as PiKernelShadowEvidenceClass,
        required: required ?? 0,
        observed: matched.length,
        passing: matched.filter(item => item.passed).length,
        failing: matched.filter(item => !item.passed).length,
      };
    })
  );
  const ready = requirements.every(item => item.passing >= item.required && item.failing === 0);
  return {
    corpusVersion: _PI_KERNEL_SHADOW_CORPUS_VERSION,
    rubricRevision: _PI_KERNEL_SHADOW_RUBRIC_REVISION,
    candidate: candidateIdentity,
    status: ready ? 'ready_for_k4_policy_review' : 'collecting',
    requirements,
    observedCount: evidence.length,
    ignoredCount,
    automaticAdmission: {
      status: 'disabled',
      reason: 'Scenario readiness permits K4 policy review only; registry admission and canary use require a separate operator decision.',
    },
  };
}

export async function _readPiKernelShadowScenarioReport(
  candidateIdentity: KernelIdentity & { kind: 'pi' },
): Promise<PiKernelShadowScenarioReport> {
  await ensureSessionEventStore();
  const rows = await getDb().query<{ payload_json: Record<string, unknown> }>(
    `SELECT payload_json FROM session_events
     WHERE type = 'kernel.shadow.compared'
       AND payload_json->'candidate'->>'kind' = 'pi'
       AND payload_json->'candidate'->>'version' = $1
       AND payload_json->'candidate'->>'protocolVersion' = $2
     ORDER BY id ASC
     LIMIT 5000`,
    [candidateIdentity.version, candidateIdentity.protocolVersion],
  );
  return _summarizePiKernelShadowScenarioEvidence(
    rows.rows.map(row => row.payload_json),
    candidateIdentity,
  );
}

function scenarioAssertions(
  id: PiKernelShadowScenarioId,
  input: Parameters<typeof evaluatePiKernelShadowScenario>[0],
  productionToolNames: string[],
): PiKernelShadowScenarioAssertion[] {
  if (id === 'PKS01-no-tool') return [
    assertion('no_tool_calls', input.candidateToolNames.length === 0 && productionToolNames.length === 0),
    assertion('output_hash_equal', Boolean(input.candidateOutputHash)
      && input.candidateOutputHash === input.productionOutputHash),
    assertion('candidate_finished_event', input.candidateEventCounts['kernel.finished'] === 1),
  ];
  if (id === 'PKS02-read-only-tool') return [
    assertion('tool_calls_observed', input.candidateToolNames.length > 0 && productionToolNames.length > 0),
    assertion('tool_sequence_equal', equalStrings(input.candidateToolNames, productionToolNames)),
    assertion('candidate_tools_succeeded', input.candidateToolCompletionStates.length === input.candidateToolNames.length
      && input.candidateToolCompletionStates.every(state => state === 'succeeded')),
    assertion('output_hash_equal', Boolean(input.candidateOutputHash)
      && input.candidateOutputHash === input.productionOutputHash),
    assertion('candidate_finished_event', input.candidateEventCounts['kernel.finished'] === 1),
  ];
  if (id === 'PKS03-policy-denial') return [
    assertion('candidate_tool_requested', input.candidateToolNames.length > 0),
    assertion('candidate_denial_recorded', input.candidateToolCompletionStates.includes('denied')),
    assertion('candidate_finished_event', input.candidateEventCounts['kernel.finished'] === 1),
  ];
  if (id === 'PKS04-provider-failure') return [
    assertion('candidate_failed_event', (input.candidateEventCounts['kernel.failed'] ?? 0) >= 1),
    assertion('candidate_has_no_output', input.candidateOutputHash === undefined),
  ];
  return [
    assertion('candidate_interrupted_event', (input.candidateEventCounts['kernel.interrupted'] ?? 0) >= 1),
    assertion('candidate_has_no_output', input.candidateOutputHash === undefined),
  ];
}

function assertion(id: string, passed: boolean): PiKernelShadowScenarioAssertion {
  return { id, passed };
}

function equalStrings(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function parseEvidence(value: unknown): PiKernelShadowScenarioEvidence | undefined {
  const record = asRecord(value);
  if (record.corpusVersion !== _PI_KERNEL_SHADOW_CORPUS_VERSION
    || record.rubricRevision !== _PI_KERNEL_SHADOW_RUBRIC_REVISION
    || typeof record.scenarioId !== 'string'
    || typeof record.scenarioVersion !== 'string'
    || (record.evidenceClass !== 'deterministic' && record.evidenceClass !== 'live-provider')
    || typeof record.passed !== 'boolean'
    || !Array.isArray(record.assertions)) return undefined;
  try {
    _getPiKernelShadowScenario(record.scenarioId);
  } catch {
    return undefined;
  }
  const assertions = record.assertions.flatMap(item => {
    const entry = asRecord(item);
    return typeof entry.id === 'string' && typeof entry.passed === 'boolean'
      ? [{ id: entry.id, passed: entry.passed }]
      : [];
  });
  if (assertions.length !== record.assertions.length) return undefined;
  if (record.passed !== assertions.every(assertion => assertion.passed)) return undefined;
  return {
    corpusVersion: record.corpusVersion,
    rubricRevision: record.rubricRevision,
    scenarioId: record.scenarioId as PiKernelShadowScenarioId,
    scenarioVersion: record.scenarioVersion,
    evidenceClass: record.evidenceClass,
    passed: record.passed,
    assertions,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
