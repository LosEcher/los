import { getDb } from '@los/infra/db';

import { ensureRunEvalStore, recordRunEval } from './run-evals.js';
import type { RunEvalRecord, RunEvalVerificationStatus } from './run-evals.js';
import type {
  DailyAgentScenarioDefinition,
  DailyAgentScenarioEconomicsOptions,
  DailyAgentScenarioHardAssertion,
  DailyAgentScenarioLane,
  DailyAgentScenarioRole,
  DailyAgentScenarioRouteReason,
  RecordDailyAgentScenarioEconomicsInput,
} from './scenario-economics-types.js';

export type {
  DailyAgentScenarioDefinition,
  DailyAgentScenarioEconomicsOptions,
  DailyAgentScenarioHardAssertion,
  DailyAgentScenarioLane,
  DailyAgentScenarioRole,
  DailyAgentScenarioRouteReason,
  RecordDailyAgentScenarioEconomicsInput,
} from './scenario-economics-types.js';

const DAILY_AGENT_SCENARIO_CORPUS_ID = 'web-first-daily-agent';
const DAILY_AGENT_SCENARIO_CORPUS_VERSION = '2026-07-21.v3';
const DAILY_AGENT_SCENARIO_MIN_RUNS_PER_LANE = 3;

const REQUIRED_ROLES: DailyAgentScenarioRole[] = ['planner', 'worker', 'reviewer'];

const DAILY_AGENT_SCENARIOS: DailyAgentScenarioDefinition[] = [
  {
    id: 'DA01-work-first-intake', version: '1.0.1', title: 'Web Work-first intake', requiredRoles: REQUIRED_ROLES,
    acceptanceCriteria: ['work_item_created', 'plan_persisted_before_approval', 'editable_scope_preserved'],
  },
  {
    id: 'DA02-approval-resume', version: '1.0.1', title: 'Approval resumes execution', requiredRoles: REQUIRED_ROLES,
    acceptanceCriteria: ['approved_revision_dispatched_once', 'request_parameters_replayed', 'execution_gate_preserved'],
  },
  {
    id: 'DA03-verification-block', version: '1.0.1', title: 'Verification blocks completion', requiredRoles: REQUIRED_ROLES,
    acceptanceCriteria: ['required_verification_recorded', 'failed_verification_blocks_success', 'workspace_diff_exposed'],
  },
  {
    id: 'DA04-revision-recovery', version: '1.0.1', title: 'Revision creates bounded recovery', requiredRoles: REQUIRED_ROLES,
    acceptanceCriteria: ['revision_lineage_preserved', 'no_progress_stops_retry', 'operator_attention_deduplicated'],
  },
  {
    id: 'DA05-interrupted-resume', version: '1.0.1', title: 'Interrupted run resumes from evidence', requiredRoles: REQUIRED_ROLES,
    acceptanceCriteria: ['persisted_state_reloaded', 'active_work_not_duplicated', 'recovery_result_recorded'],
  },
];

interface StoredScenarioRecord {
  eval: RunEvalRecord;
  scenario: DailyAgentScenarioDefinition;
  scenarioRunId: string;
  lane: DailyAgentScenarioLane;
  role: DailyAgentScenarioRole;
  requestedProvider: string | null;
  requestedModel: string | null;
  effectiveProvider: string;
  effectiveModel: string;
  routeReason: DailyAgentScenarioRouteReason;
  promptTokens: number;
  completionTokens: number;
  operatorInterventionCount: number;
  operatorWaitMs: number;
  planningAttemptCount: number;
  executionAttemptCount: number;
  revisionCount: number;
  diffOutcome: 'accepted' | 'revision_requested' | 'not_reviewed';
  recoveryResult: 'not_required' | 'resumed' | 'failed';
  hardAssertions: DailyAgentScenarioHardAssertion[];
}

export function getDailyAgentScenarioCorpus(): { id: string; version: string; scenarios: DailyAgentScenarioDefinition[] } {
  return { id: DAILY_AGENT_SCENARIO_CORPUS_ID, version: DAILY_AGENT_SCENARIO_CORPUS_VERSION, scenarios: DAILY_AGENT_SCENARIOS };
}

export async function recordDailyAgentScenarioEconomics(
  input: RecordDailyAgentScenarioEconomicsInput,
): Promise<RunEvalRecord> {
  const scenario = scenarioFor(input.scenarioId, input.scenarioVersion);
  const lane = expectOne(input.lane, ['baseline', 'candidate'], 'lane');
  const role = expectOne(input.role, REQUIRED_ROLES, 'role');
  const routeReason = expectOne(input.routeReason, [
    'configured_default', 'explicit_provider', 'explicit_model', 'architect_editor_override', 'explicit_fallback_policy',
  ], 'routeReason');
  if (lane === 'candidate' && routeReason !== 'explicit_provider' && routeReason !== 'explicit_model') {
    throw new Error('candidate scenario records require explicit_provider or explicit_model routeReason');
  }
  const hardAssertions = normalizeAssertions(input.hardAssertions, scenario);
  const verificationAllowsSuccess = role !== 'reviewer'
    || input.verificationStatus === 'succeeded'
    || input.verificationStatus === 'not_required';
  const success = input.success && verificationAllowsSuccess && hardAssertions.every(assertion => assertion.passed);
  const scenarioRunId = requiredString(input.scenarioRunId, 'scenarioRunId');
  const effectiveProvider = requiredString(input.effectiveProvider, 'effectiveProvider');
  const effectiveModel = requiredString(input.effectiveModel, 'effectiveModel');
  return recordRunEval({
    id: input.id ?? `daily-scenario-${scenarioRunId}-${lane}-${role}`,
    runSpecId: requiredString(input.runSpecId, 'runSpecId'),
    sessionId: optionalString(input.sessionId),
    taskRunId: optionalString(input.taskRunId),
    provider: effectiveProvider,
    model: effectiveModel,
    success,
    latencyMs: optionalNonNegative(input.latencyMs, 'latencyMs'),
    retryCount: nonNegative(input.retryCount ?? 0, 'retryCount'),
    toolErrorCount: nonNegative(input.toolErrorCount ?? 0, 'toolErrorCount'),
    verificationStatus: input.verificationStatus,
    modelCost: nonNegative(input.modelCost, 'modelCost'),
    summary: {
      kind: 'daily_agent_scenario_economics',
      corpusVersion: DAILY_AGENT_SCENARIO_CORPUS_VERSION,
      scenarioId: scenario.id,
      scenarioVersion: scenario.version,
      scenarioRunId,
      lane,
      role,
      requestedProvider: optionalString(input.requestedProvider) ?? null,
      requestedModel: optionalString(input.requestedModel) ?? null,
      effectiveProvider,
      effectiveModel,
      routeReason,
      promptTokens: nonNegative(input.promptTokens, 'promptTokens'),
      completionTokens: nonNegative(input.completionTokens, 'completionTokens'),
      operatorInterventionCount: nonNegative(input.operatorInterventionCount, 'operatorInterventionCount'),
      operatorWaitMs: optionalNonNegative(input.operatorWaitMs, 'operatorWaitMs') ?? 0,
      planningAttemptCount: optionalNonNegative(input.planningAttemptCount, 'planningAttemptCount') ?? 0,
      executionAttemptCount: optionalNonNegative(input.executionAttemptCount, 'executionAttemptCount') ?? 0,
      revisionCount: optionalNonNegative(input.revisionCount, 'revisionCount') ?? 0,
      diffOutcome: input.diffOutcome ?? 'not_reviewed',
      recoveryResult: input.recoveryResult ?? 'not_required',
      hardAssertions,
    },
  });
}

export async function summarizeDailyAgentScenarioEconomics(options: DailyAgentScenarioEconomicsOptions = {}) {
  await ensureRunEvalStore();
  const params: unknown[] = ['daily_agent_scenario_economics', DAILY_AGENT_SCENARIO_CORPUS_VERSION];
  const clauses = [`summary_json->>'kind'=$1`, `summary_json->>'corpusVersion'=$2`];
  if (options.runSpecId) {
    params.push(requiredString(options.runSpecId, 'runSpecId'));
    clauses.push(`run_spec_id=$${params.length}`);
  }
  addTimeClause(clauses, params, 'created_at >=', options.createdFrom, 'createdFrom');
  addTimeClause(clauses, params, 'created_at <=', options.createdTo, 'createdTo');
  const rows = await getDb().query<Record<string, unknown>>(
    `SELECT * FROM run_evals WHERE ${clauses.join(' AND ')} ORDER BY created_at, id`, params,
  );
  const parsed = rows.rows.map(parseStoredRecord).filter((record): record is StoredScenarioRecord => record !== undefined);
  const runs = buildScenarioRuns(parsed);
  const cells = DAILY_AGENT_SCENARIOS.flatMap(scenario => (['baseline', 'candidate'] as const).map(lane => {
    const completedRuns = runs.filter(run => run.scenarioId === scenario.id && run.lane === lane && run.completed).length;
    return { scenarioId: scenario.id, lane, completedRuns, requiredRuns: DAILY_AGENT_SCENARIO_MIN_RUNS_PER_LANE };
  }));
  const missingCells = cells.filter(cell => cell.completedRuns < cell.requiredRuns);
  return {
    corpus: getDailyAgentScenarioCorpus(),
    evidence: {
      status: missingCells.length === 0 ? 'ready_for_policy_review' as const : 'collecting' as const,
      acceptedRecordCount: parsed.length,
      rejectedRecordCount: rows.rows.length - parsed.length,
      scenarioRunCount: runs.length,
      completedScenarioRunCount: runs.filter(run => run.completed).length,
      requiredRunsPerLane: DAILY_AGENT_SCENARIO_MIN_RUNS_PER_LANE,
      missingCells,
    },
    automaticRouting: {
      status: 'disabled' as const,
      reason: 'Evidence readiness does not authorize routing changes; a separate accepted policy and operator approval are required.',
    },
    totals: summarizeRuns(runs),
    byScenario: DAILY_AGENT_SCENARIOS.map(scenario => ({ scenarioId: scenario.id, ...summarizeRuns(runs.filter(run => run.scenarioId === scenario.id)) })),
    byRole: REQUIRED_ROLES.map(role => ({ role, ...summarizeRecords(parsed.filter(record => record.role === role)) })),
    byLane: (['baseline', 'candidate'] as const).map(lane => ({ lane, ...summarizeRuns(runs.filter(run => run.lane === lane)) })),
    byRoute: summarizeRoutes(parsed),
  };
}

function buildScenarioRuns(records: StoredScenarioRecord[]) {
  const groups = new Map<string, StoredScenarioRecord[]>();
  for (const record of records) {
    const key = `${record.scenario.id}\0${record.lane}\0${record.scenarioRunId}`;
    groups.set(key, [...(groups.get(key) ?? []), record]);
  }
  return [...groups.values()].map(group => {
    const first = group[0]!;
    const roles = new Set(group.map(record => record.role));
    const reviewer = group.find(record => record.role === 'reviewer');
    const completed = first.scenario.requiredRoles.every(role => roles.has(role))
      && group.every(record => record.eval.success && record.hardAssertions.every(assertion => assertion.passed))
      && (reviewer?.eval.verificationStatus === 'succeeded' || reviewer?.eval.verificationStatus === 'not_required');
    return {
      scenarioId: first.scenario.id, scenarioRunId: first.scenarioRunId, lane: first.lane, completed,
      cost: sum(group, record => record.eval.modelCost ?? 0),
      latencyMs: sum(group, record => record.eval.latencyMs ?? 0),
      retryCount: sum(group, record => record.eval.retryCount),
      promptTokens: sum(group, record => record.promptTokens),
      completionTokens: sum(group, record => record.completionTokens),
      operatorInterventionCount: sum(group, record => record.operatorInterventionCount),
      operatorWaitMs: sum(group, record => record.operatorWaitMs),
      planningAttemptCount: sum(group, record => record.planningAttemptCount),
      executionAttemptCount: sum(group, record => record.executionAttemptCount),
      revisionCount: sum(group, record => record.revisionCount),
      diffAccepted: group.some(record => record.diffOutcome === 'accepted'),
      revisionRequested: group.some(record => record.diffOutcome === 'revision_requested'),
      recovered: group.some(record => record.recoveryResult === 'resumed'),
      recoveryFailed: group.some(record => record.recoveryResult === 'failed'),
      verificationFailureCount: group.filter(record => record.eval.verificationStatus === 'failed').length,
    };
  });
}

function summarizeRuns(runs: ReturnType<typeof buildScenarioRuns>) {
  const completedRunCount = runs.filter(run => run.completed).length;
  return {
    runCount: runs.length,
    completedRunCount,
    completionRate: runs.length > 0 ? completedRunCount / runs.length : 0,
    modelCost: sum(runs, run => run.cost),
    averageElapsedMs: average(runs.map(run => run.latencyMs)),
    retryCount: sum(runs, run => run.retryCount),
    promptTokens: sum(runs, run => run.promptTokens),
    completionTokens: sum(runs, run => run.completionTokens),
    operatorInterventionCount: sum(runs, run => run.operatorInterventionCount),
    operatorWaitMs: sum(runs, run => run.operatorWaitMs),
    planningAttemptCount: sum(runs, run => run.planningAttemptCount),
    executionAttemptCount: sum(runs, run => run.executionAttemptCount),
    revisionCount: sum(runs, run => run.revisionCount),
    diffAcceptedCount: runs.filter(run => run.diffAccepted).length,
    revisionRequestedCount: runs.filter(run => run.revisionRequested).length,
    recoveredRunCount: runs.filter(run => run.recovered).length,
    recoveryFailureCount: runs.filter(run => run.recoveryFailed).length,
    verificationFailureCount: sum(runs, run => run.verificationFailureCount),
  };
}

function summarizeRecords(records: StoredScenarioRecord[]) {
  const successCount = records.filter(record => record.eval.success).length;
  return {
    recordCount: records.length,
    successCount,
    successRate: records.length > 0 ? successCount / records.length : 0,
    modelCost: sum(records, record => record.eval.modelCost ?? 0),
    averageLatencyMs: average(records.flatMap(record => record.eval.latencyMs === undefined ? [] : [record.eval.latencyMs])),
    retryCount: sum(records, record => record.eval.retryCount),
    promptTokens: sum(records, record => record.promptTokens),
    completionTokens: sum(records, record => record.completionTokens),
    operatorInterventionCount: sum(records, record => record.operatorInterventionCount),
    operatorWaitMs: sum(records, record => record.operatorWaitMs),
    planningAttemptCount: sum(records, record => record.planningAttemptCount),
    executionAttemptCount: sum(records, record => record.executionAttemptCount),
    revisionCount: sum(records, record => record.revisionCount),
    verificationFailureCount: records.filter(record => record.eval.verificationStatus === 'failed').length,
  };
}

function summarizeRoutes(records: StoredScenarioRecord[]) {
  const groups = new Map<string, StoredScenarioRecord[]>();
  for (const record of records) {
    const key = JSON.stringify([
      record.lane, record.role, record.requestedProvider, record.requestedModel,
      record.effectiveProvider, record.effectiveModel, record.routeReason,
    ]);
    groups.set(key, [...(groups.get(key) ?? []), record]);
  }
  return [...groups.values()].map(group => {
    const first = group[0]!;
    return {
      lane: first.lane, role: first.role,
      requestedProvider: first.requestedProvider, requestedModel: first.requestedModel,
      effectiveProvider: first.effectiveProvider, effectiveModel: first.effectiveModel,
      routeReason: first.routeReason, ...summarizeRecords(group),
    };
  });
}

function parseStoredRecord(row: Record<string, unknown>): StoredScenarioRecord | undefined {
  const summary = asObject(row.summary_json);
  const scenarioId = optionalString(summary.scenarioId);
  const scenarioVersion = optionalString(summary.scenarioVersion);
  const scenario = DAILY_AGENT_SCENARIOS.find(item => item.id === scenarioId && item.version === scenarioVersion);
  const lane = oneOf(summary.lane, ['baseline', 'candidate'] as const);
  const role = oneOf(summary.role, REQUIRED_ROLES);
  const routeReason = oneOf(summary.routeReason, [
    'configured_default', 'explicit_provider', 'explicit_model', 'architect_editor_override', 'explicit_fallback_policy',
  ] as const);
  const scenarioRunId = optionalString(summary.scenarioRunId);
  const effectiveProvider = optionalString(summary.effectiveProvider);
  const effectiveModel = optionalString(summary.effectiveModel);
  const hardAssertions = parseAssertions(summary.hardAssertions);
  if (!scenario || !lane || !role || !routeReason || !scenarioRunId || !effectiveProvider || !effectiveModel || !hardAssertions) return undefined;
  if (lane === 'candidate' && routeReason !== 'explicit_provider' && routeReason !== 'explicit_model') return undefined;
  if (scenario.acceptanceCriteria.some(id => !hardAssertions.some(assertion => assertion.id === id))) return undefined;
  try {
    return {
      eval: rowToEval(row), scenario, scenarioRunId, lane, role, routeReason, effectiveProvider, effectiveModel, hardAssertions,
      requestedProvider: optionalString(summary.requestedProvider) ?? null,
      requestedModel: optionalString(summary.requestedModel) ?? null,
      promptTokens: nonNegative(summary.promptTokens, 'promptTokens'),
      completionTokens: nonNegative(summary.completionTokens, 'completionTokens'),
      operatorInterventionCount: nonNegative(summary.operatorInterventionCount, 'operatorInterventionCount'),
      operatorWaitMs: nonNegative(summary.operatorWaitMs, 'operatorWaitMs'),
      planningAttemptCount: nonNegative(summary.planningAttemptCount, 'planningAttemptCount'),
      executionAttemptCount: nonNegative(summary.executionAttemptCount, 'executionAttemptCount'),
      revisionCount: nonNegative(summary.revisionCount, 'revisionCount'),
      diffOutcome: expectOne(summary.diffOutcome, ['accepted', 'revision_requested', 'not_reviewed'], 'diffOutcome'),
      recoveryResult: expectOne(summary.recoveryResult, ['not_required', 'resumed', 'failed'], 'recoveryResult'),
    };
  } catch { return undefined; }
}

function rowToEval(row: Record<string, unknown>): RunEvalRecord {
  return {
    id: String(row.id), runSpecId: String(row.run_spec_id), success: row.success === true,
    provider: optionalString(row.provider), model: optionalString(row.model),
    latencyMs: row.latency_ms === null ? undefined : Number(row.latency_ms),
    retryCount: Number(row.retry_count ?? 0), toolErrorCount: Number(row.tool_error_count ?? 0),
    verificationStatus: normalizeVerification(row.verification_status),
    modelCost: row.model_cost === null ? undefined : Number(row.model_cost),
    evaluationKind: 'single', summary: asObject(row.summary_json),
    createdAt: new Date(row.created_at as string | Date).toISOString(), updatedAt: new Date(row.updated_at as string | Date).toISOString(),
  };
}

function scenarioFor(id: string, version: string): DailyAgentScenarioDefinition {
  const scenario = DAILY_AGENT_SCENARIOS.find(item => item.id === id && item.version === version);
  if (!scenario) throw new Error(`unknown daily-agent scenario: ${id}@${version}`);
  return scenario;
}

function normalizeAssertions(value: DailyAgentScenarioHardAssertion[], scenario: DailyAgentScenarioDefinition) {
  const parsed = parseAssertions(value);
  if (!parsed) throw new Error('hardAssertions must contain unique id/passed entries');
  const provided = new Set(parsed.map(item => item.id));
  const missing = scenario.acceptanceCriteria.filter(id => !provided.has(id));
  if (missing.length > 0) throw new Error(`missing hard assertions: ${missing.join(', ')}`);
  return parsed;
}

function parseAssertions(value: unknown): DailyAgentScenarioHardAssertion[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const parsed = value.map(item => asObject(item)).map(item => ({ id: optionalString(item.id), passed: item.passed }));
  if (parsed.some(item => !item.id || typeof item.passed !== 'boolean')) return undefined;
  const result = parsed.map(item => ({ id: item.id!, passed: item.passed as boolean }));
  return new Set(result.map(item => item.id)).size === result.length ? result : undefined;
}

function addTimeClause(clauses: string[], params: unknown[], sql: string, value: string | undefined, name: string) {
  if (!value) return;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`${name} must be a valid timestamp`);
  params.push(date.toISOString());
  clauses.push(`${sql} $${params.length}::timestamptz`);
}

function normalizeVerification(value: unknown): RunEvalVerificationStatus {
  return value === 'not_required' || value === 'pending' || value === 'succeeded' || value === 'failed' || value === 'skipped' ? value : 'unknown';
}

function requiredString(value: unknown, name: string): string {
  const normalized = optionalString(value);
  if (!normalized) throw new Error(`${name} is required`);
  return normalized;
}
function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
function nonNegative(value: unknown, name: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${name} must be non-negative`);
  return parsed;
}
function optionalNonNegative(value: unknown, name: string): number | undefined {
  return value === undefined || value === null ? undefined : nonNegative(value, name);
}
function expectOne<const T extends string>(value: unknown, allowed: readonly T[], name: string): T {
  const parsed = oneOf(value, allowed);
  if (!parsed) throw new Error(`${name} must be one of: ${allowed.join(', ')}`);
  return parsed;
}
function oneOf<const T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === 'string' && allowed.includes(value as T) ? value as T : undefined;
}
function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function sum<T>(items: T[], pick: (item: T) => number): number { return items.reduce((total, item) => total + pick(item), 0); }
function average(values: number[]): number | undefined { return values.length > 0 ? sum(values, value => value) / values.length : undefined; }
