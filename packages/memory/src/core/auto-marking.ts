/**
 * @los/memory/auto-marking — Decay-driven stale observation archiving.
 *
 * Approved operator policy (2026-07-31): archive observations whose decay
 * score is very low (score < AUTO_MARK_SCORE, i.e. decayRate > 0.8), that
 * have zero references, whose tool call is not in-flight (running/requested),
 * and whose kind is a plain note/info observation. Task- or failure-associated
 * observations are never auto-archived. Each archive writes an audit trail
 * into the observation metadata (archived=true, archivedAt, archivedBy,
 * archivedReason='auto-decay') and is reported as a candidate for operator
 * review. A 24h fallback runs inside gateway server-maintenance.
 */

import { getDb } from '@los/infra/db';
import { getLogger } from '@los/infra/logger';
import { ensureMemoryStore } from './store.js';
import { decayScore, type DecayObservation } from './decay.js';

const log = getLogger('memory-auto-marking');

/** Score below which an observation qualifies for auto-archiving (decayRate > 0.8). */
export const AUTO_MARK_SCORE = 0.2;

/** Kinds that are never auto-archived (task- or failure-associated). */
const PROTECTED_KINDS = new Set([
  'task',
  'failed',
  'tool_result',
  'error',
  'eval',
  'executor_failover',
]);

export interface AutoMarkingCandidate {
  observationId: number;
  score: number;
  kind: string;
}

export interface AutoMarkingResult {
  sessionId: string;
  archivedCount: number;
  skippedCount: number;
  candidates: AutoMarkingCandidate[];
}

interface ObservationRow {
  id: string;
  kind: string;
  created_at: string;
  reference_count: string;
  tool_status: string | null;
  task_run_id: string | null;
}

/**
 * Archive stale plain observations for one session. Never touches protected
 * kinds, in-flight tool calls, referenced observations, or task-associated
 * rows. Safe to call repeatedly — already-archived rows are skipped.
 */
export async function archiveStaleObservations(sessionId: string): Promise<AutoMarkingResult> {
  await ensureMemoryStore();
  const db = getDb();
  const rows = await db.query<ObservationRow>(
    `SELECT id::text, kind, created_at,
            COALESCE((metadata_json->>'referenceCount')::int, 0)::text AS reference_count,
            metadata_json->>'toolStatus' AS tool_status,
            metadata_json->>'taskRunId' AS task_run_id
     FROM observations
     WHERE session_id = $1
       AND COALESCE(metadata_json->>'archived', 'false') = 'false'`,
    [sessionId],
  );

  const candidates: AutoMarkingCandidate[] = [];
  let skippedCount = 0;
  for (const row of rows.rows) {
    const observation: DecayObservation = {
      createdAt: new Date(row.created_at),
      referenceCount: Number(row.reference_count),
      toolStatus: row.tool_status as DecayObservation['toolStatus'] ?? undefined,
    };
    const result = decayScore(observation);
    const inFlight = observation.toolStatus === 'running' || observation.toolStatus === 'requested';
    const protectedKind = PROTECTED_KINDS.has(row.kind);
    const taskAssociated = Boolean(row.task_run_id);
    const qualifies = result.score < AUTO_MARK_SCORE
      && observation.referenceCount === 0
      && !inFlight
      && !protectedKind
      && !taskAssociated;
    if (!qualifies) {
      skippedCount += 1;
      continue;
    }
    candidates.push({
      observationId: Number(row.id),
      score: result.score,
      kind: row.kind,
    });
  }

  if (candidates.length === 0) {
    return { sessionId, archivedCount: 0, skippedCount, candidates };
  }

  const ids = candidates.map(candidate => candidate.observationId);
  await db.query(
    `UPDATE observations
     SET metadata_json = jsonb_set(
           jsonb_set(
             jsonb_set(metadata_json, '{archived}', 'true'),
             '{archivedAt}', to_jsonb(now()::text)
           ),
           '{archivedBy}', to_jsonb($2::text)
         ) || jsonb_build_object('archivedReason', 'auto-decay')
     WHERE id = ANY($1::bigint[])`,
    [ids, 'auto-decay'],
  );
  if (candidates.length > 0) {
    log.info(
      `Auto-archived ${candidates.length} stale observation(s) in session ${sessionId} ` +
      `(candidates: ${candidates.map(c => `${c.observationId}@${c.score.toFixed(2)}`).join(', ')})`,
    );
  }
  return { sessionId, archivedCount: candidates.length, skippedCount, candidates };
}
