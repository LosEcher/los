import { randomUUID } from 'node:crypto';
import { validateExecutionPairwiseEvalRequest } from '@los/contracts/execution-pairwise-eval';
import { getDb } from '@los/infra/db';
import type {
  RecordPairwiseRunEvalInput,
  RunEvalCriterionScore,
  RunEvalEvidenceChannel,
  RunEvalRecord,
  RunEvalRubricSnapshot,
} from './types.js';
import { ensureRunEvalStore } from '../run-evals.js';
import {
  assertRow,
  normalizeJsonObject,
  normalizeNonNegativeInteger,
  normalizeOptionalNonNegativeInteger,
  normalizeOptionalNonNegativeNumber,
  normalizeOptionalString,
  normalizeRequiredString,
  normalizeVerificationStatus,
} from './normalizers.js';
import { rowToRecord, type RunEvalRow } from './rows.js';

export async function recordPairwiseRunEval(input: RecordPairwiseRunEvalInput): Promise<RunEvalRecord> {
  await ensureRunEvalStore();
  const request = {
    experimentId: normalizeRequiredString(input.experimentId, 'experimentId'),
    baselineRunSpecId: normalizeRequiredString(input.baselineRunSpecId, 'baselineRunSpecId'),
    candidateRunSpecId: normalizeRequiredString(input.candidateRunSpecId, 'candidateRunSpecId'),
    rubricRevision: normalizeRequiredString(input.rubricRevision, 'rubricRevision'),
    rubricSnapshot: input.rubricSnapshot,
    verdict: input.verdict,
    human: input.human,
    judge: input.judge,
    deterministic: input.deterministic,
  };
  const validation = validateExecutionPairwiseEvalRequest(request);
  if (!validation.success) {
    throw new Error(`pairwise eval contract validation failed: ${validation.errors.map(error => error.message ?? 'invalid').join('; ')}`);
  }
  const rubric = normalizeRubric(input.rubricSnapshot, request.rubricRevision);
  await validateExperimentPair(request.experimentId, request.baselineRunSpecId, request.candidateRunSpecId);
  const human = normalizeEvidence(input.human, rubric, 'human');
  const judge = normalizeEvidence(input.judge, rubric, 'judge');
  const deterministic = normalizeEvidence(input.deterministic, rubric, 'deterministic');
  const pairId = normalizeOptionalString(input.pairId)
    ?? `run-pair-${request.experimentId}-${request.rubricRevision}-${randomUUID()}`;
  const id = normalizeOptionalString(input.id) ?? `run-pair-eval-${pairId}`;
  const verificationStatus = normalizeVerificationStatus(
    input.verificationStatus ?? deterministic?.verificationStatus,
  );
  const rows = await getDb().query<RunEvalRow>(
    `
    INSERT INTO run_evals (
      id, run_spec_id, session_id, task_run_id, provider, model, success,
      latency_ms, retry_count, tool_error_count, verification_status,
      model_cost, evaluation_kind, pair_id, experiment_id,
      baseline_run_spec_id, candidate_run_spec_id, rubric_revision,
      rubric_snapshot_json, human_evidence_json, judge_evidence_json,
      deterministic_evidence_json, pairwise_verdict, summary_json
    )
    VALUES (
      $1, $2, $3, $4, $5, $6, $7,
      $8, $9, $10, $11,
      $12, 'pairwise', $13, $14,
      $15, $16, $17,
      $18::jsonb, $19::jsonb, $20::jsonb,
      $21::jsonb, $22, $23::jsonb
    )
    RETURNING *
    `,
    [
      id,
      normalizeOptionalString(input.runSpecId) ?? request.candidateRunSpecId,
      normalizeOptionalString(input.sessionId) ?? null,
      normalizeOptionalString(input.taskRunId) ?? null,
      normalizeOptionalString(input.provider) ?? null,
      normalizeOptionalString(input.model) ?? null,
      Boolean(input.success ?? false),
      normalizeOptionalNonNegativeInteger(input.latencyMs) ?? null,
      normalizeNonNegativeInteger(input.retryCount, 0),
      normalizeNonNegativeInteger(input.toolErrorCount, 0),
      verificationStatus,
      normalizeOptionalNonNegativeNumber(input.modelCost) ?? null,
      pairId,
      request.experimentId,
      request.baselineRunSpecId,
      request.candidateRunSpecId,
      request.rubricRevision,
      JSON.stringify(rubric),
      JSON.stringify(human ?? null),
      JSON.stringify(judge ?? null),
      JSON.stringify(deterministic ?? null),
      request.verdict,
      JSON.stringify({ ...normalizeJsonObject(input.summary), kind: 'pairwise', metricSource: 'execution_projection' }),
    ],
  ).catch(error => {
    if (isUniqueViolation(error)) {
      throw new Error('pairwise evaluation already exists for this experiment, run pair, and rubric revision');
    }
    throw error;
  });
  return rowToRecord(assertRow(rows.rows[0]));
}

export async function listPairwiseRunEvals(input: string | {
  pairId?: string;
  experimentId?: string;
  verdict?: RunEvalRecord['pairwiseVerdict'];
  limit?: number;
}): Promise<RunEvalRecord[]> {
  await ensureRunEvalStore();
  const options = typeof input === 'string' ? { pairId: input } : input;
  const clauses = ["evaluation_kind = 'pairwise'"];
  const values: unknown[] = [];
  if (options.pairId?.trim()) {
    values.push(options.pairId.trim());
    clauses.push(`pair_id = $${values.length}`);
  }
  if (options.experimentId?.trim()) {
    values.push(options.experimentId.trim());
    clauses.push(`experiment_id = $${values.length}`);
  }
  if (options.verdict) {
    values.push(options.verdict);
    clauses.push(`pairwise_verdict = $${values.length}`);
  }
  const limit = Math.max(1, Math.min(500, Math.floor(options.limit ?? 100)));
  values.push(limit);
  const rows = await getDb().query<RunEvalRow>(
    `SELECT * FROM run_evals WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC, id LIMIT $${values.length}`,
    values,
  );
  return rows.rows.map(rowToRecord);
}

async function validateExperimentPair(experimentId: string, baselineRunSpecId: string, candidateRunSpecId: string): Promise<void> {
  const rows = await getDb().query<{ source_run_spec_id: string; candidate_run_spec_id: string | null }>(
    'SELECT source_run_spec_id, candidate_run_spec_id FROM execution_experiments WHERE id = $1',
    [experimentId],
  );
  const experiment = rows.rows[0];
  if (!experiment) throw new Error(`Execution experiment not found: ${experimentId}`);
  if (experiment.source_run_spec_id !== baselineRunSpecId) {
    throw new Error('baselineRunSpecId does not match the experiment source run');
  }
  if (experiment.candidate_run_spec_id !== candidateRunSpecId) {
    throw new Error('candidateRunSpecId does not match the experiment candidate run');
  }
}

function normalizeRubric(value: RunEvalRubricSnapshot, revision: string): RunEvalRubricSnapshot {
  if (!value || value.revision !== revision) throw new Error('rubricSnapshot.revision must equal rubricRevision');
  const criteria = value.criteria.map(criterion => ({
    id: normalizeRequiredString(criterion.id, 'rubric criterion id'),
    label: normalizeRequiredString(criterion.label, 'rubric criterion label'),
    description: normalizeOptionalString(criterion.description),
    maxScore: normalizePositiveNumber(criterion.maxScore, 'rubric criterion maxScore'),
  }));
  if (new Set(criteria.map(criterion => criterion.id)).size !== criteria.length) {
    throw new Error('rubric criteria ids must be unique');
  }
  return { id: normalizeRequiredString(value.id, 'rubric id'), revision, criteria };
}

function normalizeEvidence(
  value: RunEvalEvidenceChannel | undefined,
  rubric: RunEvalRubricSnapshot,
  source: 'human' | 'judge' | 'deterministic',
): RunEvalEvidenceChannel | undefined {
  if (!value) return undefined;
  const sourceLabel = normalizeRequiredString(value.source, `${source}.source`);
  const criterionIds = new Set(rubric.criteria.map(criterion => criterion.id));
  const criterionScores = value.criterionScores?.map(score => normalizeCriterionScore(score, rubric, criterionIds));
  const normalized: RunEvalEvidenceChannel = {
    source: sourceLabel,
    verdict: value.verdict,
    criterionScores,
    note: normalizeOptionalString(value.note),
    confidence: value.confidence === undefined ? undefined : normalizeBoundedNumber(value.confidence, 0, 1, `${source}.confidence`),
    verificationStatus: value.verificationStatus === undefined ? undefined : normalizeVerificationStatus(value.verificationStatus),
  };
  return Object.fromEntries(Object.entries(normalized).filter(([, item]) => item !== undefined)) as RunEvalEvidenceChannel;
}

function normalizeCriterionScore(
  score: RunEvalCriterionScore,
  rubric: RunEvalRubricSnapshot,
  criterionIds: Set<string>,
): RunEvalCriterionScore {
  const criterionId = normalizeRequiredString(score.criterionId, 'criterionScores.criterionId');
  if (!criterionIds.has(criterionId)) throw new Error(`criterion score references unknown criterion: ${criterionId}`);
  const criterion = rubric.criteria.find(item => item.id === criterionId)!;
  const normalizedScore = normalizeBoundedNumber(score.score, 0, criterion.maxScore, `criterion ${criterionId} score`);
  return { criterionId, score: normalizedScore, note: normalizeOptionalString(score.note) };
}

function normalizePositiveNumber(value: unknown, name: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be positive`);
  return parsed;
}

function normalizeBoundedNumber(value: unknown, min: number, max: number, name: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) throw new Error(`${name} must be between ${min} and ${max}`);
  return parsed;
}

function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code?: string }).code === '23505');
}
