/**
 * @los/memory/retention — Configurable retention and cleanup policy.
 *
 * Periodically archives old observations and hard-deletes orphaned ones.
 * Observations with metadata.retention = 'permanent' are never touched.
 */

import { getDb } from '@los/infra/db';
import { getLogger } from '@los/infra/logger';
import { ensureMemoryStore } from './store.js';
import { ensureMemoryCompactionStore } from './compaction.js';

const log = getLogger('memory-retention');

export interface RetentionPolicy {
  /** Archive observations older than this many days (metadata.archived = 'true') */
  archiveAfterDays: number;
  /** Archive compacted-session observations after this many days */
  compactedArchiveAfterDays: number;
  /** Hard-delete orphaned observations (no session_id) after this many days */
  deleteOrphanedAfterDays: number;
  /** If true, observations with metadata.retention = 'permanent' are never touched */
  respectPermanent: boolean;
}

export interface RetentionResult {
  archivedCount: number;
  deletedCount: number;
  errors: string[];
}

export const DEFAULT_RETENTION_POLICY: RetentionPolicy = {
  archiveAfterDays: 90,
  compactedArchiveAfterDays: 30,
  deleteOrphanedAfterDays: 180,
  respectPermanent: true,
};

function permanentClause(policy: RetentionPolicy): string {
  return policy.respectPermanent
    ? `AND coalesce(metadata_json->>'retention', '') != 'permanent'`
    : '';
}

/**
 * Apply the retention policy. Archives old observations and hard-deletes
 * orphaned ones that exceed the configured age thresholds.
 *
 * Safe to call repeatedly — archived observations are skipped, deleted ones
 * are gone.
 */
export async function applyRetentionPolicy(
  policyOverride?: Partial<RetentionPolicy>,
): Promise<RetentionResult> {
  const policy = { ...DEFAULT_RETENTION_POLICY, ...policyOverride };
  await ensureMemoryStore();
  await ensureMemoryCompactionStore();

  const db = getDb();
  const result: RetentionResult = { archivedCount: 0, deletedCount: 0, errors: [] };

  // 1. Archive old uncompacted observations
  try {
    const archived = await db.query<{ cnt: string }>(
      `WITH updated AS (
         UPDATE observations
         SET metadata_json = jsonb_set(
           jsonb_set(metadata_json, '{archived}', 'true'),
           '{archivedAt}', to_jsonb(now()::text)
         )
         WHERE coalesce(metadata_json->>'archived', 'false') = 'false'
           AND created_at < now() - ($1 || ' days')::interval
           ${permanentClause(policy)}
         RETURNING id
       ) SELECT COUNT(*)::text AS cnt FROM updated`,
      [String(policy.archiveAfterDays)],
    );
    result.archivedCount += Number(archived.rows[0]?.cnt ?? 0);
    if (result.archivedCount > 0) {
      log.info(`Archived ${result.archivedCount} old observations (>${policy.archiveAfterDays}d)`);
    }
  } catch (err) {
    const msg = `Archive step failed: ${err instanceof Error ? err.message : String(err)}`;
    result.errors.push(msg);
    log.error(msg);
  }

  // 2. Archive compacted-session observations (sessions with compactions > N days old)
  try {
    const compactArchived = await db.query<{ cnt: string }>(
      `WITH compacted_sessions AS (
         SELECT DISTINCT session_id FROM memory_compactions
         WHERE created_at < now() - ($1 || ' days')::interval
           AND session_id IS NOT NULL
       ),
       updated AS (
         UPDATE observations o
         SET metadata_json = jsonb_set(
           jsonb_set(metadata_json, '{archived}', 'true'),
           '{archivedAt}', to_jsonb(now()::text)
         )
         FROM compacted_sessions cs
         WHERE o.session_id = cs.session_id
           AND coalesce(o.metadata_json->>'archived', 'false') = 'false'
           ${permanentClause(policy)}
         RETURNING o.id
       ) SELECT COUNT(*)::text AS cnt FROM updated`,
      [String(policy.compactedArchiveAfterDays)],
    );
    const compactArchivedCount = Number(compactArchived.rows[0]?.cnt ?? 0);
    result.archivedCount += compactArchivedCount;
    if (compactArchivedCount > 0) {
      log.info(`Archived ${compactArchivedCount} compacted-session observations (>${policy.compactedArchiveAfterDays}d)`);
    }
  } catch (err) {
    const msg = `Compacted archive step failed: ${err instanceof Error ? err.message : String(err)}`;
    result.errors.push(msg);
    log.error(msg);
  }

  // 3. Hard-delete orphaned observations (no session_id, very old)
  try {
    const deleted = await db.query<{ cnt: string }>(
      `WITH deleted AS (
         DELETE FROM observations
         WHERE session_id IS NULL
           AND created_at < now() - ($1 || ' days')::interval
           ${permanentClause(policy)}
         RETURNING id
       ) SELECT COUNT(*)::text AS cnt FROM deleted`,
      [String(policy.deleteOrphanedAfterDays)],
    );
    result.deletedCount += Number(deleted.rows[0]?.cnt ?? 0);
    if (result.deletedCount > 0) {
      log.info(`Deleted ${result.deletedCount} orphaned observations (>${policy.deleteOrphanedAfterDays}d)`);
    }
  } catch (err) {
    const msg = `Delete step failed: ${err instanceof Error ? err.message : String(err)}`;
    result.errors.push(msg);
    log.error(msg);
  }

  return result;
}
