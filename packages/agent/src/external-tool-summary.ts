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
