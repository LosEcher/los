import { createHash } from 'node:crypto';
import { getDb } from '@los/infra/db';

export type ExternalAgentTool =
  | 'codex'
  | 'claude-code'
  | 'reasonix'
  | 'opencode'
  | 'omx'
  | 'gemini'
  | 'browser'
  | 'other';

export type ExternalSummarySourceKind =
  | 'operator_summary'
  | 'exported_summary'
  | 'external_capture';

export interface ExternalToolSummaryInput {
  id?: string;
  tool: ExternalAgentTool | string;
  toolVersion?: string;
  source: {
    kind: ExternalSummarySourceKind | string;
    sourceRef: string;
    cwd?: string;
    capturedAt?: string;
  };
  provenance: {
    collectedAt: string;
    capturePolicy: string;
    redactionPolicy: string;
    importedBy?: string;
  };
  summary: string;
  findings?: string[];
  evidence?: ExternalSummaryEvidenceInput[];
  metrics?: Record<string, number | string | boolean | null>;
  labels?: string[];
  retentionDays?: number;
}

export interface ExternalSummaryEvidenceInput {
  label: string;
  kind: 'command' | 'file' | 'url' | 'screenshot' | 'commit' | 'other' | string;
  value: string;
}

export interface ExternalToolSummary {
  tool: ExternalAgentTool;
  toolVersion?: string;
  source: {
    kind: ExternalSummarySourceKind;
    sourceRef: string;
    cwd?: string;
    capturedAt?: string;
  };
  provenance: {
    collectedAt: string;
    capturePolicy: string;
    redactionPolicy: string;
    importedBy?: string;
  };
  evidenceClass: 'external_summary';
  summary: string;
  findings: string[];
  evidence: ExternalSummaryEvidenceInput[];
  metrics: Record<string, number | string | boolean | null>;
  labels: string[];
  redaction: {
    status: 'redacted' | 'not_required';
    replacements: number;
    checkedPatterns: string[];
  };
}

export interface ExternalToolSummaryRecord extends ExternalToolSummary {
  id: string;
  sourceHash: string;
  retentionExpiresAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ListExternalToolSummariesOptions {
  tool?: string;
  sourceKind?: string;
  limit?: number;
  includeExpired?: boolean;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS external_tool_summaries (
  id TEXT PRIMARY KEY,
  tool TEXT NOT NULL,
  tool_version TEXT,
  source_kind TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  source_cwd TEXT,
  source_captured_at TIMESTAMPTZ,
  collected_at TIMESTAMPTZ NOT NULL,
  capture_policy TEXT NOT NULL,
  redaction_policy TEXT NOT NULL,
  imported_by TEXT,
  evidence_class TEXT NOT NULL DEFAULT 'external_summary',
  source_hash TEXT NOT NULL,
  summary_json JSONB NOT NULL,
  labels_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  metrics_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  redaction_status TEXT NOT NULL,
  redaction_replacements INTEGER NOT NULL DEFAULT 0,
  retention_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT external_tool_summaries_evidence_class_chk CHECK (evidence_class = 'external_summary')
);

CREATE INDEX IF NOT EXISTS idx_external_tool_summaries_tool ON external_tool_summaries(tool);
CREATE INDEX IF NOT EXISTS idx_external_tool_summaries_source ON external_tool_summaries(source_kind, source_ref);
CREATE INDEX IF NOT EXISTS idx_external_tool_summaries_hash ON external_tool_summaries(source_hash);
CREATE INDEX IF NOT EXISTS idx_external_tool_summaries_created ON external_tool_summaries(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_external_tool_summaries_retention ON external_tool_summaries(retention_expires_at);
`;

let _initialized = false;

export async function ensureExternalToolSummaryStore(): Promise<void> {
  if (_initialized) return;
  await getDb().exec(SCHEMA);
  _initialized = true;
}

const KNOWN_TOOLS = new Set<ExternalAgentTool>([
  'codex',
  'claude-code',
  'reasonix',
  'opencode',
  'omx',
  'gemini',
  'browser',
  'other',
]);

const KNOWN_SOURCE_KINDS = new Set<ExternalSummarySourceKind>([
  'operator_summary',
  'exported_summary',
  'external_capture',
]);

const RAW_FIELD_NAMES = new Set([
  'rawTranscript',
  'raw transcript',
  'transcript',
  'rawPrompt',
  'prompt',
  'rawToolOutput',
  'toolOutput',
  'stdout',
  'stderr',
  'authSnapshot',
  'cookies',
  'apiKey',
  'token',
]);

const SECRET_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: 'openai-style-api-key', pattern: /\bsk-[A-Za-z0-9_-]{8,}\b/g },
  { name: 'bearer-token', pattern: /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi },
  { name: 'ssh-private-key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
];

export function normalizeExternalToolSummary(input: ExternalToolSummaryInput): ExternalToolSummary {
  assertNoRawFields(input);
  const tool = normalizeTool(input.tool);
  const sourceKind = normalizeSourceKind(input.source?.kind);
  const sourceRef = normalizeRequiredString(input.source?.sourceRef, 'source.sourceRef');
  const collectedAt = normalizeIsoLike(input.provenance?.collectedAt, 'provenance.collectedAt');
  const capturePolicy = normalizeRequiredString(input.provenance?.capturePolicy, 'provenance.capturePolicy');
  const redactionPolicy = normalizeRequiredString(input.provenance?.redactionPolicy, 'provenance.redactionPolicy');
  const redacted = redactExternalSummaryText([
    normalizeRequiredString(input.summary, 'summary'),
    ...normalizeStringArray(input.findings),
    ...normalizeEvidence(input.evidence).map(item => item.value),
  ]);

  const [summary, ...rest] = redacted.values;
  const findings = rest.slice(0, normalizeStringArray(input.findings).length);
  const evidenceValues = rest.slice(findings.length);
  const evidence = normalizeEvidence(input.evidence).map((item, index) => ({
    ...item,
    value: evidenceValues[index] ?? item.value,
  }));

  return {
    tool,
    toolVersion: normalizeOptionalString(input.toolVersion),
    source: {
      kind: sourceKind,
      sourceRef,
      cwd: normalizeOptionalString(input.source?.cwd),
      capturedAt: input.source?.capturedAt ? normalizeIsoLike(input.source.capturedAt, 'source.capturedAt') : undefined,
    },
    provenance: {
      collectedAt,
      capturePolicy,
      redactionPolicy,
      importedBy: normalizeOptionalString(input.provenance?.importedBy),
    },
    evidenceClass: 'external_summary',
    summary,
    findings,
    evidence,
    metrics: normalizeMetrics(input.metrics),
    labels: normalizeStringArray(input.labels),
    redaction: {
      status: redacted.replacements > 0 ? 'redacted' : 'not_required',
      replacements: redacted.replacements,
      checkedPatterns: SECRET_PATTERNS.map(item => item.name),
    },
  };
}

export async function importExternalToolSummary(input: ExternalToolSummaryInput): Promise<ExternalToolSummaryRecord> {
  await ensureExternalToolSummaryStore();
  const summary = normalizeExternalToolSummary(input);
  const sourceHash = hashExternalSummary(summary);
  const id = normalizeOptionalString(input.id) ?? `external-summary-${summary.tool}-${sourceHash.slice(0, 16)}`;
  const retentionExpiresAt = normalizeRetentionExpiresAt(input.retentionDays, summary.provenance.collectedAt);
  const rows = await getDb().query<ExternalToolSummaryRow>(
    `
    INSERT INTO external_tool_summaries (
      id, tool, tool_version, source_kind, source_ref, source_cwd,
      source_captured_at, collected_at, capture_policy, redaction_policy,
      imported_by, evidence_class, source_hash, summary_json, labels_json,
      metrics_json, redaction_status, redaction_replacements, retention_expires_at
    )
    VALUES (
      $1, $2, $3, $4, $5, $6,
      $7, $8, $9, $10,
      $11, 'external_summary', $12, $13::jsonb, $14::jsonb,
      $15::jsonb, $16, $17, $18
    )
    ON CONFLICT (id) DO UPDATE SET
      tool = EXCLUDED.tool,
      tool_version = EXCLUDED.tool_version,
      source_kind = EXCLUDED.source_kind,
      source_ref = EXCLUDED.source_ref,
      source_cwd = EXCLUDED.source_cwd,
      source_captured_at = EXCLUDED.source_captured_at,
      collected_at = EXCLUDED.collected_at,
      capture_policy = EXCLUDED.capture_policy,
      redaction_policy = EXCLUDED.redaction_policy,
      imported_by = EXCLUDED.imported_by,
      evidence_class = 'external_summary',
      source_hash = EXCLUDED.source_hash,
      summary_json = EXCLUDED.summary_json,
      labels_json = EXCLUDED.labels_json,
      metrics_json = EXCLUDED.metrics_json,
      redaction_status = EXCLUDED.redaction_status,
      redaction_replacements = EXCLUDED.redaction_replacements,
      retention_expires_at = EXCLUDED.retention_expires_at,
      updated_at = now()
    RETURNING *
  `,
    [
      id,
      summary.tool,
      summary.toolVersion ?? null,
      summary.source.kind,
      summary.source.sourceRef,
      summary.source.cwd ?? null,
      summary.source.capturedAt ?? null,
      summary.provenance.collectedAt,
      summary.provenance.capturePolicy,
      summary.provenance.redactionPolicy,
      summary.provenance.importedBy ?? null,
      sourceHash,
      JSON.stringify(summary),
      JSON.stringify(summary.labels),
      JSON.stringify(summary.metrics),
      summary.redaction.status,
      summary.redaction.replacements,
      retentionExpiresAt ?? null,
    ],
  );
  return rowToRecord(assertRow(rows.rows[0]));
}

export async function listExternalToolSummaries(
  options: ListExternalToolSummariesOptions = {},
): Promise<ExternalToolSummaryRecord[]> {
  await ensureExternalToolSummaryStore();
  const tool = normalizeOptionalString(options.tool)?.toLowerCase().replace(/_/g, '-');
  const sourceKind = normalizeOptionalString(options.sourceKind)?.toLowerCase().replace(/-/g, '_');
  const limit = normalizeLimit(options.limit);
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (tool) {
    params.push(tool);
    clauses.push(`tool = $${params.length}`);
  }
  if (sourceKind) {
    params.push(sourceKind);
    clauses.push(`source_kind = $${params.length}`);
  }
  if (options.includeExpired !== true) {
    clauses.push('(retention_expires_at IS NULL OR retention_expires_at > now())');
  }
  params.push(limit);
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = await getDb().query<ExternalToolSummaryRow>(
    `
    SELECT *
    FROM external_tool_summaries
    ${where}
    ORDER BY created_at DESC, id
    LIMIT $${params.length}
  `,
    params,
  );
  return rows.rows.map(rowToRecord);
}

export function redactExternalSummaryText(values: string[]): { values: string[]; replacements: number } {
  let replacements = 0;
  const redactedValues = values.map((value) => {
    let out = value;
    for (const { pattern } of SECRET_PATTERNS) {
      out = out.replace(pattern, () => {
        replacements++;
        return '[redacted]';
      });
    }
    return out;
  });
  return { values: redactedValues, replacements };
}

function assertNoRawFields(value: unknown, path = 'input'): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoRawFields(item, `${path}[${index}]`));
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (RAW_FIELD_NAMES.has(key)) {
      throw new Error(`external summary rejects raw field: ${path}.${key}`);
    }
    assertNoRawFields(child, `${path}.${key}`);
  }
}

function normalizeTool(value: unknown): ExternalAgentTool {
  const normalized = normalizeRequiredString(value, 'tool').toLowerCase().replace(/_/g, '-');
  if (KNOWN_TOOLS.has(normalized as ExternalAgentTool)) return normalized as ExternalAgentTool;
  return 'other';
}

function normalizeSourceKind(value: unknown): ExternalSummarySourceKind {
  const normalized = normalizeRequiredString(value, 'source.kind').toLowerCase().replace(/-/g, '_');
  if (KNOWN_SOURCE_KINDS.has(normalized as ExternalSummarySourceKind)) return normalized as ExternalSummarySourceKind;
  throw new Error(`Unsupported external summary source kind: ${String(value)}`);
}

function normalizeEvidence(value: unknown): ExternalSummaryEvidenceInput[] {
  if (!Array.isArray(value)) return [];
  return value.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`evidence[${index}] must be an object`);
    const raw = item as Record<string, unknown>;
    return {
      label: normalizeRequiredString(raw.label, `evidence[${index}].label`),
      kind: normalizeRequiredString(raw.kind, `evidence[${index}].kind`),
      value: normalizeRequiredString(raw.value, `evidence[${index}].value`),
    };
  });
}

function normalizeMetrics(value: unknown): Record<string, number | string | boolean | null> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, number | string | boolean | null> = {};
  for (const [key, metric] of Object.entries(value)) {
    if (typeof metric === 'number' || typeof metric === 'string' || typeof metric === 'boolean' || metric === null) {
      out[key] = metric;
    }
  }
  return out;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    const normalized = normalizeOptionalString(item);
    if (normalized && !out.includes(normalized)) out.push(normalized);
  }
  return out;
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

function normalizeIsoLike(value: unknown, name: string): string {
  const raw = normalizeRequiredString(value, name);
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) throw new Error(`${name} must be a valid timestamp`);
  return date.toISOString();
}

function hashExternalSummary(summary: ExternalToolSummary): string {
  return createHash('sha256').update(JSON.stringify({
    tool: summary.tool,
    toolVersion: summary.toolVersion,
    source: summary.source,
    provenance: summary.provenance,
    summary: summary.summary,
    findings: summary.findings,
    evidence: summary.evidence,
    metrics: summary.metrics,
    labels: summary.labels,
  })).digest('hex');
}

function normalizeRetentionExpiresAt(retentionDays: unknown, collectedAt: string): string | undefined {
  if (retentionDays === undefined || retentionDays === null) return undefined;
  const days = Number(retentionDays);
  if (!Number.isFinite(days) || days <= 0) throw new Error('retentionDays must be a positive number');
  const collected = new Date(collectedAt).getTime();
  return new Date(collected + Math.floor(days) * 86_400_000).toISOString();
}

function normalizeLimit(value: unknown): number {
  const parsed = Number(value ?? 100);
  if (!Number.isFinite(parsed) || parsed <= 0) return 100;
  return Math.max(1, Math.min(1000, Math.floor(parsed)));
}

type ExternalToolSummaryRow = {
  id: string;
  source_hash: string;
  summary_json: ExternalToolSummary | string;
  retention_expires_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

function rowToRecord(row: ExternalToolSummaryRow): ExternalToolSummaryRecord {
  const summary = normalizeStoredSummary(row.summary_json);
  return {
    ...summary,
    id: row.id,
    sourceHash: row.source_hash,
    retentionExpiresAt: row.retention_expires_at ? toIsoString(row.retention_expires_at) : undefined,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

function normalizeStoredSummary(value: ExternalToolSummary | string): ExternalToolSummary {
  if (typeof value === 'string') return JSON.parse(value) as ExternalToolSummary;
  return value;
}

function assertRow<T>(row: T | undefined): T {
  if (!row) throw new Error('external summary write returned no row');
  return row;
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
