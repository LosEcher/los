import { getDb } from '@los/infra/db';
import { loadConfig } from '@los/infra/config';
import { closeDb, initDb } from '@los/infra/db';
import type { CompatibilityRunSummary } from './compat-harness.js';

export type ProviderCompatDecision = 'advisory' | 'verified_advisory' | 'required' | 'blocked';

export interface ProviderCompatEvidenceRecord {
  id: string;
  provider: string;
  model?: string;
  probeId: string;
  targetLabel: string;
  decision: ProviderCompatDecision;
  passed: boolean;
  sessionId?: string;
  taskRunId?: string;
  runSpecId?: string;
  traceId?: string;
  requestId?: string;
  nodeId?: string;
  totalTokens: number;
  summary: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface RecordProviderCompatEvidenceInput {
  id?: string;
  provider: string;
  model?: string;
  probeId: string;
  targetLabel?: string;
  decision: ProviderCompatDecision;
  passed: boolean;
  sessionId?: string;
  taskRunId?: string;
  runSpecId?: string;
  traceId?: string;
  requestId?: string;
  nodeId?: string;
  totalTokens?: number;
  summary?: Record<string, unknown>;
}

export interface ListProviderCompatEvidenceOptions {
  provider?: string;
  model?: string;
  limit?: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS provider_compat_evidence (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  model TEXT,
  probe_id TEXT NOT NULL,
  target_label TEXT NOT NULL,
  decision TEXT NOT NULL,
  passed BOOLEAN NOT NULL DEFAULT false,
  session_id TEXT,
  task_run_id TEXT,
  run_spec_id TEXT,
  trace_id TEXT,
  request_id TEXT,
  node_id TEXT,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  summary_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_provider_compat_target ON provider_compat_evidence(provider, model, probe_id);
CREATE INDEX IF NOT EXISTS idx_provider_compat_decision ON provider_compat_evidence(decision);
CREATE INDEX IF NOT EXISTS idx_provider_compat_updated ON provider_compat_evidence(updated_at DESC);
`;

let _initialized = false;

export async function ensureProviderCompatEvidenceStore(): Promise<void> {
  if (_initialized) return;
  const db = getDb();
  await db.exec(SCHEMA);
  _initialized = true;
}

export async function recordProviderCompatEvidence(
  input: RecordProviderCompatEvidenceInput,
): Promise<ProviderCompatEvidenceRecord> {
  await ensureProviderCompatEvidenceStore();
  const provider = normalizeRequiredString(input.provider, 'provider');
  const probeId = normalizeRequiredString(input.probeId, 'probeId');
  const model = normalizeOptionalString(input.model);
  const targetLabel = normalizeOptionalString(input.targetLabel) ?? (model ? `${provider}:${model}` : provider);
  const id = normalizeOptionalString(input.id) ?? `provider-compat-${targetLabel}/${probeId}`;
  const db = getDb();
  const rows = await db.query<ProviderCompatEvidenceRow>(
    `
    INSERT INTO provider_compat_evidence (
      id, provider, model, probe_id, target_label, decision, passed,
      session_id, task_run_id, run_spec_id, trace_id, request_id, node_id,
      total_tokens, summary_json
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb)
    ON CONFLICT (id) DO UPDATE SET
      provider = EXCLUDED.provider,
      model = EXCLUDED.model,
      probe_id = EXCLUDED.probe_id,
      target_label = EXCLUDED.target_label,
      decision = EXCLUDED.decision,
      passed = EXCLUDED.passed,
      session_id = EXCLUDED.session_id,
      task_run_id = EXCLUDED.task_run_id,
      run_spec_id = EXCLUDED.run_spec_id,
      trace_id = EXCLUDED.trace_id,
      request_id = EXCLUDED.request_id,
      node_id = EXCLUDED.node_id,
      total_tokens = EXCLUDED.total_tokens,
      summary_json = EXCLUDED.summary_json,
      updated_at = now()
    RETURNING *
  `,
    [
      id,
      provider,
      model ?? null,
      probeId,
      targetLabel,
      normalizeDecision(input.decision),
      input.passed,
      normalizeOptionalString(input.sessionId) ?? null,
      normalizeOptionalString(input.taskRunId) ?? null,
      normalizeOptionalString(input.runSpecId) ?? null,
      normalizeOptionalString(input.traceId) ?? null,
      normalizeOptionalString(input.requestId) ?? null,
      normalizeOptionalString(input.nodeId) ?? null,
      Math.max(0, Math.floor(input.totalTokens ?? 0)),
      JSON.stringify(input.summary ?? {}),
    ],
  );
  return rowToRecord(assertRow(rows.rows[0]));
}

export async function recordProviderCompatEvidenceFromSummary(
  summary: CompatibilityRunSummary,
  decision: ProviderCompatDecision = summary.passed ? 'verified_advisory' : 'advisory',
): Promise<ProviderCompatEvidenceRecord> {
  return await recordProviderCompatEvidence({
    provider: summary.provider,
    model: summary.effectiveModel ?? summary.model,
    probeId: summary.probeId,
    targetLabel: summary.specId.split('/')[0] ?? summary.provider,
    decision,
    passed: summary.passed,
    sessionId: summary.sessionId,
    taskRunId: summary.taskRunId,
    runSpecId: summary.runSpecId,
    traceId: summary.traceId,
    requestId: summary.requestId,
    nodeId: summary.nodeId,
    totalTokens: summary.totalTokens,
    summary: summary as unknown as Record<string, unknown>,
  });
}

export async function recordProviderCompatEvidenceFromSummaryWithDefaultDb(
  summary: CompatibilityRunSummary,
  decision?: ProviderCompatDecision,
): Promise<ProviderCompatEvidenceRecord> {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  try {
    return await recordProviderCompatEvidenceFromSummary(summary, decision);
  } finally {
    await closeDb().catch(() => undefined);
  }
}

export async function listLatestProviderCompatEvidence(): Promise<ProviderCompatEvidenceRecord[]> {
  await ensureProviderCompatEvidenceStore();
  const db = getDb();
  const rows = await db.query<ProviderCompatEvidenceRow>(
    `
    SELECT DISTINCT ON (provider, COALESCE(model, ''), probe_id) *
    FROM provider_compat_evidence
    ORDER BY provider, COALESCE(model, ''), probe_id, updated_at DESC
  `,
  );
  return rows.rows.map(rowToRecord);
}

export async function listProviderCompatEvidence(
  options: ListProviderCompatEvidenceOptions = {},
): Promise<ProviderCompatEvidenceRecord[]> {
  await ensureProviderCompatEvidenceStore();
  const provider = normalizeOptionalString(options.provider);
  const model = normalizeOptionalString(options.model);
  const limit = normalizeLimit(options.limit, 100);
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (provider) {
    params.push(provider);
    clauses.push(`provider = $${params.length}`);
  }
  if (model) {
    params.push(model);
    clauses.push(`model = $${params.length}`);
  }
  params.push(limit);
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = await getDb().query<ProviderCompatEvidenceRow>(
    `
    SELECT *
    FROM provider_compat_evidence
    ${where}
    ORDER BY updated_at DESC, provider, COALESCE(model, ''), probe_id
    LIMIT $${params.length}
  `,
    params,
  );
  return rows.rows.map(rowToRecord);
}

type ProviderCompatEvidenceRow = {
  id: string;
  provider: string;
  model: string | null;
  probe_id: string;
  target_label: string;
  decision: string;
  passed: boolean;
  session_id: string | null;
  task_run_id: string | null;
  run_spec_id: string | null;
  trace_id: string | null;
  request_id: string | null;
  node_id: string | null;
  total_tokens: number;
  summary_json: unknown;
  created_at: Date | string;
  updated_at: Date | string;
};

function rowToRecord(row: ProviderCompatEvidenceRow): ProviderCompatEvidenceRecord {
  return {
    id: row.id,
    provider: row.provider,
    model: row.model ?? undefined,
    probeId: row.probe_id,
    targetLabel: row.target_label,
    decision: normalizeDecision(row.decision),
    passed: row.passed,
    sessionId: row.session_id ?? undefined,
    taskRunId: row.task_run_id ?? undefined,
    runSpecId: row.run_spec_id ?? undefined,
    traceId: row.trace_id ?? undefined,
    requestId: row.request_id ?? undefined,
    nodeId: row.node_id ?? undefined,
    totalTokens: row.total_tokens,
    summary: normalizeJsonObject(row.summary_json),
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

function normalizeDecision(value: unknown): ProviderCompatDecision {
  if (value === 'advisory' || value === 'verified_advisory' || value === 'required' || value === 'blocked') return value;
  return 'advisory';
}

function normalizeRequiredString(value: unknown, name: string): string {
  const normalized = normalizeOptionalString(value);
  if (!normalized) throw new Error(`${name} is required`);
  return normalized;
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeJsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    } catch {
      return {};
    }
  }
  return {};
}

function normalizeLimit(value: unknown, defaultValue: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return defaultValue;
  return Math.max(1, Math.min(1000, Math.floor(value)));
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function assertRow<T>(row: T | undefined): T {
  if (!row) throw new Error('Failed to record provider compat evidence');
  return row;
}
