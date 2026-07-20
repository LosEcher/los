import type { RunEvalRecord, RunEvalSummary, RunEvalSummaryGroup, RunEvalEvidenceChannel, RunEvalRubricSnapshot } from './types.js';
import { normalizeCount, normalizeFloat, normalizeOptionalFloat, normalizeFailoverScope, normalizeJsonObject, normalizeVerificationStatus, toIsoString } from './normalizers.js';

export type RunEvalRow = {
  id: string;
  run_spec_id: string;
  session_id: string | null;
  task_run_id: string | null;
  provider: string | null;
  model: string | null;
  success: boolean;
  latency_ms: number | null;
  retry_count: number;
  tool_error_count: number;
  verification_status: string;
  model_cost: string | number | null;
  user_feedback: string | null;
  failure_class: string | null;
  failover_scope: string | null;
  evaluation_kind: string;
  pair_id: string | null;
  experiment_id: string | null;
  baseline_run_spec_id: string | null;
  candidate_run_spec_id: string | null;
  rubric_revision: string | null;
  rubric_snapshot_json: unknown;
  human_evidence_json: unknown;
  judge_evidence_json: unknown;
  deterministic_evidence_json: unknown;
  pairwise_verdict: string | null;
  summary_json: unknown;
  created_at: Date | string;
  updated_at: Date | string;
};

export type RunEvalAggregateRow = {
  count: string | number | null;
  success_count: string | number | null;
  failure_count: string | number | null;
  average_latency_ms: string | number | null;
  average_retry_count: string | number | null;
  tool_error_count: string | number | null;
  model_cost: string | number | null;
};

export type RunEvalSummaryGroupRow = RunEvalAggregateRow & {
  key: string | null;
};

export function rowToRecord(row: RunEvalRow): RunEvalRecord {
  return {
    id: row.id,
    runSpecId: row.run_spec_id,
    sessionId: row.session_id ?? undefined,
    taskRunId: row.task_run_id ?? undefined,
    provider: row.provider ?? undefined,
    model: row.model ?? undefined,
    success: row.success,
    latencyMs: row.latency_ms ?? undefined,
    retryCount: row.retry_count,
    toolErrorCount: row.tool_error_count,
    verificationStatus: normalizeVerificationStatus(row.verification_status),
    modelCost: row.model_cost === null ? undefined : Number(row.model_cost),
    userFeedback: row.user_feedback ?? undefined,
    failureClass: row.failure_class ?? undefined,
    failoverScope: normalizeFailoverScope(row.failover_scope) ?? undefined,
    evaluationKind: row.evaluation_kind === 'pairwise' ? 'pairwise' : 'single',
    pairId: row.pair_id ?? undefined,
    experimentId: row.experiment_id ?? undefined,
    baselineRunSpecId: row.baseline_run_spec_id ?? undefined,
    candidateRunSpecId: row.candidate_run_spec_id ?? undefined,
    rubricRevision: row.rubric_revision ?? undefined,
    rubricSnapshot: normalizeOptionalJsonObject(row.rubric_snapshot_json) as RunEvalRubricSnapshot | undefined,
    human: normalizeOptionalJsonObject(row.human_evidence_json) as RunEvalEvidenceChannel | undefined,
    judge: normalizeOptionalJsonObject(row.judge_evidence_json) as RunEvalEvidenceChannel | undefined,
    deterministic: normalizeOptionalJsonObject(row.deterministic_evidence_json) as RunEvalEvidenceChannel | undefined,
    pairwiseVerdict: normalizePairwiseVerdict(row.pairwise_verdict),
    summary: normalizeJsonObject(row.summary_json),
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

function normalizeOptionalJsonObject(value: unknown): Record<string, unknown> | undefined {
  const normalized = normalizeJsonObject(value);
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function normalizePairwiseVerdict(value: unknown): RunEvalRecord['pairwiseVerdict'] {
  return value === 'baseline' || value === 'candidate' || value === 'tie' || value === 'inconclusive'
    ? value
    : undefined;
}

export function aggregateRowToTotals(row: RunEvalAggregateRow | undefined): RunEvalSummary['totals'] {
  const count = normalizeCount(row?.count);
  const successCount = normalizeCount(row?.success_count);
  const failureCount = normalizeCount(row?.failure_count);
  return {
    count,
    successCount,
    failureCount,
    successRate: count > 0 ? successCount / count : 0,
    averageLatencyMs: normalizeOptionalFloat(row?.average_latency_ms),
    averageRetryCount: normalizeFloat(row?.average_retry_count),
    toolErrorCount: normalizeCount(row?.tool_error_count),
    modelCost: normalizeFloat(row?.model_cost),
  };
}

export function rowToSummaryGroup(row: RunEvalSummaryGroupRow): RunEvalSummaryGroup {
  const count = normalizeCount(row.count);
  const successCount = normalizeCount(row.success_count);
  return {
    key: row.key ?? 'unknown',
    count,
    successCount,
    failureCount: normalizeCount(row.failure_count),
    successRate: count > 0 ? successCount / count : 0,
    averageLatencyMs: normalizeOptionalFloat(row.average_latency_ms),
    averageRetryCount: normalizeFloat(row.average_retry_count),
    toolErrorCount: normalizeCount(row.tool_error_count),
    modelCost: normalizeFloat(row.model_cost),
  };
}
