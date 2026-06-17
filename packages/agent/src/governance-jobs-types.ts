export type GovernanceJobType = 'consistency_audit' | 'hotspot' | 'architecture_drift' | 'memory_integrity' | 'memory_retention';
export type GovernanceCadence = 'manual' | 'hourly' | 'daily' | 'weekly';
export type GovernanceJobStatus = 'active' | 'paused' | 'retired';

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
}

export interface CreateGovernanceJobInput {
  jobType: GovernanceJobType;
  cadence?: GovernanceCadence;
  status?: GovernanceJobStatus;
  config?: Record<string, unknown>;
  dedupeKey?: string;
  tenantId?: string;
  projectId?: string;
}

export interface UpdateGovernanceJobInput {
  cadence?: GovernanceCadence;
  status?: GovernanceJobStatus;
  config?: Record<string, unknown>;
  lastRunAt?: string;
  lastTaskRunId?: string;
  resultSummary?: Record<string, unknown>;
  dedupeKey?: string;
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
  last_run_at: Date | string | null;
  last_task_run_id: string | null;
  result_summary_json: unknown;
  dedupe_key: string | null;
  tenant_id: string | null;
  project_id: string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

export const CADENCE_THRESHOLDS: Record<Exclude<GovernanceCadence, 'manual'>, number> = {
  hourly: 55 * 60 * 1000,
  daily: 23 * 60 * 60 * 1000,
  weekly: (6.5 * 24 * 60 * 60 * 1000),
};
