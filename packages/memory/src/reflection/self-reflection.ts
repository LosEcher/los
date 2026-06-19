/**
 * @los/memory/self-reflection — Agent self-reflective memory.
 *
 * Records observations where the agent reflects on its own behavior,
 * patterns, strengths, and weaknesses. These are stored with:
 *   kind: 'self_reflection'
 *   observerType: 'agent_self'
 *   memoryLayer: 'self_reflective' (in metadata)
 *
 * Self-reflective observations are distinct from regular agent observations
 * (which are about the task/work) — they are about the AGENT ITSELF.
 *
 * Gated behind config.memory.selfReflectionEnabled (default: false).
 * When disabled, recordSelfReflection() is a no-op.
 */

import { getConfig } from '@los/infra/config';
import { getLogger } from '@los/infra/logger';
import { getDb } from '@los/infra/db';
import { addObservation, ensureMemoryStore, type Observation } from '../core/store.js';

const log = getLogger('memory-self-reflection');

// ── Types ──────────────────────────────────────────────────

export interface SelfReflectionInput {
  /** Which agent identity produced this insight (e.g., 'default', 'child'). */
  agentIdentity: string;
  /** What the agent learned about itself. */
  insight: string;
  /** 0-1 confidence. Only >= 0.6 insights are recorded. */
  confidence: number;
  /** Sessions that support this insight. */
  evidenceSessionIds: string[];
  /** Category of self-knowledge. */
  category: 'strength' | 'weakness' | 'pattern' | 'preference';
  /** Optional context. */
  sessionId?: string;
  tenantId?: string;
  projectId?: string;
}

export interface AgentSelfInsight {
  agentIdentity: string;
  insight: string;
  category: string;
  confidence: number;
  sessionCount: number;
  evidenceSessionIds: string[];
  firstSeenAt: string;
  lastSeenAt: string;
}

// ── Core ───────────────────────────────────────────────────

/**
 * Record a self-reflective observation. Gated on config.memory.selfReflectionEnabled.
 * No-op when disabled or confidence < 0.6.
 */
export async function recordSelfReflection(input: SelfReflectionInput): Promise<Observation | null> {
  const config = getConfig();
  if (!config.memory.selfReflectionEnabled) {
    log.debug('Self-reflection disabled — skipping record');
    return null;
  }

  if (input.confidence < 0.6) {
    log.debug(`Self-reflection confidence ${input.confidence} below threshold 0.6 — skipping`);
    return null;
  }

  try {
    await ensureMemoryStore();
    return await addObservation({
      title: `[self] ${input.category}: ${input.insight.slice(0, 80)}`,
      summary: input.insight,
      kind: 'self_reflection',
      content: input.insight,
      observerType: 'agent_self',
      sessionId: input.sessionId,
      tenantId: input.tenantId,
      projectId: input.projectId,
      metadata: {
        agentIdentity: input.agentIdentity,
        confidence: input.confidence,
        category: input.category,
        evidenceSessionIds: input.evidenceSessionIds,
        memoryLayer: 'self_reflective',
      },
    });
  } catch (err) {
    log.warn(`Failed to record self-reflection: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * List self-reflective observations for a given agent identity.
 */
export async function listSelfReflections(options: {
  agentIdentity?: string;
  category?: SelfReflectionInput['category'];
  minConfidence?: number;
  limit?: number;
  sessionId?: string;
  tenantId?: string;
  projectId?: string;
}): Promise<Observation[]> {
  const db = getDb();
  await ensureMemoryStore();

  const params: unknown[] = [];
  const clauses: string[] = ["kind = 'self_reflection'"];

  if (options.agentIdentity) {
    params.push(options.agentIdentity);
    clauses.push(`metadata_json->>'agentIdentity' = $${params.length}`);
  }
  if (options.category) {
    params.push(options.category);
    clauses.push(`metadata_json->>'category' = $${params.length}`);
  }
  if (options.minConfidence !== undefined) {
    params.push(options.minConfidence);
    clauses.push(`(metadata_json->>'confidence')::numeric >= $${params.length}`);
  }
  if (options.sessionId) {
    params.push(options.sessionId);
    clauses.push(`session_id = $${params.length}`);
  }
  if (options.tenantId) {
    params.push(options.tenantId);
    clauses.push(`tenant_id = $${params.length}`);
  }
  if (options.projectId) {
    params.push(options.projectId);
    clauses.push(`project_id = $${params.length}`);
  }

  const limit = options.limit ?? 50;
  params.push(limit);

  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = await db.query<Record<string, unknown>>(
    `SELECT * FROM observations ${where} ORDER BY created_at DESC LIMIT $${params.length}`,
    params,
  );

  // Map rows to Observation type
  return rows.rows.map(row => ({
    id: row.id as number,
    title: row.title as string,
    summary: row.summary as string,
    kind: row.kind as string,
    tags: (row.tags_json as string[]) ?? [],
    content: row.content as string,
    metadata: row.metadata_json as Record<string, unknown> ?? {},
    source: row.source as string,
    sessionId: row.session_id as string | undefined,
    tenantId: row.tenant_id as string | undefined,
    projectId: row.project_id as string | undefined,
    userId: row.user_id as string | undefined,
    nodeId: row.node_id as string | undefined,
    requestId: row.request_id as string | undefined,
    traceId: row.trace_id as string | undefined,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }));
}

/**
 * Aggregate self-reflective insights across sessions for a given agent.
 * Groups by insight text similarity and counts supporting sessions.
 * Used by compaction to detect cross-session patterns.
 */
export async function getAgentSelfInsights(options: {
  agentIdentity: string;
  minConfidence?: number;
  minSessions?: number;
  tenantId?: string;
  projectId?: string;
}): Promise<AgentSelfInsight[]> {
  const db = getDb();
  await ensureMemoryStore();

  const params: unknown[] = [options.agentIdentity];
  const minConf = options.minConfidence ?? 0.6;
  params.push(minConf);

  const clauses: string[] = [
    "kind = 'self_reflection'",
    `metadata_json->>'agentIdentity' = $1`,
    `(metadata_json->>'confidence')::numeric >= $2`,
  ];
  if (options.tenantId) { params.push(options.tenantId); clauses.push(`tenant_id = $${params.length}`); }
  if (options.projectId) { params.push(options.projectId); clauses.push(`project_id = $${params.length}`); }

  // Group by insight content (normalized) and count sessions
  const rows = await db.query<{
    insight: string;
    category: string;
    avg_confidence: string;
    session_count: string;
    session_ids: string;
    first_seen: string;
    last_seen: string;
  }>(
    `SELECT
       content AS insight,
       metadata_json->>'category' AS category,
       AVG((metadata_json->>'confidence')::numeric)::text AS avg_confidence,
       COUNT(DISTINCT session_id)::text AS session_count,
       array_agg(DISTINCT session_id)::text AS session_ids,
       MIN(created_at)::text AS first_seen,
       MAX(created_at)::text AS last_seen
     FROM observations
     WHERE ${clauses.join(' AND ')}
     GROUP BY content, metadata_json->>'category'
     HAVING COUNT(DISTINCT session_id) >= $${params.length + 1}
     ORDER BY avg_confidence DESC`,
    [...params, options.minSessions ?? 2],
  );

  return rows.rows.map(r => ({
    agentIdentity: options.agentIdentity,
    insight: r.insight,
    category: r.category,
    confidence: Number(r.avg_confidence),
    sessionCount: Number(r.session_count),
    evidenceSessionIds: parsePgArray(r.session_ids),
    firstSeenAt: r.first_seen,
    lastSeenAt: r.last_seen,
  }));
}

/**
 * Count self-reflective observations in a session.
 * Best-effort: returns 0 on any error.
 */
export async function countSelfReflectionsInSession(sessionId: string): Promise<number> {
  try {
    const db = getDb();
    const rows = await db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM observations
       WHERE session_id = $1 AND kind = 'self_reflection'`,
      [sessionId],
    );
    return Number(rows.rows[0]?.count ?? 0);
  } catch {
    return 0;
  }
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

/**
 * Detect self-reflection patterns during compaction and produce procedural
 * candidates for cross-session insights (3+ sessions).
 *
 * Best-effort: returns empty arrays on any error. Caller should not block
 * compaction on self-reflection detection failures.
 */
export async function detectSelfReflectionCandidates(input: {
  sessionId: string;
  tenantId?: string;
  projectId?: string;
}): Promise<{
  observedPatterns: Array<{ kind: string; count: number; description: string }>;
  proceduralCandidates: Array<{
    name: string;
    content: string;
    severity: 'info' | 'warn' | 'error';
    rationale: string;
    confidence: number;
    status: 'draft' | 'review';
    supportingSessionIds: string[];
  }>;
}> {
  try {
    const count = await countSelfReflectionsInSession(input.sessionId);
    if (count === 0) return { observedPatterns: [], proceduralCandidates: [] };

    const observedPatterns = [{
      kind: 'self_reflection',
      count,
      description: `Session produced ${count} self-reflective observation(s)`,
    }];

    const config = getConfig();
    if (!config.memory.selfReflectionEnabled) {
      return { observedPatterns, proceduralCandidates: [] };
    }

    const selfInsights = await getAgentSelfInsights({
      agentIdentity: 'default',
      minConfidence: 0.6,
      minSessions: 3,
      tenantId: input.tenantId,
      projectId: input.projectId,
    });

    const proceduralCandidates = selfInsights
      .filter(insight => insight.sessionCount >= 3)
      .map(insight => ({
        name: `self-insight-${slugify(insight.insight.slice(0, 40))}`,
        content: `The agent has learned about itself: ${insight.insight}`,
        severity: 'info' as const,
        rationale: `Self-reflection observed in ${insight.sessionCount} session(s). Category: ${insight.category}. Confidence: ${insight.confidence.toFixed(2)}.`,
        confidence: Math.min(insight.confidence, 0.9),
        status: 'review' as const,
        supportingSessionIds: insight.evidenceSessionIds,
      }));

    return { observedPatterns, proceduralCandidates };
  } catch {
    return { observedPatterns: [], proceduralCandidates: [] };
  }
}

function parsePgArray(str: string): string[] {
  try {
    const inner = str.slice(1, -1);
    if (!inner) return [];
    return inner.split(',').map(s => s.replace(/^"|"$/g, '').trim());
  } catch {
    return [];
  }
}
