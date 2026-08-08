/**
 * Phase 2: project a single run_evals row when a run_spec reaches a terminal status.
 * Best-effort only — never throws into the execution state machine.
 */
import { getDb } from '@los/infra/db';
import { getLogger } from '@los/infra/logger';
import type { RunEvalRecord, RunEvalVerificationStatus } from './types.js';

const log = getLogger('run-evals.terminal-projection');

const TERMINAL_RUN_STATUSES = new Set(['succeeded', 'failed', 'blocked', 'cancelled']);

const TERMINAL_EVAL_ID_PREFIX = 'run-eval-terminal-';

function terminalRunEvalId(runSpecId: string): string {
  return `${TERMINAL_EVAL_ID_PREFIX}${runSpecId}`;
}

export type RecordTerminalRunEvalInput = {
  runSpecId: string;
  sessionId?: string;
  taskRunId?: string;
  status: string;
  reason?: string;
};

type RunSpecRow = {
  id: string;
  session_id: string;
  provider: string | null;
  model: string | null;
  status: string;
  created_at: string | Date;
  updated_at: string | Date;
};

type SessionMetricRow = {
  tool_error_count: string | number | null;
  retry_count: string | number | null;
  first_event_at: string | Date | null;
  last_event_at: string | Date | null;
};

type VerificationAggRow = {
  failed: string | number | null;
  pending: string | number | null;
  succeeded: string | number | null;
  required_total: string | number | null;
};

/**
 * Upsert a fleet-quality single eval for a terminal run_spec.
 * Idempotent per runSpecId (stable id). Safe to call after every terminal transition.
 */
async function recordTerminalRunEval(
  input: RecordTerminalRunEvalInput,
): Promise<RunEvalRecord | null> {
  if (!TERMINAL_RUN_STATUSES.has(input.status)) return null;
  const runSpecId = input.runSpecId?.trim();
  if (!runSpecId) return null;
  // Synthetic ledger rows used by document backlog — not real execution.
  if (runSpecId === 'eval-backlog' || runSpecId === 'manual') return null;

  try {
    const run = await loadRunSpecRow(runSpecId);
    if (!run) {
      log.warn(`terminal eval skipped: run_spec not found ${runSpecId}`);
      return null;
    }

    const sessionId = input.sessionId?.trim() || run.session_id;
    const metrics = sessionId ? await loadSessionMetrics(sessionId) : emptyMetrics();
    const verificationStatus = await loadVerificationStatus(runSpecId);
    const latencyMs = computeLatencyMs(run, metrics);
    const success = input.status === 'succeeded';
    const failureClass = success ? undefined : mapFailureClass(input.status, input.reason);

    // Dynamic import avoids circular init with run-evals.ts re-exports.
    const { recordRunEval } = await import('../run-evals.js');
    return await recordRunEval({
      id: terminalRunEvalId(runSpecId),
      runSpecId,
      sessionId,
      taskRunId: input.taskRunId,
      provider: run.provider ?? undefined,
      model: run.model ?? undefined,
      success,
      latencyMs,
      retryCount: toCount(metrics.retry_count),
      toolErrorCount: toCount(metrics.tool_error_count),
      verificationStatus,
      failureClass,
      summary: {
        kind: 'terminal_projection',
        metricSource: 'execution_projection',
        terminalStatus: input.status,
        reason: input.reason ?? null,
        recordedAt: new Date().toISOString(),
      },
    });
  } catch (error) {
    log.warn(
      `terminal eval projection failed for ${runSpecId}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

/** Fire-and-forget wrapper for the execution transition path. */
export function scheduleTerminalRunEval(input: RecordTerminalRunEvalInput): void {
  void recordTerminalRunEval(input).catch(() => undefined);
}

function mapFailureClass(status: string, reason?: string): string {
  const normalized = (reason ?? '').toLowerCase();
  if (normalized.includes('verification')) return 'verification_failed';
  if (normalized.includes('timeout')) return 'timeout';
  if (normalized.includes('policy') || normalized.includes('denied')) return 'policy_denied';
  if (normalized.includes('provider')) return 'provider_error';
  if (status === 'blocked') return 'run_blocked';
  if (status === 'cancelled') return 'run_cancelled';
  if (status === 'failed') return 'run_failed';
  return 'run_terminal';
}

/** PostgreSQL INTEGER max; clamp so pathological long-lived sessions still record. */
const MAX_LATENCY_MS = 2_147_483_647;

function computeLatencyMs(
  run: { created_at: string | Date; updated_at: string | Date },
  metrics: { first_event_at: string | Date | null; last_event_at: string | Date | null },
): number | undefined {
  const start = toTime(metrics.first_event_at) ?? toTime(run.created_at);
  const end = toTime(metrics.last_event_at) ?? toTime(run.updated_at);
  if (start === undefined || end === undefined || end < start) return undefined;
  const raw = end - start;
  if (!Number.isFinite(raw) || raw < 0) return undefined;
  return Math.min(Math.floor(raw), MAX_LATENCY_MS);
}

async function loadRunSpecRow(runSpecId: string): Promise<RunSpecRow | null> {
  const rows = await getDb().query<RunSpecRow>(
    `SELECT id, session_id, provider, model, status, created_at, updated_at
     FROM run_specs WHERE id = $1`,
    [runSpecId],
  );
  return rows.rows[0] ?? null;
}

async function loadSessionMetrics(sessionId: string): Promise<SessionMetricRow> {
  const rows = await getDb().query<SessionMetricRow>(
    `
    SELECT
      COUNT(*) FILTER (
        WHERE type = 'tool.result'
          AND (
            payload_json->>'ok' = 'false'
            OR payload_json->>'success' = 'false'
          )
      )::integer AS tool_error_count,
      COUNT(*) FILTER (
        WHERE type IN ('tool_call_state.failed', 'tool.retry', 'model.retry')
      )::integer AS retry_count,
      MIN(created_at) AS first_event_at,
      MAX(created_at) AS last_event_at
    FROM session_events
    WHERE session_id = $1
    `,
    [sessionId],
  );
  return rows.rows[0] ?? emptyMetrics();
}

async function loadVerificationStatus(runSpecId: string): Promise<RunEvalVerificationStatus> {
  const rows = await getDb().query<VerificationAggRow>(
    `
    SELECT
      COUNT(*) FILTER (WHERE required AND status = 'failed')::integer AS failed,
      COUNT(*) FILTER (WHERE required AND status IN ('pending', 'running', 'required'))::integer AS pending,
      COUNT(*) FILTER (WHERE required AND status = 'succeeded')::integer AS succeeded,
      COUNT(*) FILTER (WHERE required)::integer AS required_total
    FROM verification_records
    WHERE run_spec_id = $1
    `,
    [runSpecId],
  );
  const row = rows.rows[0];
  const failed = toCount(row?.failed);
  const pending = toCount(row?.pending);
  const requiredTotal = toCount(row?.required_total);
  if (requiredTotal === 0) return 'not_required';
  if (failed > 0) return 'failed';
  if (pending > 0) return 'pending';
  if (toCount(row?.succeeded) > 0) return 'succeeded';
  return 'unknown';
}

function emptyMetrics(): SessionMetricRow {
  return { tool_error_count: 0, retry_count: 0, first_event_at: null, last_event_at: null };
}

function toCount(value: string | number | null | undefined): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function toTime(value: string | Date | null | undefined): number | undefined {
  if (value == null) return undefined;
  const ms = value instanceof Date ? value.getTime() : Date.parse(String(value));
  return Number.isFinite(ms) ? ms : undefined;
}
