/**
 * @los/memory/compaction/compaction-evidence — Cross-session evidence lookup.
 *
 * Searches existing compactions across other sessions for matching
 * observed pattern kinds. Used during compaction to determine whether
 * a pattern has been observed in multiple sessions.
 */

import { getDb } from '@los/infra/db';

/**
 * Search existing compactions across other sessions for matching observed patterns.
 * Caller must have called ensureMemoryCompactionStore() first. Returns distinct session counts.
 */
export async function lookupCrossSessionEvidence(
  sessionId: string,
  patternKinds: string[],
): Promise<Map<string, number>> {
  if (patternKinds.length === 0) return new Map();
  const db = getDb();
  const counts = new Map<string, number>();

  for (const kind of patternKinds) {
    const rows = await db.query<{ cnt: string }>(
      `SELECT COUNT(DISTINCT session_id)::text AS cnt
       FROM memory_compactions
       WHERE session_id != $1
         AND observed_patterns_json @> $2::jsonb`,
      [sessionId, JSON.stringify([{ kind }])],
    );
    const count = Number(rows.rows[0]?.cnt ?? 0);
    if (count > 0) counts.set(kind, count);
  }
  return counts;
}
