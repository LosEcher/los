export type GovernanceJobType = 'consistency_audit' | 'hotspot' | 'architecture_drift' | 'memory_integrity' | 'memory_retention' | 'reflection' | 'branch_cleanup' | 'file_size' | 'related_project_scan' | 'supply_chain_audit' | 'static_analysis' | 'performance_audit' | 'migration_drift_fix' | 'event_retention';
export type GovernanceCadence = 'manual' | 'hourly' | 'daily' | 'weekly';
export type GovernanceJobStatus = 'active' | 'paused' | 'retired';
export type CircuitState = 'closed' | 'half_open' | 'open';

export interface GovernanceJobAutoFixConfig {
  autoFixEnabled: boolean;
  maxAutoFixAttempts?: number;
  verificationCommands?: string[];
  stopCondition?: string;
  escalationCadence?: 'immediate' | 'after_retry' | 'never';
}

export interface GaLoopPhase {
  phase: 'audit_run' | 'findings_ready' | 'fix_claimed' | 'fix_attempted' | 'verify_result' | 'completed' | 'retry' | 'escalated';
  enteredAt: string;
  attemptNumber: number;
  detail?: string;
}

export interface GaLoopResult {
  jobId: string;
  jobType: GovernanceJobType;
  auditSummary: Record<string, unknown>;
  phases: GaLoopPhase[];
  fixApplied: boolean;
  fixSucceeded: boolean;
  verificationPassed: boolean;
  retried: boolean;
  escalated: boolean;
  escalatedReason?: string;
  error?: string;
}

export interface GovernanceJob {
  id: string;
  jobType: GovernanceJobType;
  cadence: GovernanceCadence;
  status: GovernanceJobStatus;
  config: Record<string, unknown>;
  lastRunAt?: string;
  lastTaskRunId?: string;
  resultSummary?: Record<string, unknown>;
  dedupeKey?: string;
  tenantId?: string;
  projectId?: string;
  createdAt: string;
  updatedAt: string;
  autoFix?: GovernanceJobAutoFixConfig;
  consecutiveNoOps: number;
  consecutiveFailures: number;
  circuitState: CircuitState;
  /** When the circuit was last opened (ISO string), for auto-recovery timing */
  circuitOpenedAt?: string;
  /** Next scheduled run (ISO string). Used by PG-queue claim loop. */
  nextRunAt?: string;
}

export interface CreateGovernanceJobInput {
  jobType: GovernanceJobType;
  cadence?: GovernanceCadence;
  status?: GovernanceJobStatus;
  config?: Record<string, unknown>;
  autoFix?: GovernanceJobAutoFixConfig;
  dedupeKey?: string;
  tenantId?: string;
  projectId?: string;
  /** Milliseconds to add to now() for the initial next_run_at, spreading first-sweep load. */
  initialStaggerMs?: number;
}

export interface UpdateGovernanceJobInput {
  cadence?: GovernanceCadence;
  status?: GovernanceJobStatus;
  config?: Record<string, unknown>;
  autoFix?: GovernanceJobAutoFixConfig;
  lastRunAt?: string;
  lastTaskRunId?: string;
  resultSummary?: Record<string, unknown>;
  dedupeKey?: string;
  /** Next scheduled run timestamp. Set to null to clear. */
  nextRunAt?: string | null;
}

export interface UpdateGovernanceJobStateInput {
  consecutiveNoOps?: number;
  consecutiveFailures?: number;
  circuitState?: CircuitState;
  circuitOpenedAt?: string | null;
}

export interface ListGovernanceJobsOptions {
  jobType?: GovernanceJobType;
  cadence?: GovernanceCadence;
  status?: GovernanceJobStatus;
  tenantId?: string;
  projectId?: string;
  limit?: number;
}

export interface ListDueGovernanceJobsOptions {
  jobTypes?: GovernanceJobType[];
  tenantId?: string;
  projectId?: string;
  /** Override the cadence到期 threshold for testing. */
  now?: Date;
}

export interface GovernanceSweepJobResult {
  jobId: string;
  jobType: GovernanceJobType;
  summary: Record<string, unknown>;
  durationMs: number;
}

export interface GovernanceSweepResult {
  dryRun: boolean;
  jobsRun: number;
  jobsSkipped: number;
  findingsCreated: number;
  errors: string[];
  results: GovernanceSweepJobResult[];
}

export type GovernanceJobRow = {
  id: string;
  job_type: string;
  cadence: string;
  status: string;
  config_json: unknown;
  auto_fix_config_json: unknown;
  last_run_at: Date | string | null;
  last_task_run_id: string | null;
  result_summary_json: unknown;
  dedupe_key: string | null;
  tenant_id: string | null;
  project_id: string | null;
  consecutive_no_ops: number | null;
  consecutive_failures: number | null;
  circuit_state: string | null;
  circuit_opened_at: Date | string | null;
  next_run_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

export const CADENCE_THRESHOLDS: Record<Exclude<GovernanceCadence, 'manual'>, number> = {
  hourly: 55 * 60 * 1000,
  daily: 23 * 60 * 60 * 1000,
  weekly: (6.5 * 24 * 60 * 60 * 1000),
};

/**
 * Compute the next scheduled run time for a job of the given cadence.
 * Shared by the claim loop (governance-wake.ts) and the manual sweep path
 * (governance-sweeper.ts) so both reschedule identically — a manual sweep
 * that runs a job must also push next_run_at forward, otherwise the job is
 * orphaned at next_run_at=NULL and the claim loop never picks it up again.
 *
 * NOTE: Callers must pass the current timestamp as `now` to avoid Date.now()
 * (app clock) vs PostgreSQL now() (DB clock) source mismatch. The claim loop
 * (governance-wake.ts) should call getDb().now() and pass the result; the
 * manual sweep (governance-sweeper.ts) may use Date.now() as a fallback
 * since it runs on the same event loop — the skew risk is bounded.
 */
export function computeNextRunAt(cadence: GovernanceCadence, now?: Date | string | number): string {
  const ms = CADENCE_THRESHOLDS[cadence as keyof typeof CADENCE_THRESHOLDS] ?? 23 * 60 * 60 * 1000;
  const nowMs = now ? new Date(now).getTime() : Date.now();
  return new Date(nowMs + ms).toISOString();
}
