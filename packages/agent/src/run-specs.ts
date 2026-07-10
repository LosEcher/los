/**
 * @los/agent/run-specs — Durable execution contracts.
 *
 * A run_spec captures the COMPLETE execution contract for an agent run:
 * prompt, provider, model, tool mode, workspace, etc.
 *
 * task_runs represent ATTEMPTS to fulfill a run_spec.
 * One run_spec can have multiple task_runs (for retries, failover, replay).
 */

import { getDb, withDbClient } from '@los/infra/db';
import {
  normalizeRunContractMetadata,
  shouldSkipPlanApprovalGate,
  validatePhaseTransition,
  type PlanStep,
  type RunContractMetadata,
  type RunContractMetadataInput,
  type RunPhase,
} from './run-contract.js';
import {
  normalizePlanForPersistence,
  validatePlanForApproval,
  validatePlanRevisionPhase,
  validateVerificationExecutionSupport,
  validateVerificationMappingForApproval,
} from './run-plan-validation.js';
import {
  ensureExecutionOutboxStore,
  insertExecutionOutbox,
  insertSessionEvent,
} from './execution-persistence.js';
import { ensureSessionEventStore } from './session-events.js';
import {
  ensureVerificationRecordStore,
  replaceVerificationRequirementsForRunSpec,
  seedVerificationRequirementsForRunSpec,
} from './verification-records.js';

// ── Types ───────────────────────────────────────────────

export type RunSpecStatus = 'created' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'blocked';

export interface RunSpecRecord {
  id: string;
  sessionId: string;
  tenantId?: string;
  projectId?: string;
  userId?: string;
  nodeId?: string;
  requestId?: string;
  traceId?: string;
  gatewayId?: string;
  prompt: string;
  systemPrompt?: string;
  provider?: string;
  model?: string;
  modelSettings: Record<string, unknown>;
  workspaceRoot: string;
  toolMode: string;
  allowedTools: string[];
  toolRetry: Record<string, unknown>;
  maxLoops: number;
  timeoutMs?: number;
  mcpServers: Array<{ command: string; args?: string[]; env?: Record<string, string> }>;
  runContract?: RunContractMetadata;
  status: RunSpecStatus;
  createdAt: string;
  updatedAt: string;
}

export interface CreateRunSpecInput {
  id: string;
  sessionId: string;
  tenantId?: string;
  projectId?: string;
  userId?: string;
  nodeId?: string;
  requestId?: string;
  traceId?: string;
  gatewayId?: string;
  prompt: string;
  systemPrompt?: string;
  provider?: string;
  model?: string;
  modelSettings?: Record<string, unknown>;
  workspaceRoot: string;
  toolMode: string;
  allowedTools?: string[];
  toolRetry?: Record<string, unknown>;
  maxLoops?: number;
  timeoutMs?: number;
  mcpServers?: Array<{ command: string; args?: string[]; env?: Record<string, string> }>;
  runContract?: RunContractMetadataInput;
}

// ── Schema ──────────────────────────────────────────────

const SCHEMA = `
CREATE TABLE IF NOT EXISTS run_specs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  tenant_id TEXT,
  project_id TEXT,
  user_id TEXT,
  node_id TEXT,
  request_id TEXT,
  trace_id TEXT,
  prompt TEXT NOT NULL,
  system_prompt TEXT,
  provider TEXT,
  model TEXT,
  model_settings_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  workspace_root TEXT NOT NULL,
  tool_mode TEXT NOT NULL,
  allowed_tools_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  tool_retry_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  max_loops INTEGER NOT NULL DEFAULT 20,
  timeout_ms INTEGER,
  mcp_servers_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  run_contract_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  gateway_id TEXT,
  status TEXT NOT NULL DEFAULT 'created',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE run_specs ADD COLUMN IF NOT EXISTS run_contract_json JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE run_specs ADD COLUMN IF NOT EXISTS gateway_id TEXT;

CREATE INDEX IF NOT EXISTS idx_run_specs_session_id ON run_specs(session_id);
CREATE INDEX IF NOT EXISTS idx_run_specs_status ON run_specs(status);
CREATE INDEX IF NOT EXISTS idx_run_specs_tenant_project ON run_specs(tenant_id, project_id);
CREATE INDEX IF NOT EXISTS idx_run_specs_request_id ON run_specs(request_id);
CREATE INDEX IF NOT EXISTS idx_run_specs_trace_id ON run_specs(trace_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'run_specs_status_chk'
      AND conrelid = 'run_specs'::regclass
  ) THEN
    ALTER TABLE run_specs
      ADD CONSTRAINT run_specs_status_chk
      CHECK (status IN ('created', 'running', 'succeeded', 'failed', 'cancelled', 'blocked'))
      NOT VALID;
  END IF;
END $$;
`;

let _initialized = false;

export async function ensureRunSpecStore(): Promise<void> {
  if (_initialized) return;
  const db = getDb();
  await db.exec(SCHEMA);
  _initialized = true;
}

// ── CRUD ────────────────────────────────────────────────

export async function createRunSpec(input: CreateRunSpecInput): Promise<RunSpecRecord> {
  await ensureRunSpecStore();
  const db = getDb();
  const runContract = normalizeRunContractMetadata(input.runContract);
  const rows = await db.query<RunSpecRow>(
    `
    INSERT INTO run_specs (
      id, session_id, tenant_id, project_id, user_id, node_id,
      request_id, trace_id, prompt, system_prompt, provider, model,
      model_settings_json, workspace_root, tool_mode, allowed_tools_json,
      tool_retry_json, max_loops, timeout_ms, mcp_servers_json, run_contract_json, gateway_id, status
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14, $15, $16::jsonb, $17::jsonb, $18, $19, $20::jsonb, $21::jsonb, $22, 'created')
    RETURNING *
  `,
    [
      input.id,
      input.sessionId,
      input.tenantId ?? null,
      input.projectId ?? null,
      input.userId ?? null,
      input.nodeId ?? null,
      input.requestId ?? null,
      input.traceId ?? null,
      input.prompt,
      input.systemPrompt ?? null,
      input.provider ?? null,
      input.model ?? null,
      JSON.stringify(input.modelSettings ?? {}),
      input.workspaceRoot,
      input.toolMode,
      JSON.stringify(input.allowedTools ?? []),
      JSON.stringify(input.toolRetry ?? {}),
      input.maxLoops ?? 20,
      input.timeoutMs ?? null,
      JSON.stringify(input.mcpServers ?? []),
      JSON.stringify(runContract ?? {}),
      input.gatewayId ?? null,
    ],
  );
  const record = rowToRecord(assertRow(rows.rows[0]));
  await seedVerificationRequirementsForRunSpec({
    runSpecId: record.id,
    sessionId: record.sessionId,
    planRevision: runContract?.planRevision ?? 1,
    requiredChecks: runContract?.requiredChecks,
    verifications: runContract?.verifications,
  });
  return record;
}

export async function loadRunSpec(id: string): Promise<RunSpecRecord | null> {
  await ensureRunSpecStore();
  const db = getDb();
  const rows = await db.query<RunSpecRow>('SELECT * FROM run_specs WHERE id = $1', [id]);
  return rows.rows[0] ? rowToRecord(rows.rows[0]) : null;
}

export async function listRunSpecs(limit = 50): Promise<RunSpecRecord[]> {
  await ensureRunSpecStore();
  const db = getDb();
  const rows = await db.query<RunSpecRow>(
    'SELECT * FROM run_specs ORDER BY updated_at DESC LIMIT $1',
    [limit],
  );
  return rows.rows.map(rowToRecord);
}

export async function listRunSpecsForSession(sessionId: string, limit = 20): Promise<RunSpecRecord[]> {
  await ensureRunSpecStore();
  const db = getDb();
  const rows = await db.query<RunSpecRow>(
    'SELECT * FROM run_specs WHERE session_id = $1 ORDER BY updated_at DESC LIMIT $2',
    [sessionId, limit],
  );
  return rows.rows.map(rowToRecord);
}

export async function claimRunSpec(runSpecId: string, gatewayId: string): Promise<RunSpecRecord | null> {
  await ensureRunSpecStore();
  const db = getDb();
  const rows = await db.query<RunSpecRow>(
    `UPDATE run_specs
     SET gateway_id = $1, updated_at = now()
     WHERE id = $2 AND gateway_id IS DISTINCT FROM $1
     RETURNING *`,
    [gatewayId, runSpecId],
  );
  return rows.rows[0] ? rowToRecord(rows.rows[0]) : null;
}

/**
 * Approve a run spec's phase transition to `plan_approved`.
 *
 * Validates the current phase → plan_approved transition, persists the new
 * phase in run_contract_json, and records an operator approval session event.
 *
 * Returns the updated run spec record, or throws on invalid transition.
 */
export async function approveRunSpecPhase(
  id: string,
  opts: { plan?: PlanStep[]; actor?: string; reason?: string } = {},
): Promise<RunSpecRecord> {
  await ensureRunSpecStore();
  await Promise.all([ensureSessionEventStore(), ensureExecutionOutboxStore()]);
  const result = await withDbClient(async (client) => {
    await client.query('BEGIN');
    try {
      const rows = await client.query<RunSpecRow>('SELECT * FROM run_specs WHERE id = $1 FOR UPDATE', [id]);
      const row = rows.rows[0];
      const record = row ? rowToRecord(row) : null;
      if (!record) throw new Error(`Run spec not found: ${id}`);
      const currentRawContract = normalizeJsonObject(row!.run_contract_json);
      const currentContract = completeRunContract(record.runContract);
      const currentPhase = currentContract.phase;
      const targetPhase: RunPhase = 'plan_approved';
      const phaseError = validatePhaseTransition(currentPhase, targetPhase);
      if (phaseError) throw new Error(phaseError);
      const plan = opts.plan ?? currentContract.plan;
      if (!shouldSkipPlanApprovalGate(currentContract)) {
        const planError = validatePlanForApproval(plan);
        if (planError) throw new Error(planError);
        const verificationError = validateVerificationMappingForApproval(currentContract);
        if (verificationError) throw new Error(verificationError);
      }
      const supportError = validateVerificationExecutionSupport(currentContract);
      if (supportError) throw new Error(supportError);
      const now = new Date().toISOString();
      const approvalPatch: Record<string, unknown> = {
        phase: targetPhase,
        previousPhase: currentPhase,
        phaseChangedAt: now,
      };
      if (opts.plan) approvalPatch.plan = normalizePlanForPersistence(opts.plan);
      const updatedRows = await client.query<RunSpecRow>(
        'UPDATE run_specs SET run_contract_json = run_contract_json || $2::jsonb, updated_at = now() WHERE id = $1 RETURNING *',
        [id, JSON.stringify(approvalPatch)],
      );
      const updatedRecord = rowToRecord(assertRow(updatedRows.rows[0]));
      const updatedContract = completeRunContract(updatedRecord.runContract ?? normalizeRunContractMetadata({
        ...currentRawContract,
        ...approvalPatch,
      }));
      const event = await insertSessionEvent(client, {
        sessionId: record.sessionId,
        tenantId: record.tenantId,
        projectId: record.projectId,
        userId: record.userId,
        nodeId: record.nodeId,
        requestId: record.requestId,
        traceId: record.traceId,
        type: 'run.plan_approved',
        source: 'operator',
        payload: {
          runSpecId: id,
          previousPhase: currentPhase ?? null,
          phase: targetPhase,
          actor: opts.actor ?? null,
          reason: opts.reason ?? null,
          approvedAt: now,
          planRevision: updatedContract.planRevision ?? null,
          planStepCount: updatedContract.plan?.length ?? 0,
        },
      });
      await insertExecutionOutbox(client, {
        sessionId: record.sessionId,
        runSpecId: id,
        entityType: 'run_spec',
        entityId: id,
        eventType: 'run.plan_approved',
        payload: event.payload ?? {},
      });
      await client.query('COMMIT');
      return { record: updatedRecord, eventId: event.id };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
  });
  await notifyRunPlanEvent(result.record.sessionId, result.eventId, 'run.plan_approved');
  return result.record;
}

/**
 * Revise a run spec's plan, incrementing the revision number and preserving
 * lineage. Records a `run.plan_revised` session event.
 *
 * Returns the updated run spec record.
 */
export async function reviseRunSpecPlan(
  id: string,
  opts: { plan?: PlanStep[]; actor?: string; reason?: string } = {},
): Promise<RunSpecRecord> {
  await ensureRunSpecStore();
  await Promise.all([ensureSessionEventStore(), ensureExecutionOutboxStore(), ensureVerificationRecordStore()]);
  const result = await withDbClient(async (client) => {
    await client.query('BEGIN');
    try {
      const rows = await client.query<RunSpecRow>('SELECT * FROM run_specs WHERE id = $1 FOR UPDATE', [id]);
      const row = rows.rows[0];
      const record = row ? rowToRecord(row) : null;
      if (!record) throw new Error(`Run spec not found: ${id}`);
      const currentRawContract = normalizeJsonObject(row!.run_contract_json);
      const planError = validatePlanForApproval(opts.plan);
      if (planError) throw new Error(planError);
      const replacementPlan = normalizePlanForPersistence(opts.plan!);
      const currentContract = completeRunContract(record.runContract);
      const phaseError = validatePlanRevisionPhase(currentContract.phase);
      if (phaseError) throw new Error(phaseError);
      const currentRevision = currentContract.planRevision ?? 1;
      const now = new Date().toISOString();
      const rawPlanHistory = Array.isArray(currentRawContract.planHistory) ? currentRawContract.planHistory : [];
      const rawPlan = Array.isArray(currentRawContract.plan) ? currentRawContract.plan : currentContract.plan ?? [];
      const rawRequiredChecks = Array.isArray(currentRawContract.requiredChecks)
        ? currentRawContract.requiredChecks
        : currentContract.requiredChecks;
      const rawVerifications = Array.isArray(currentRawContract.verifications)
        ? currentRawContract.verifications
        : currentContract.verifications ?? [];
      const planHistory = [
        ...rawPlanHistory,
        {
          revision: currentRevision,
          plan: rawPlan,
          requiredChecks: rawRequiredChecks,
          verifications: rawVerifications,
          supersededAt: now,
          actor: opts.actor,
          reason: opts.reason,
        },
      ];
      const updatedContract: RunContractMetadata = {
        ...currentContract,
        planHistory: normalizeRunContractMetadata({ planHistory })?.planHistory,
        plan: replacementPlan,
        planRevision: currentRevision + 1,
        planParentRevision: currentRevision,
        phase: 'planning',
        previousPhase: currentContract.phase,
        phaseChangedAt: now,
      };
      const updatedRows = await client.query<RunSpecRow>(
        'UPDATE run_specs SET run_contract_json = run_contract_json || $2::jsonb, updated_at = now() WHERE id = $1 RETURNING *',
        [id, JSON.stringify({
          planHistory,
          plan: replacementPlan,
          planRevision: currentRevision + 1,
          planParentRevision: currentRevision,
          phase: 'planning',
          previousPhase: currentContract.phase,
          phaseChangedAt: now,
        })],
      );
      await replaceVerificationRequirementsForRunSpec(client, {
        runSpecId: id,
        sessionId: record.sessionId,
        planRevision: currentRevision + 1,
        requiredChecks: updatedContract.requiredChecks,
        verifications: updatedContract.verifications,
      });
      const event = await insertSessionEvent(client, {
        sessionId: record.sessionId,
        tenantId: record.tenantId,
        projectId: record.projectId,
        userId: record.userId,
        nodeId: record.nodeId,
        requestId: record.requestId,
        traceId: record.traceId,
        type: 'run.plan_revised',
        source: 'operator',
        payload: {
          runSpecId: id,
          planRevision: updatedContract.planRevision,
          previousRevision: currentRevision,
          previousPhase: currentContract.phase ?? null,
          actor: opts.actor ?? null,
          reason: opts.reason ?? null,
          revisedAt: now,
        },
      });
      await insertExecutionOutbox(client, {
        sessionId: record.sessionId,
        runSpecId: id,
        entityType: 'run_spec',
        entityId: id,
        eventType: 'run.plan_revised',
        payload: event.payload ?? {},
      });
      await client.query('COMMIT');
      return { record: rowToRecord(assertRow(updatedRows.rows[0])), eventId: event.id };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
  });
  await notifyRunPlanEvent(result.record.sessionId, result.eventId, 'run.plan_revised');
  return result.record;
}

// ── Helpers ─────────────────────────────────────────────

type RunSpecRow = {
  id: string;
  session_id: string;
  tenant_id: string | null;
  project_id: string | null;
  user_id: string | null;
  node_id: string | null;
  gateway_id: string | null;
  request_id: string | null;
  trace_id: string | null;
  prompt: string;
  system_prompt: string | null;
  provider: string | null;
  model: string | null;
  model_settings_json: unknown;
  workspace_root: string;
  tool_mode: string;
  allowed_tools_json: unknown;
  tool_retry_json: unknown;
  max_loops: number;
  timeout_ms: number | null;
  mcp_servers_json: unknown;
  run_contract_json: unknown;
  status: string;
  created_at: Date | string;
  updated_at: Date | string;
};

function completeRunContract(contract: RunContractMetadata | undefined): RunContractMetadata {
  return {
    editableSurfaces: [], requiredChecks: [], allowedSkippedChecks: [], stopConditions: [],
    evidenceRequired: [], externalEvidenceAllowed: [], rawEvidenceProhibited: [],
    ...(contract ?? {}),
  };
}

async function notifyRunPlanEvent(sessionId: string, eventId: number, type: string): Promise<void> {
  await getDb().notify('session_events', JSON.stringify({ session_id: sessionId, event_id: eventId, type })).catch(() => undefined);
}

function rowToRecord(row: RunSpecRow): RunSpecRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    tenantId: row.tenant_id ?? undefined,
    projectId: row.project_id ?? undefined,
    userId: row.user_id ?? undefined,
    nodeId: row.node_id ?? undefined,
    gatewayId: row.gateway_id ?? undefined,
    requestId: row.request_id ?? undefined,
    traceId: row.trace_id ?? undefined,
    prompt: row.prompt,
    systemPrompt: row.system_prompt ?? undefined,
    provider: row.provider ?? undefined,
    model: row.model ?? undefined,
    modelSettings: normalizeJsonObject(row.model_settings_json),
    workspaceRoot: row.workspace_root,
    toolMode: row.tool_mode,
    allowedTools: normalizeJsonArray(row.allowed_tools_json).map(String),
    toolRetry: normalizeJsonObject(row.tool_retry_json),
    maxLoops: row.max_loops,
    timeoutMs: row.timeout_ms ?? undefined,
    mcpServers: normalizeMCPServers(row.mcp_servers_json),
    runContract: normalizeRunContractMetadata(row.run_contract_json),
    status: row.status as RunSpecStatus,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

function normalizeJsonArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try { const p = JSON.parse(value); return Array.isArray(p) ? p : []; } catch { return []; }
  }
  return [];
}

function normalizeJsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === 'string') {
    try {
      const p = JSON.parse(value);
      return p && typeof p === 'object' && !Array.isArray(p) ? p as Record<string, unknown> : {};
    } catch { return {}; }
  }
  return {};
}

function normalizeMCPServers(value: unknown): RunSpecRecord['mcpServers'] {
  const raw = normalizeJsonArray(value);
  return raw
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'))
    .map(item => ({
      command: String(item.command ?? ''),
      args: Array.isArray(item.args) ? item.args.map(String) : undefined,
      env: item.env && typeof item.env === 'object' ? item.env as Record<string, string> : undefined,
    }));
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function assertRow<T>(row: T | undefined): T {
  if (!row) throw new Error('Failed to create run spec');
  return row;
}
