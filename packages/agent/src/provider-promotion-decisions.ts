import { getDb } from '@los/infra/db';
import {
  loadProviderCompatEvidence,
  type ProviderCompatDecision,
  type ProviderCompatEvidenceRecord,
} from './provider-compat-evidence.js';

export type ProviderPromotionPolicyAction = 'promote_required' | 'demote_advisory';
export type ProviderPromotionPolicyStatus = 'proposed';

export interface ProviderPromotionDecisionRecord {
  id: string;
  action: ProviderPromotionPolicyAction;
  status: ProviderPromotionPolicyStatus;
  provider: string;
  model?: string;
  probeId: string;
  targetLabel: string;
  fromDecision: ProviderCompatDecision;
  toDecision: ProviderCompatDecision;
  evidenceId?: string;
  reason: string;
  actor?: string;
  createdAt: string;
  updatedAt: string;
}

export interface RecordProviderPromotionDecisionInput {
  id?: string;
  action: ProviderPromotionPolicyAction;
  provider?: string;
  model?: string;
  probeId?: string;
  targetLabel?: string;
  evidenceId?: string;
  reason: string;
  actor?: string;
}

export interface ListProviderPromotionDecisionsOptions {
  provider?: string;
  model?: string;
  limit?: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS provider_promotion_decisions (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'proposed',
  provider TEXT NOT NULL,
  model TEXT,
  probe_id TEXT NOT NULL,
  target_label TEXT NOT NULL,
  from_decision TEXT NOT NULL,
  to_decision TEXT NOT NULL,
  evidence_id TEXT,
  reason TEXT NOT NULL,
  actor TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_provider_promotion_target ON provider_promotion_decisions(provider, model, probe_id);
CREATE INDEX IF NOT EXISTS idx_provider_promotion_status ON provider_promotion_decisions(status);
CREATE INDEX IF NOT EXISTS idx_provider_promotion_updated ON provider_promotion_decisions(updated_at DESC);
`;

let _initialized = false;

export async function ensureProviderPromotionDecisionStore(): Promise<void> {
  if (_initialized) return;
  await getDb().exec(SCHEMA);
  _initialized = true;
}

export async function recordProviderPromotionDecision(
  input: RecordProviderPromotionDecisionInput,
): Promise<ProviderPromotionDecisionRecord> {
  await ensureProviderPromotionDecisionStore();
  const action = normalizeAction(input.action);
  const reason = normalizeRequiredString(input.reason, 'reason');
  const evidence = input.evidenceId ? await loadProviderCompatEvidence(input.evidenceId) : null;
  if (input.evidenceId && !evidence) throw new Error(`provider compat evidence not found: ${input.evidenceId}`);
  if (action === 'promote_required') validatePromotionEvidence(evidence);

  const provider = normalizeOptionalString(input.provider) ?? evidence?.provider;
  if (!provider) throw new Error('provider is required');
  const model = normalizeOptionalString(input.model) ?? evidence?.model;
  const probeId = normalizeOptionalString(input.probeId) ?? evidence?.probeId ?? 'read-context';
  const targetLabel = normalizeOptionalString(input.targetLabel) ?? evidence?.targetLabel ?? (model ? `${provider}:${model}` : provider);
  if (evidence) validateEvidenceMatchesTarget(evidence, { provider, model, probeId });

  const fromDecision = action === 'promote_required' ? (evidence?.decision ?? 'verified_advisory') : 'required';
  const toDecision = action === 'promote_required' ? 'required' : 'advisory';
  const id = normalizeOptionalString(input.id)
    ?? `provider-promotion-${action}-${targetLabel}/${probeId}-${Date.now()}`;

  const rows = await getDb().query<ProviderPromotionDecisionRow>(
    `
    INSERT INTO provider_promotion_decisions (
      id, action, status, provider, model, probe_id, target_label,
      from_decision, to_decision, evidence_id, reason, actor
    )
    VALUES ($1, $2, 'proposed', $3, $4, $5, $6, $7, $8, $9, $10, $11)
    ON CONFLICT (id) DO UPDATE SET
      action = EXCLUDED.action,
      status = EXCLUDED.status,
      provider = EXCLUDED.provider,
      model = EXCLUDED.model,
      probe_id = EXCLUDED.probe_id,
      target_label = EXCLUDED.target_label,
      from_decision = EXCLUDED.from_decision,
      to_decision = EXCLUDED.to_decision,
      evidence_id = EXCLUDED.evidence_id,
      reason = EXCLUDED.reason,
      actor = EXCLUDED.actor,
      updated_at = now()
    RETURNING *
  `,
    [
      id,
      action,
      provider,
      model ?? null,
      probeId,
      targetLabel,
      fromDecision,
      toDecision,
      evidence?.id ?? null,
      reason,
      normalizeOptionalString(input.actor) ?? null,
    ],
  );
  return rowToRecord(assertRow(rows.rows[0]));
}

export async function listProviderPromotionDecisions(
  options: ListProviderPromotionDecisionsOptions = {},
): Promise<ProviderPromotionDecisionRecord[]> {
  await ensureProviderPromotionDecisionStore();
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
  const rows = await getDb().query<ProviderPromotionDecisionRow>(
    `
    SELECT *
    FROM provider_promotion_decisions
    ${where}
    ORDER BY updated_at DESC, target_label, probe_id
    LIMIT $${params.length}
  `,
    params,
  );
  return rows.rows.map(rowToRecord);
}

function validatePromotionEvidence(evidence: ProviderCompatEvidenceRecord | null): asserts evidence is ProviderCompatEvidenceRecord {
  if (!evidence) throw new Error('promote_required requires evidenceId');
  if (!evidence.passed) throw new Error(`provider compat evidence did not pass: ${evidence.id}`);
  if (evidence.decision !== 'verified_advisory' && evidence.decision !== 'required') {
    throw new Error(`provider compat evidence is not verified advisory: ${evidence.id}`);
  }
}

function validateEvidenceMatchesTarget(
  evidence: ProviderCompatEvidenceRecord,
  target: { provider: string; model?: string; probeId: string },
): void {
  if (evidence.provider !== target.provider) {
    throw new Error(`evidence provider mismatch: ${evidence.provider} != ${target.provider}`);
  }
  if ((evidence.model ?? '') !== (target.model ?? '')) {
    throw new Error(`evidence model mismatch: ${evidence.model ?? ''} != ${target.model ?? ''}`);
  }
  if (evidence.probeId !== target.probeId) {
    throw new Error(`evidence probe mismatch: ${evidence.probeId} != ${target.probeId}`);
  }
}

function normalizeAction(value: unknown): ProviderPromotionPolicyAction {
  if (value === 'promote_required' || value === 'demote_advisory') return value;
  throw new Error('action must be promote_required or demote_advisory');
}

type ProviderPromotionDecisionRow = {
  id: string;
  action: string;
  status: string;
  provider: string;
  model: string | null;
  probe_id: string;
  target_label: string;
  from_decision: string;
  to_decision: string;
  evidence_id: string | null;
  reason: string;
  actor: string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

function rowToRecord(row: ProviderPromotionDecisionRow): ProviderPromotionDecisionRecord {
  return {
    id: row.id,
    action: normalizeAction(row.action),
    status: row.status === 'proposed' ? 'proposed' : 'proposed',
    provider: row.provider,
    model: row.model ?? undefined,
    probeId: row.probe_id,
    targetLabel: row.target_label,
    fromDecision: normalizeDecision(row.from_decision),
    toDecision: normalizeDecision(row.to_decision),
    evidenceId: row.evidence_id ?? undefined,
    reason: row.reason,
    actor: row.actor ?? undefined,
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

function normalizeLimit(value: unknown, fallback: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(1, Math.min(1000, Math.floor(parsed)));
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function assertRow<T>(row: T | undefined): T {
  if (!row) throw new Error('Failed to record provider promotion decision');
  return row;
}
