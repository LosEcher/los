import { randomUUID } from 'node:crypto';
import { getDb } from '@los/infra/db';
import { RUN_EVAL_SCHEMA } from './run-evals/schema.js';
import type {
  CompareRunEvalsOptions,
  ListRunEvalsOptions,
  RecordRunEvalInput,
  RunEvalComparison,
  RunEvalFailoverScope,
  RunEvalRecord,
  RunEvalSummary,
  RunEvalVerificationStatus,
  SummarizeRunEvalsOptions,
} from './run-evals/types.js';

export type {
  CompareRunEvalsOptions,
  ListRunEvalsOptions,
  RecordRunEvalInput,
  RunEvalComparison,
  RunEvalFailoverScope,
  RunEvalRecord,
  RunEvalSummary,
  RunEvalSummaryGroup,
  RunEvalVerificationStatus,
  SummarizeRunEvalsOptions,
} from './run-evals/types.js';

import {
  addOptionalClause,
  assertRow,
  normalizeFailoverScope,
  normalizeJsonObject,
  normalizeLimit,
  normalizeNonNegativeInteger,
  normalizeOptionalIsoLike,
  normalizeOptionalNonNegativeInteger,
  normalizeOptionalNonNegativeNumber,
  normalizeOptionalString,
  normalizeRequiredIsoLike,
  normalizeRequiredString,
  normalizeVerificationStatus,
  toIsoString,
} from './run-evals/normalizers.js';
import {
  aggregateRowToTotals,
  rowToRecord,
  rowToSummaryGroup,
  type RunEvalAggregateRow,
  type RunEvalRow,
  type RunEvalSummaryGroupRow,
} from './run-evals/rows.js';

let _initialized = false;

export async function ensureRunEvalStore(): Promise<void> {
  if (_initialized) return;
  await getDb().exec(RUN_EVAL_SCHEMA);
  _initialized = true;
}

export async function recordRunEval(input: RecordRunEvalInput): Promise<RunEvalRecord> {
  await ensureRunEvalStore();
  const runSpecId = normalizeRequiredString(input.runSpecId, 'runSpecId');
  const id = normalizeOptionalString(input.id)
    ?? `run-eval-${runSpecId}-${randomUUID()}`;
  const rows = await getDb().query<RunEvalRow>(
    `
    INSERT INTO run_evals (
      id, run_spec_id, session_id, task_run_id, provider, model, success,
      latency_ms, retry_count, tool_error_count, verification_status,
      model_cost, user_feedback, failure_class, failover_scope, summary_json
    )
    VALUES (
      $1, $2, $3, $4, $5, $6, $7,
      $8, $9, $10, $11,
      $12, $13, $14, $15, $16::jsonb
    )
    ON CONFLICT (id) DO UPDATE SET
      run_spec_id = EXCLUDED.run_spec_id,
      session_id = EXCLUDED.session_id,
      task_run_id = EXCLUDED.task_run_id,
      provider = EXCLUDED.provider,
      model = EXCLUDED.model,
      success = EXCLUDED.success,
      latency_ms = EXCLUDED.latency_ms,
      retry_count = EXCLUDED.retry_count,
      tool_error_count = EXCLUDED.tool_error_count,
      verification_status = EXCLUDED.verification_status,
      model_cost = EXCLUDED.model_cost,
      user_feedback = EXCLUDED.user_feedback,
      failure_class = EXCLUDED.failure_class,
      failover_scope = EXCLUDED.failover_scope,
      summary_json = EXCLUDED.summary_json,
      updated_at = now()
    RETURNING *
  `,
    [
      id,
      runSpecId,
      normalizeOptionalString(input.sessionId) ?? null,
      normalizeOptionalString(input.taskRunId) ?? null,
      normalizeOptionalString(input.provider) ?? null,
      normalizeOptionalString(input.model) ?? null,
      Boolean(input.success),
      normalizeOptionalNonNegativeInteger(input.latencyMs) ?? null,
      normalizeNonNegativeInteger(input.retryCount, 0),
      normalizeNonNegativeInteger(input.toolErrorCount, 0),
      normalizeVerificationStatus(input.verificationStatus),
      normalizeOptionalNonNegativeNumber(input.modelCost) ?? null,
      normalizeOptionalString(input.userFeedback) ?? null,
      normalizeOptionalString(input.failureClass) ?? null,
      normalizeFailoverScope(input.failoverScope),
      JSON.stringify(normalizeJsonObject(input.summary)),
    ],
  );
  return rowToRecord(assertRow(rows.rows[0]));
}

export async function recordFailoverEval(input: {
  runSpecId: string;
  sessionId?: string;
  taskRunId?: string;
  provider?: string;
  model?: string;
  failureClass?: string;
  failoverScope: RunEvalFailoverScope;
  errorMessage?: string;
}): Promise<void> {
  await recordRunEval({
    id: `failover-eval-${input.runSpecId}-${randomUUID()}`,
    runSpecId: input.runSpecId,
    sessionId: input.sessionId,
    taskRunId: input.taskRunId,
    provider: input.provider,
    model: input.model,
    success: false,
    failureClass: input.failureClass ?? 'failover_error',
    failoverScope: input.failoverScope,
    summary: {
      kind: 'failover',
      scope: input.failoverScope,
      error: input.errorMessage ?? null,
      recordedAt: new Date().toISOString(),
    },
  }).catch(() => undefined);
}

export async function listRunEvals(options: ListRunEvalsOptions = {}): Promise<RunEvalRecord[]> {
  await ensureRunEvalStore();
  const { where, params } = buildRunEvalFilter(options);
  params.push(normalizeLimit(options.limit));
  const rows = await getDb().query<RunEvalRow>(
    `
    SELECT *
    FROM run_evals
    ${where}
    ORDER BY created_at DESC, id
    LIMIT $${params.length}
  `,
    params,
  );
  return rows.rows.map(rowToRecord);
}

export async function summarizeRunEvals(options: SummarizeRunEvalsOptions = {}): Promise<RunEvalSummary> {
  await ensureRunEvalStore();
  const normalized = normalizeSummaryOptions(options);
  const { where, params } = buildRunEvalFilter(normalized);
  const limit = normalizeLimit(normalized.limit);
  const [totals, byFailureClass, byFailoverScope, byVerificationStatus, byProviderModel] = await Promise.all([
    getDb().query<RunEvalAggregateRow>(`
      SELECT
        COUNT(*)::integer AS count,
        COUNT(*) FILTER (WHERE success)::integer AS success_count,
        COUNT(*) FILTER (WHERE NOT success)::integer AS failure_count,
        AVG(latency_ms)::float AS average_latency_ms,
        AVG(retry_count)::float AS average_retry_count,
        COALESCE(SUM(tool_error_count), 0)::integer AS tool_error_count,
        COALESCE(SUM(model_cost), 0)::float AS model_cost
      FROM run_evals
      ${where}
    `, params),
    querySummaryGroups({ selectKey: `COALESCE(failure_class, 'unclassified')`, where, params, limit, failuresOnly: true }),
    querySummaryGroups({ selectKey: `COALESCE(failover_scope, 'unspecified')`, where, params, limit }),
    querySummaryGroups({ selectKey: 'verification_status', where, params, limit }),
    querySummaryGroups({ selectKey: `COALESCE(provider, 'unknown') || ':' || COALESCE(model, 'unknown')`, where, params, limit }),
  ]);
  return {
    filters: {
      runSpecId: normalized.runSpecId,
      sessionId: normalized.sessionId,
      taskRunId: normalized.taskRunId,
      provider: normalized.provider,
      model: normalized.model,
      success: normalized.success,
      verificationStatus: normalized.verificationStatus,
      failureClass: normalized.failureClass,
      failoverScope: normalized.failoverScope,
      createdFrom: normalized.createdFrom,
      createdTo: normalized.createdTo,
    },
    totals: aggregateRowToTotals(totals.rows[0]),
    byFailureClass,
    byFailoverScope,
    byVerificationStatus,
    byProviderModel,
  };
}

export async function compareRunEvals(options: CompareRunEvalsOptions): Promise<RunEvalComparison> {
  const normalized = normalizeCompareOptions(options);
  const shared: SummarizeRunEvalsOptions = {
    runSpecId: normalized.runSpecId,
    sessionId: normalized.sessionId,
    taskRunId: normalized.taskRunId,
    provider: normalized.provider,
    model: normalized.model,
    success: normalized.success,
    verificationStatus: normalized.verificationStatus,
    failureClass: normalized.failureClass,
    limit: normalized.limit,
  };
  const [baseline, candidate] = await Promise.all([
    summarizeRunEvals({ ...shared, createdFrom: normalized.baselineFrom, createdTo: normalized.baselineTo }),
    summarizeRunEvals({ ...shared, createdFrom: normalized.candidateFrom, createdTo: normalized.candidateTo }),
  ]);
  return {
    filters: {
      runSpecId: shared.runSpecId,
      sessionId: shared.sessionId,
      taskRunId: shared.taskRunId,
      provider: shared.provider,
      model: shared.model,
      success: shared.success,
      verificationStatus: shared.verificationStatus,
      failureClass: shared.failureClass,
    },
    baseline,
    candidate,
    delta: {
      count: candidate.totals.count - baseline.totals.count,
      successCount: candidate.totals.successCount - baseline.totals.successCount,
      failureCount: candidate.totals.failureCount - baseline.totals.failureCount,
      successRate: candidate.totals.successRate - baseline.totals.successRate,
      averageLatencyMs: subtractOptional(candidate.totals.averageLatencyMs, baseline.totals.averageLatencyMs),
      averageRetryCount: candidate.totals.averageRetryCount - baseline.totals.averageRetryCount,
      toolErrorCount: candidate.totals.toolErrorCount - baseline.totals.toolErrorCount,
      modelCost: candidate.totals.modelCost - baseline.totals.modelCost,
    },
  };
}

async function querySummaryGroups(input: {
  selectKey: string;
  where: string;
  params: unknown[];
  limit: number;
  failuresOnly?: boolean;
}): Promise<import('./run-evals/types.js').RunEvalSummaryGroup[]> {
  const clauses = input.where ? [input.where.replace(/^WHERE\s+/i, '')] : [];
  const params = [...input.params];
  if (input.failuresOnly) clauses.push('success = false');
  params.push(input.limit);
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = await getDb().query<RunEvalSummaryGroupRow>(`
    SELECT
      ${input.selectKey} AS key,
      COUNT(*)::integer AS count,
      COUNT(*) FILTER (WHERE success)::integer AS success_count,
      COUNT(*) FILTER (WHERE NOT success)::integer AS failure_count,
      AVG(latency_ms)::float AS average_latency_ms,
      AVG(retry_count)::float AS average_retry_count,
      COALESCE(SUM(tool_error_count), 0)::integer AS tool_error_count,
      COALESCE(SUM(model_cost), 0)::float AS model_cost
    FROM run_evals
    ${where}
    GROUP BY 1
    ORDER BY count DESC, key ASC
    LIMIT $${params.length}
  `, params);
  return rows.rows.map(rowToSummaryGroup);
}

function buildRunEvalFilter(options: SummarizeRunEvalsOptions): { where: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  addOptionalClause(clauses, params, 'run_spec_id', normalizeOptionalString(options.runSpecId));
  addOptionalClause(clauses, params, 'session_id', normalizeOptionalString(options.sessionId));
  addOptionalClause(clauses, params, 'task_run_id', normalizeOptionalString(options.taskRunId));
  addOptionalClause(clauses, params, 'provider', normalizeOptionalString(options.provider));
  addOptionalClause(clauses, params, 'model', normalizeOptionalString(options.model));
  addOptionalClause(clauses, params, 'verification_status', normalizeOptionalString(options.verificationStatus));
  addOptionalClause(clauses, params, 'failure_class', normalizeOptionalString(options.failureClass));
  addOptionalClause(clauses, params, 'failover_scope', normalizeFailoverScope(options.failoverScope));
  if (typeof options.success === 'boolean') {
    params.push(options.success);
    clauses.push(`success = $${params.length}`);
  }
  const createdFrom = normalizeOptionalIsoLike(options.createdFrom, 'createdFrom');
  if (createdFrom) {
    params.push(createdFrom);
    clauses.push(`created_at >= $${params.length}::timestamptz`);
  }
  const createdTo = normalizeOptionalIsoLike(options.createdTo, 'createdTo');
  if (createdTo) {
    params.push(createdTo);
    clauses.push(`created_at <= $${params.length}::timestamptz`);
  }
  return { where: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

function normalizeSummaryOptions(options: SummarizeRunEvalsOptions): SummarizeRunEvalsOptions {
  return {
    runSpecId: normalizeOptionalString(options.runSpecId),
    sessionId: normalizeOptionalString(options.sessionId),
    taskRunId: normalizeOptionalString(options.taskRunId),
    provider: normalizeOptionalString(options.provider),
    model: normalizeOptionalString(options.model),
    success: options.success,
    verificationStatus: normalizeOptionalString(options.verificationStatus),
    failureClass: normalizeOptionalString(options.failureClass),
    failoverScope: normalizeFailoverScope(options.failoverScope),
    createdFrom: normalizeOptionalIsoLike(options.createdFrom, 'createdFrom'),
    createdTo: normalizeOptionalIsoLike(options.createdTo, 'createdTo'),
    limit: normalizeLimit(options.limit),
  };
}

function normalizeCompareOptions(options: CompareRunEvalsOptions): CompareRunEvalsOptions {
  const baselineFrom = normalizeRequiredIsoLike(options.baselineFrom, 'baselineFrom');
  const baselineTo = normalizeRequiredIsoLike(options.baselineTo, 'baselineTo');
  const candidateFrom = normalizeRequiredIsoLike(options.candidateFrom, 'candidateFrom');
  const candidateTo = normalizeRequiredIsoLike(options.candidateTo, 'candidateTo');
  if (new Date(baselineFrom).getTime() > new Date(baselineTo).getTime()) {
    throw new Error('baselineFrom must be before or equal to baselineTo');
  }
  if (new Date(candidateFrom).getTime() > new Date(candidateTo).getTime()) {
    throw new Error('candidateFrom must be before or equal to candidateTo');
  }
  return {
    runSpecId: normalizeOptionalString(options.runSpecId),
    sessionId: normalizeOptionalString(options.sessionId),
    taskRunId: normalizeOptionalString(options.taskRunId),
    provider: normalizeOptionalString(options.provider),
    model: normalizeOptionalString(options.model),
    success: options.success,
    verificationStatus: normalizeOptionalString(options.verificationStatus),
    failureClass: normalizeOptionalString(options.failureClass),
    baselineFrom, baselineTo, candidateFrom, candidateTo,
    limit: normalizeLimit(options.limit),
  };
}

function subtractOptional(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined || right === undefined) return undefined;
  return left - right;
}
