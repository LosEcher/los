/**
 * @los/memory/decay — Observation decay scoring model.
 *
 * Four-factor weighted model that computes a staleness score [0,1] for
 * each observation. Scores below {@link STALE_THRESHOLD} (0.3) are
 * considered stale and candidates for compaction pruning.
 *
 * ## Factors
 *
 * 1. **baseScore** — exponential time-decay over 24h (1.0→0.1). The
 *    older an observation, the lower its baseline value.
 *
 * 2. **recencyFactor** — stepwise recency bonus:
 *    - < 1h: 1.0 (fresh)
 *    - 1-6h: 0.8
 *    - 6-24h: 0.5
 *    - > 24h: 0.3
 *
 * 3. **referenceCountFactor** — observations referenced by other
 *    observations or tool calls retain higher value:
 *    - 0 refs: 0.7
 *    - 1 ref:  0.85
 *    - ≥ 2 refs: 1.0
 *
 * 4. **toolStatusFactor** — tool-call liveness protects active work;
 *    failed/cancelled calls reduce retention priority:
 *    - running/requested: 1.0
 *    - failed/cancelled:  0.5
 *    - succeeded / no tool: 0.8
 *
 * ## Composite
 *
 * ```
 * score = baseScore × recencyFactor × referenceCountFactor × toolStatusFactor
 * ```
 *
 * Clamped to [0, 1]. Scores below {@link STALE_THRESHOLD} are stale.
 */

import { getDb } from '@los/infra/db';

/** Score below which an observation is considered stale. */
export const STALE_THRESHOLD = 0.3;

/** Observation data required for decay scoring. */
export interface DecayObservation {
  createdAt: Date;
  /** Number of times this observation is referenced by others. */
  referenceCount: number;
  /** Associated tool call status, if any. */
  toolStatus?: 'running' | 'requested' | 'succeeded' | 'failed' | 'cancelled';
}

export interface DecayScoreResult {
  score: number;
  stale: boolean;
  factors: {
    base: number;
    recency: number;
    referenceCount: number;
    toolStatus: number;
  };
}

// ── Individual factors ─────────────────────────────────────────

/** Exponential time-decay: hoursSince=0→1.0, 8h→0.37, 24h→0.05 (floor 0.1). */
function baseScore(createdAt: Date): number {
  const hoursSince = (Date.now() - createdAt.getTime()) / 3_600_000;
  return Math.max(0.1, Number(Math.exp(-hoursSince / 8).toFixed(4)));
}

/** Stepwise recency bonus. */
function recencyFactor(createdAt: Date): number {
  const hoursSince = (Date.now() - createdAt.getTime()) / 3_600_000;
  if (hoursSince < 1) return 1.0;
  if (hoursSince < 6) return 0.8;
  if (hoursSince < 24) return 0.5;
  return 0.3;
}

/** Reference count multiplier. */
function referenceCountFactor(refCount: number): number {
  if (refCount >= 2) return 1.0;
  if (refCount === 1) return 0.85;
  return 0.7;
}

/** Tool-call liveness multiplier. */
function toolStatusFactor(status?: string): number {
  switch (status) {
    case 'running':
    case 'requested':
      return 1.0;
    case 'failed':
    case 'cancelled':
      return 0.5;
    default:
      return 0.8;
  }
}

// ── Public API ──────────────────────────────────────────────────

/**
 * Compute the decay score for a single observation.
 *
 * Returns a clamped [0,1] score and a breakdown of contributing factors.
 * Scores below {@link STALE_THRESHOLD} are marked stale.
 */
export function decayScore(obs: DecayObservation): DecayScoreResult {
  const base = baseScore(obs.createdAt);
  const recency = recencyFactor(obs.createdAt);
  const referenceCount = referenceCountFactor(obs.referenceCount);
  const toolStatus = toolStatusFactor(obs.toolStatus);

  const raw = base * recency * referenceCount * toolStatus;
  const score = Math.min(1, Math.max(0, Number(raw.toFixed(4))));

  return {
    score,
    stale: score < STALE_THRESHOLD,
    factors: { base, recency, referenceCount, toolStatus },
  };
}

/**
 * Compute decay scores for multiple observations in a session.
 * Returns per-observation scores plus session-level summary.
 */
export function decayScores(
  observations: DecayObservation[],
): { scores: DecayScoreResult[]; staleCount: number; staleRatio: number; averageScore: number } {
  if (observations.length === 0) {
    return { scores: [], staleCount: 0, staleRatio: 0, averageScore: 1 };
  }

  const scores = observations.map(decayScore);
  const staleCount = scores.filter(s => s.stale).length;

  const sum = scores.reduce((acc, s) => acc + s.score, 0);
  const averageScore = Number((sum / scores.length).toFixed(4));

  return {
    scores,
    staleCount,
    staleRatio: Number((staleCount / observations.length).toFixed(4)),
    averageScore,
  };
}

// ── DB-backed scoring for a session ─────────────────────────────

/**
 * Result of calculating decay scores for all observations in a session.
 */
export interface SessionDecayResult {
  sessionId: string;
  observationCount: number;
  results: DecayScoreResult[];
  staleObservationIds: number[];
  staleCount: number;
  staleRatio: number;
  averageScore: number;
}

/**
 * Query all non-archived observations in a session and compute decay scores
 * for each. Returns per-observation scores plus session-level aggregates.
 */
export async function calculateDecayScores(sessionId: string): Promise<SessionDecayResult> {
  const db = getDb();
  const rows = await db.query<{
    id: string;
    created_at: string;
    reference_count: string;
    tool_status: string | null;
  }>(
    `SELECT
       id::text,
       created_at,
       COALESCE((metadata_json->>'referenceCount')::int, 0)::text AS reference_count,
       metadata_json->>'toolStatus' AS tool_status
     FROM observations
     WHERE session_id = $1
       AND COALESCE(metadata_json->>'archived', 'false') = 'false'
     ORDER BY created_at`,
    [sessionId],
  );

  const observations: DecayObservation[] = rows.rows.map(r => ({
    createdAt: new Date(r.created_at),
    referenceCount: Number(r.reference_count),
    toolStatus: (r.tool_status as DecayObservation['toolStatus']) ?? undefined,
  }));

  const aggregate = decayScores(observations);
  const staleObservationIds = aggregate.scores
    .map((s, i) => (s.stale ? Number(rows.rows[i].id) : -1))
    .filter(id => id >= 0);

  return {
    sessionId,
    observationCount: observations.length,
    results: aggregate.scores,
    staleObservationIds,
    staleCount: aggregate.staleCount,
    staleRatio: aggregate.staleRatio,
    averageScore: aggregate.averageScore,
  };
}

// ── Auto-trigger rules ──────────────────────────────────────────

/** Trigger decision from decay-based rules. */
export interface TriggerDecision {
  triggered: boolean;
  /** Reason code: low_decay, high_stale, none. */
  reason: 'low_decay' | 'high_stale' | 'none';
  averageScore: number;
  staleRatio: number;
  observationCount: number;
}

/**
 * Evaluate whether compaction should be triggered for a session based on
 * decay scores. Rules (checked in order):
 *
 * 1. **Low decay + volume**: averageScore < 0.3 AND ≥ 20 observations
 * 2. **High stale ratio**: staleRatio > 0.4 (40%)
 *
 * The 24h safety-net timer is handled by the caller (server-maintenance)
 * and is not evaluated here.
 */
export async function shouldTriggerCompaction(sessionId: string): Promise<TriggerDecision> {
  const result = await calculateDecayScores(sessionId);

  if (result.observationCount === 0) {
    return { triggered: false, reason: 'none', averageScore: 1, staleRatio: 0, observationCount: 0 };
  }

  // Rule 1: low average score plus volume
  if (result.averageScore < 0.3 && result.observationCount >= 20) {
    return {
      triggered: true,
      reason: 'low_decay',
      averageScore: result.averageScore,
      staleRatio: result.staleRatio,
      observationCount: result.observationCount,
    };
  }

  // Rule 2: high stale ratio
  if (result.staleRatio > 0.4) {
    return {
      triggered: true,
      reason: 'high_stale',
      averageScore: result.averageScore,
      staleRatio: result.staleRatio,
      observationCount: result.observationCount,
    };
  }

  return {
    triggered: false,
    reason: 'none',
    averageScore: result.averageScore,
    staleRatio: result.staleRatio,
    observationCount: result.observationCount,
  };
}
