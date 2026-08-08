/**
 * @los/memory — write gate for memory observations.
 *
 * Hard constraints (structure + source format) enforced on every write path
 * (addObservation / upsertObservation / gateway routes), plus lightweight
 * poisoning detection: content that matches instruction-override or
 * identity-impersonation patterns is written but flagged (poisonFlag in
 * metadata) instead of silently trusted — "keep evidence, tag it" (MutMem).
 *
 * Pure functions — no DB access, unit-testable without PostgreSQL.
 */

export const MEMORY_TITLE_MAX = 500;
export const MEMORY_SUMMARY_MAX = 4000;
export const MEMORY_CONTENT_MAX = 20_000;
export const MEMORY_KIND_MAX = 64;
export const MEMORY_SOURCE_MAX = 128;
export const MEMORY_TAGS_MAX = 50;
export const MEMORY_TAG_MAX = 100;
export const MEMORY_IDENTIFIER_MAX = 128;
export const MEMORY_METADATA_MAX_BYTES = 32 * 1024;

/** Runtime whitelist mirror of `ObserverType` in ../types.ts. */
export const ALLOWED_OBSERVER_TYPES = [
  'user',
  'agent',
  'agent_self',
  'judge',
  'system',
  'child_agent',
] as const;

export interface MemoryWriteInput {
  /** Required at the store layer; optional for partial gateway patches (validated by required flag). */
  title?: string;
  summary?: string;
  kind?: string;
  tags?: string[];
  content?: string;
  metadata?: Record<string, unknown>;
  source?: string;
  observerType?: unknown;
  sessionId?: string;
  tenantId?: string;
  projectId?: string;
  userId?: string;
  nodeId?: string;
  requestId?: string;
  traceId?: string;
}

/** Violation detail: { field, message } pairs for actionable 422 responses. */
export interface MemoryWriteViolation {
  field: string;
  message: string;
}

const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/;

/** Extreme control chars banned even in free text (newlines/tabs/CR allowed). */
const FREE_TEXT_CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

/** Fields that must never contain control characters (identifiers, source). */
const IDENTIFIER_FIELDS = new Set([
  'source', 'sessionId', 'tenantId', 'projectId', 'userId', 'nodeId', 'requestId', 'traceId',
]);

function checkLength(
  violations: MemoryWriteViolation[],
  field: string,
  value: string | undefined,
  max: number,
  required = false,
): void {
  if (value === undefined || value === null) {
    if (required) violations.push({ field, message: `${field} is required` });
    return;
  }
  if (typeof value !== 'string') {
    violations.push({ field, message: `${field} must be a string` });
    return;
  }
  const len = value.length;
  if (required && len < 1) {
    violations.push({ field, message: `${field} must not be empty` });
  }
  if (len > max) {
    violations.push({ field, message: `${field} exceeds ${max} characters (got ${len})` });
  }
  // Control-character check applies to identifiers/source only — free-text
  // fields (title/summary/content/kind) legitimately contain newlines/tabs.
  if (IDENTIFIER_FIELDS.has(field) && CONTROL_CHARS_RE.test(value)) {
    violations.push({ field, message: `${field} contains control characters` });
  } else if (!IDENTIFIER_FIELDS.has(field) && FREE_TEXT_CONTROL_RE.test(value)) {
    violations.push({ field, message: `${field} contains control characters` });
  }
}

/**
 * Validate an observation write against structural and source-format gates.
 * Returns an empty array when the write is allowed.
 * @param opts.partial — allow partial writes (no required-title check); used
 *   by gateway PATCH where only provided fields are validated.
 */
export function validateMemoryWrite(input: MemoryWriteInput, opts: { partial?: boolean } = {}): MemoryWriteViolation[] {
  const violations: MemoryWriteViolation[] = [];

  checkLength(violations, 'title', input.title, MEMORY_TITLE_MAX, !opts.partial);
  checkLength(violations, 'summary', input.summary, MEMORY_SUMMARY_MAX);
  checkLength(violations, 'content', input.content, MEMORY_CONTENT_MAX);
  checkLength(violations, 'kind', input.kind, MEMORY_KIND_MAX);
  checkLength(violations, 'source', input.source, MEMORY_SOURCE_MAX);
  checkLength(violations, 'sessionId', input.sessionId, MEMORY_IDENTIFIER_MAX);
  checkLength(violations, 'tenantId', input.tenantId, MEMORY_IDENTIFIER_MAX);
  checkLength(violations, 'projectId', input.projectId, MEMORY_IDENTIFIER_MAX);
  checkLength(violations, 'userId', input.userId, MEMORY_IDENTIFIER_MAX);
  checkLength(violations, 'nodeId', input.nodeId, MEMORY_IDENTIFIER_MAX);
  checkLength(violations, 'requestId', input.requestId, MEMORY_IDENTIFIER_MAX);
  checkLength(violations, 'traceId', input.traceId, MEMORY_IDENTIFIER_MAX);

  if (input.observerType !== undefined && input.observerType !== null) {
    if (!ALLOWED_OBSERVER_TYPES.includes(input.observerType as never)) {
      violations.push({
        field: 'observerType',
        message: `observerType must be one of: ${ALLOWED_OBSERVER_TYPES.join(', ')}`,
      });
    }
  }

  if (input.tags !== undefined) {
    if (!Array.isArray(input.tags)) {
      violations.push({ field: 'tags', message: 'tags must be an array of strings' });
    } else {
      if (input.tags.length > MEMORY_TAGS_MAX) {
        violations.push({
          field: 'tags',
          message: `tags exceeds ${MEMORY_TAGS_MAX} entries (got ${input.tags.length})`,
        });
      }
      input.tags.forEach((tag, i) => {
        if (typeof tag !== 'string' || tag.length < 1 || tag.length > MEMORY_TAG_MAX) {
          violations.push({
            field: `tags[${i}]`,
            message: `each tag must be a 1-${MEMORY_TAG_MAX} character string`,
          });
        }
      });
    }
  }

  if (input.metadata !== undefined) {
    if (input.metadata === null || typeof input.metadata !== 'object' || Array.isArray(input.metadata)) {
      violations.push({ field: 'metadata', message: 'metadata must be an object' });
    } else {
      try {
        const size = Buffer.byteLength(JSON.stringify(input.metadata), 'utf8');
        if (size > MEMORY_METADATA_MAX_BYTES) {
          violations.push({
            field: 'metadata',
            message: `metadata exceeds ${MEMORY_METADATA_MAX_BYTES} bytes when serialized (got ${size})`,
          });
        }
      } catch {
        violations.push({ field: 'metadata', message: 'metadata is not JSON-serializable' });
      }
    }
  }

  return violations;
}

export interface PoisonDetection {
  /** Stable pattern id, e.g. 'instruction-override'. */
  pattern: string;
  /** Human-readable reason, stored in metadata.poisonFlag.reason. */
  reason: string;
}

/** Conservative instruction-override / identity-impersonation patterns. */
const POISON_PATTERNS: Array<{ pattern: RegExp; id: string; reason: string }> = [
  {
    pattern: /\bignore\s+(all\s+)?(previous|prior|above)\s+(instructions?|prompts?|context|messages?)\b/i,
    id: 'instruction-override',
    reason: 'content contains instruction-override phrasing',
  },
  {
    pattern: /\bdisregard\s+(all\s+)?(previous|prior|above)\s+(instructions?|prompts?|context)\b/i,
    id: 'instruction-override',
    reason: 'content contains instruction-override phrasing',
  },
  {
    pattern: /\bforget\s+(everything|all)\s+(above|prior|previous)\b/i,
    id: 'instruction-override',
    reason: 'content contains instruction-override phrasing',
  },
  {
    pattern: /\b(you are now|act as|pretend to be)\s+(the\s+|an?\s+)?(system|admin(istrator)?|root|operator)\b/i,
    id: 'identity-impersonation',
    reason: 'content contains identity-impersonation phrasing',
  },
  {
    pattern: /忽略(以上|之前|前面).{0,12}(指令|提示|内容|上下文)/i,
    id: 'instruction-override',
    reason: 'content contains instruction-override phrasing',
  },
  {
    pattern: /(现在你|你现在的角色)是.{0,8}(系统|管理员|超级用户|root)/i,
    id: 'identity-impersonation',
    reason: 'content contains identity-impersonation phrasing',
  },
];

/**
 * Detect poisoning-indicative content in title/summary/content.
 * Returns null when nothing matches. Matching writes are NOT rejected —
 * they are written with a poisonFlag so evidence is retained and attributable.
 */
export function detectPoisoning(input: Pick<MemoryWriteInput, 'title' | 'summary' | 'content'>): PoisonDetection | null {
  const haystack = `${input.title ?? ''}\n${input.summary ?? ''}\n${input.content ?? ''}`;
  for (const { pattern, id, reason } of POISON_PATTERNS) {
    if (pattern.test(haystack)) {
      return { pattern: id, reason };
    }
  }
  return null;
}

/** Build the poisonFlag metadata payload. */
export function buildPoisonFlag(detection: PoisonDetection, source: string | undefined): {
  poisonFlag: { flaggedAt: string; pattern: string; reason: string; source: string };
} {
  return {
    poisonFlag: {
      flaggedAt: new Date().toISOString(),
      pattern: detection.pattern,
      reason: detection.reason,
      source: source ?? 'unknown',
    },
  };
}
