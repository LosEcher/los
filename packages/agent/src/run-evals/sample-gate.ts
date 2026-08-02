import { randomUUID } from 'node:crypto';
import { getDb } from '@los/infra/db';
import { validateExecutionPairwiseSampleGateRequest } from '@los/contracts/execution-pairwise-sample-gate';
import { ensureRunEvalStore } from '../run-evals.js';
import { normalizeRequiredString, toIsoString } from './normalizers.js';

export type SampleGateStatus = 'registered' | 'passed' | 'superseded' | 'cancelled';

export interface SampleGateScenario {
  id: string;
  label: string;
  description?: string;
  requiredPairs: number;
}

export interface SampleGateRef {
  experimentId: string;
  runSpecId: string;
}

export interface SampleGateRubricRef {
  id: string;
  revision: string;
}

export interface SampleGateRegistration {
  id: string;
  tenantId?: string;
  projectId?: string;
  minimumPairs: number;
  scenarios: SampleGateScenario[];
  baselineRef: SampleGateRef;
  candidateRef: SampleGateRef;
  rubricRef: SampleGateRubricRef;
  status: SampleGateStatus;
  registeredBy: string;
  preregisteredAt: string;
  passedAt?: string;
  cancelledBy?: string;
  cancelledAt?: string;
}

export interface SampleGateScope {
  tenantId: string;
  projectId: string;
}

export interface RegisterSampleGateInput {
  id?: string;
  tenantId?: string;
  projectId?: string;
  minimumPairs: number;
  scenarios: SampleGateScenario[];
  baselineRef: SampleGateRef;
  candidateRef: SampleGateRef;
  rubricRef: SampleGateRubricRef;
  registeredBy: string;
}

export interface SampleGateScenarioCoverage {
  scenarioId: string;
  label: string;
  requiredPairs: number;
  collectedPairs: number;
  covered: boolean;
}

export interface SampleGateEffectiveRoute {
  provider?: string;
  model?: string;
  pairCount: number;
}

export interface SampleGateEvaluation {
  id: string;
  status: SampleGateStatus;
  minimumPairs: number;
  collectedPairs: number;
  scenarioCoverage: SampleGateScenarioCoverage[];
  uncategorizedPairs: number;
  effectiveRoutes: SampleGateEffectiveRoute[];
  passed: boolean;
  optimizationAnalysisEligible: boolean;
  evaluatedAt: string;
}

interface SampleGateRow {
  id: string;
  tenant_id: string | null;
  project_id: string | null;
  minimum_pairs: number;
  scenarios_json: unknown;
  baseline_ref_json: unknown;
  candidate_ref_json: unknown;
  rubric_ref_json: unknown;
  status: SampleGateStatus;
  registered_by: string;
  preregistered_at: string | Date;
  passed_at: string | Date | null;
  cancelled_by: string | null;
  cancelled_at: string | Date | null;
}

interface CollectedPairRow {
  pair_id: string;
  scenario_id: string | null;
  provider: string | null;
  model: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pairwise_sample_gates (
  id TEXT PRIMARY KEY, tenant_id TEXT, project_id TEXT,
  minimum_pairs INTEGER NOT NULL CHECK (minimum_pairs > 0),
  scenarios_json JSONB NOT NULL, baseline_ref_json JSONB NOT NULL,
  candidate_ref_json JSONB NOT NULL, rubric_ref_json JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'registered',
  registered_by TEXT NOT NULL,
  preregistered_at TIMESTAMPTZ NOT NULL DEFAULT now(), passed_at TIMESTAMPTZ,
  cancelled_by TEXT, cancelled_at TIMESTAMPTZ
);`;
let initialized = false;

export async function ensureSampleGateStore(): Promise<void> {
  if (initialized) return;
  await getDb().exec(SCHEMA);
  await getDb().exec(`
    CREATE INDEX IF NOT EXISTS idx_pairwise_sample_gates_scope_status
      ON pairwise_sample_gates(tenant_id, project_id, status);
  `);
  initialized = true;
}

export async function registerPairwiseSampleGate(input: RegisterSampleGateInput): Promise<SampleGateRegistration> {
  await ensureSampleGateStore();
  const request = {
    id: normalizeRequiredString(input.id ?? `sample-gate-${randomUUID()}`, 'id'),
    tenantId: input.tenantId,
    projectId: input.projectId,
    minimumPairs: input.minimumPairs,
    scenarios: input.scenarios,
    baselineRef: input.baselineRef,
    candidateRef: input.candidateRef,
    rubricRef: input.rubricRef,
  };
  const validation = validateExecutionPairwiseSampleGateRequest(request);
  if (!validation.success) {
    throw new Error(`sample gate contract validation failed: ${validation.errors.map(error => error.message ?? 'invalid').join('; ')}`);
  }
  const registeredBy = normalizeRequiredString(input.registeredBy, 'registeredBy');
  const scenarios = normalizeScenarios(request.scenarios);
  const now = new Date();
  const rows = await getDb().query<SampleGateRow>(
    `
    INSERT INTO pairwise_sample_gates (
      id, tenant_id, project_id, minimum_pairs, scenarios_json,
      baseline_ref_json, candidate_ref_json, rubric_ref_json,
      registered_by, preregistered_at
    )
    VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb, $9, $10)
    RETURNING *
    `,
    [
      request.id,
      request.tenantId ?? null,
      request.projectId ?? null,
      request.minimumPairs,
      JSON.stringify(scenarios),
      JSON.stringify(normalizeRef(request.baselineRef, 'baselineRef')),
      JSON.stringify(normalizeRef(request.candidateRef, 'candidateRef')),
      JSON.stringify(normalizeRubricRef(request.rubricRef)),
      registeredBy,
      toIsoString(now),
    ],
  );
  return rowToRegistration(rows.rows[0]!);
}

export async function loadPairwiseSampleGate(id: string, scope?: SampleGateScope): Promise<SampleGateRegistration | null> {
  await ensureSampleGateStore();
  const rows = await getDb().query<SampleGateRow>(
    `SELECT * FROM pairwise_sample_gates WHERE id = $1${scopeSql(scope, 2)}`,
    [id, ...scopeParams(scope)],
  );
  return rows.rows[0] ? rowToRegistration(rows.rows[0]) : null;
}

export async function listPairwiseSampleGates(scope: SampleGateScope | undefined, status?: SampleGateStatus): Promise<SampleGateRegistration[]> {
  await ensureSampleGateStore();
  const clauses: string[] = [];
  const values: unknown[] = [];
  if (status) {
    values.push(status);
    clauses.push(`status = $${values.length}`);
  }
  if (scope) {
    values.push(scope.tenantId, scope.projectId);
    clauses.push(`tenant_id = $${values.length - 1} AND project_id = $${values.length}`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  values.push(100);
  const rows = await getDb().query<SampleGateRow>(
    `SELECT * FROM pairwise_sample_gates ${where} ORDER BY preregistered_at DESC, id LIMIT $${values.length}`,
    values,
  );
  return rows.rows.map(rowToRegistration);
}

export async function cancelPairwiseSampleGate(id: string, scope: SampleGateScope | undefined, actor: string): Promise<SampleGateRegistration> {
  await ensureSampleGateStore();
  const current = await loadPairwiseSampleGate(id, scope);
  if (!current) throw new Error(`Pairwise sample gate not found: ${id}`);
  if (current.status === 'cancelled') return current;
  if (current.status === 'passed') {
    throw new Error(`Pairwise sample gate ${id} already passed; it is an immutable historical gate and cannot be cancelled`);
  }
  const rows = await getDb().query<SampleGateRow>(
    `UPDATE pairwise_sample_gates SET status = 'cancelled', cancelled_by = $2, cancelled_at = now() WHERE id = $1${scopeSql(scope, 3)} RETURNING *`,
    [id, actor, ...scopeParams(scope)],
  );
  return rowToRegistration(rows.rows[0]!);
}

export async function evaluatePairwiseSampleGate(id: string, scope?: SampleGateScope): Promise<SampleGateEvaluation> {
  await ensureSampleGateStore();
  await ensureRunEvalStore();
  const registration = await loadPairwiseSampleGate(id, scope);
  if (!registration) throw new Error(`Pairwise sample gate not found: ${id}`);
  const rows = await getDb().query<CollectedPairRow>(
    `SELECT DISTINCT ON (pair_id) pair_id,
            summary_json->>'scenarioId' AS scenario_id,
            provider, model
     FROM run_evals
     WHERE evaluation_kind = 'pairwise'
       AND rubric_revision = $1
       AND (human_evidence_json IS NOT NULL
            OR judge_evidence_json IS NOT NULL
            OR deterministic_evidence_json IS NOT NULL)
     ORDER BY pair_id`,
    [registration.rubricRef.revision],
  );
  const pairs = rows.rows;
  const scenarioCoverage = registration.scenarios.map(scenario => {
    const collectedPairs = pairs.filter(pair => pair.scenario_id === scenario.id).length;
    return {
      scenarioId: scenario.id,
      label: scenario.label,
      requiredPairs: scenario.requiredPairs,
      collectedPairs,
      covered: collectedPairs >= scenario.requiredPairs,
    };
  });
  const uncategorizedPairs = pairs.filter(pair => !pair.scenario_id).length;
  const effectiveRoutes = aggregateEffectiveRoutes(pairs);
  const collectedPairs = pairs.length;
  const passed = collectedPairs >= registration.minimumPairs
    && scenarioCoverage.every(scenario => scenario.covered);
  const evaluatedAt = new Date().toISOString();
  if (passed && registration.status === 'registered') {
    const rows = await getDb().query<SampleGateRow>(
      `UPDATE pairwise_sample_gates SET status = 'passed', passed_at = $2 WHERE id = $1${scopeSql(scope, 3)} RETURNING *`,
      [id, evaluatedAt, ...scopeParams(scope)],
    );
    registration.status = rows.rows[0]!.status;
    registration.passedAt = rows.rows[0]!.passed_at ? toIso(rows.rows[0]!.passed_at) : undefined;
  }
  return {
    id,
    status: registration.status,
    minimumPairs: registration.minimumPairs,
    collectedPairs,
    scenarioCoverage,
    uncategorizedPairs,
    effectiveRoutes,
    passed,
    optimizationAnalysisEligible: passed,
    evaluatedAt,
  };
}

function aggregateEffectiveRoutes(pairs: CollectedPairRow[]): SampleGateEffectiveRoute[] {
  const byRoute = new Map<string, SampleGateEffectiveRoute>();
  for (const pair of pairs) {
    const key = `${pair.provider ?? ''}|${pair.model ?? ''}`;
    const existing = byRoute.get(key);
    if (existing) existing.pairCount += 1;
    else byRoute.set(key, { provider: pair.provider ?? undefined, model: pair.model ?? undefined, pairCount: 1 });
  }
  return [...byRoute.values()].sort((left, right) => right.pairCount - left.pairCount);
}

function normalizeScenarios(value: SampleGateScenario[]): SampleGateScenario[] {
  const scenarios = value.map(scenario => ({
    id: normalizeRequiredString(scenario.id, 'scenario id'),
    label: normalizeRequiredString(scenario.label, 'scenario label'),
    description: scenario.description,
    requiredPairs: positiveInteger(scenario.requiredPairs, `scenario ${scenario.id} requiredPairs`),
  }));
  if (new Set(scenarios.map(scenario => scenario.id)).size !== scenarios.length) {
    throw new Error('scenario ids must be unique');
  }
  return scenarios;
}

function normalizeRef(value: SampleGateRef, name: string): SampleGateRef {
  return {
    experimentId: normalizeRequiredString(value.experimentId, `${name}.experimentId`),
    runSpecId: normalizeRequiredString(value.runSpecId, `${name}.runSpecId`),
  };
}

function normalizeRubricRef(value: SampleGateRubricRef): SampleGateRubricRef {
  return {
    id: normalizeRequiredString(value.id, 'rubricRef.id'),
    revision: normalizeRequiredString(value.revision, 'rubricRef.revision'),
  };
}

function positiveInteger(value: unknown, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function scopeSql(scope: SampleGateScope | undefined, firstParam: number): string {
  if (!scope) return '';
  return ` AND tenant_id IS NOT DISTINCT FROM $${firstParam} AND project_id IS NOT DISTINCT FROM $${firstParam + 1}`;
}

function scopeParams(scope: SampleGateScope | undefined): string[] {
  return scope ? [scope.tenantId, scope.projectId] : [];
}

function rowToRegistration(row: SampleGateRow): SampleGateRegistration {
  return {
    id: row.id,
    tenantId: row.tenant_id ?? undefined,
    projectId: row.project_id ?? undefined,
    minimumPairs: row.minimum_pairs,
    scenarios: row.scenarios_json as SampleGateScenario[],
    baselineRef: row.baseline_ref_json as SampleGateRef,
    candidateRef: row.candidate_ref_json as SampleGateRef,
    rubricRef: row.rubric_ref_json as SampleGateRubricRef,
    status: row.status,
    registeredBy: row.registered_by,
    preregisteredAt: toIso(row.preregistered_at),
    passedAt: row.passed_at ? toIso(row.passed_at) : undefined,
    cancelledBy: row.cancelled_by ?? undefined,
    cancelledAt: row.cancelled_at ? toIso(row.cancelled_at) : undefined,
  };
}

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
