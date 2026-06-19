import type { GovernanceJob, GovernanceJobType, GovernanceCadence, GovernanceJobStatus, GovernanceJobAutoFixConfig, CircuitState, GovernanceJobRow } from './governance-jobs-types.js';

function normalizeJobType(value: string): GovernanceJobType {
  const valid: GovernanceJobType[] = ['consistency_audit', 'hotspot', 'architecture_drift', 'memory_integrity', 'memory_retention', 'reflection', 'branch_cleanup', 'file_size', 'related_project_scan'];
  return valid.includes(value as GovernanceJobType) ? (value as GovernanceJobType) : 'consistency_audit';
}

function normalizeCadence(value: string): GovernanceCadence {
  const valid: GovernanceCadence[] = ['manual', 'hourly', 'daily', 'weekly'];
  return valid.includes(value as GovernanceCadence) ? (value as GovernanceCadence) : 'manual';
}

function normalizeJobStatus(value: string): GovernanceJobStatus {
  const valid: GovernanceJobStatus[] = ['active', 'paused', 'retired'];
  return valid.includes(value as GovernanceJobStatus) ? (value as GovernanceJobStatus) : 'active';
}

function normalizeCircuitState(value: string | null): CircuitState {
  const valid: CircuitState[] = ['closed', 'half_open', 'open'];
  if (value && valid.includes(value as CircuitState)) return value as CircuitState;
  return 'closed';
}

function normalizeJsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    } catch { return {}; }
  }
  return {};
}

export function normalizeLimit(value: unknown): number {
  const parsed = Number(value ?? 100);
  if (!Number.isFinite(parsed) || parsed <= 0) return 100;
  return Math.max(1, Math.min(1000, Math.floor(parsed)));
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function assertRow<T>(row: T | undefined): T {
  if (!row) throw new Error('governance_jobs write returned no row');
  return row;
}

export function rowToJob(row: GovernanceJobRow): GovernanceJob {
  let autoFix: GovernanceJobAutoFixConfig | undefined;
  if (row.auto_fix_config_json) {
    const parsed = normalizeJsonObject(row.auto_fix_config_json);
    if (typeof parsed.autoFixEnabled === 'boolean') {
      autoFix = {
        autoFixEnabled: parsed.autoFixEnabled,
        maxAutoFixAttempts: typeof parsed.maxAutoFixAttempts === 'number' ? parsed.maxAutoFixAttempts : undefined,
        verificationCommands: Array.isArray(parsed.verificationCommands) ? parsed.verificationCommands.filter((v: unknown): v is string => typeof v === 'string') : undefined,
        stopCondition: typeof parsed.stopCondition === 'string' ? parsed.stopCondition : undefined,
        escalationCadence: typeof parsed.escalationCadence === 'string' ? parsed.escalationCadence as GovernanceJobAutoFixConfig['escalationCadence'] : undefined,
      };
    }
  }

  return {
    id: row.id,
    jobType: normalizeJobType(row.job_type),
    cadence: normalizeCadence(row.cadence),
    status: normalizeJobStatus(row.status),
    config: normalizeJsonObject(row.config_json),
    lastRunAt: row.last_run_at ? toIsoString(row.last_run_at) : undefined,
    lastTaskRunId: row.last_task_run_id ?? undefined,
    resultSummary: row.result_summary_json
      ? normalizeJsonObject(row.result_summary_json)
      : undefined,
    dedupeKey: row.dedupe_key ?? undefined,
    tenantId: row.tenant_id ?? undefined,
    projectId: row.project_id ?? undefined,
    autoFix,
    consecutiveNoOps: typeof row.consecutive_no_ops === 'number' ? row.consecutive_no_ops : 0,
    consecutiveFailures: typeof row.consecutive_failures === 'number' ? row.consecutive_failures : 0,
    circuitState: normalizeCircuitState(row.circuit_state ?? null),
    circuitOpenedAt: row.circuit_opened_at ? toIsoString(row.circuit_opened_at) : undefined,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}
