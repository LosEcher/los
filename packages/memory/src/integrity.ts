/**
 * @los/memory/integrity — Standalone memory integrity checks.
 *
 * Independent from the governance sweeper. Can run via
 * `los doctor` checks, CI, or ad-hoc validation.
 */

import { getDb } from '@los/infra/db';
import { getLogger } from '@los/infra/logger';
import { ensureMemoryStore } from './store.js';
import { ensureMemoryCompactionStore } from './compaction.js';
import { ensureProceduralCandidateStore } from './procedural-candidates.js';

const log = getLogger('memory-integrity');

export interface MemoryIntegrityCheck {
  name: string;
  passed: boolean;
  detail: string;
  severity: 'error' | 'warn' | 'info';
}

export interface MemoryIntegrityReport {
  passed: boolean;
  checkedAt: string;
  checks: MemoryIntegrityCheck[];
}

/**
 * Run all memory integrity checks. Returns a report with per-check results.
 * `passed` is true only when no checks have severity 'error'.
 */
export async function checkMemoryIntegrity(): Promise<MemoryIntegrityReport> {
  await Promise.all([
    ensureMemoryStore(),
    ensureMemoryCompactionStore(),
    ensureProceduralCandidateStore(),
  ]);

  const checks: MemoryIntegrityCheck[] = [];

  checks.push(await checkCompactionSessionValidity());
  checks.push(await checkCandidateStatusConsistency());
  checks.push(await checkOrphanedCompactions());
  checks.push(await checkSearchVectorFreshness());
  checks.push(await checkObservationCompactionRatio());

  const passed = checks.every(c => c.severity !== 'error');

  const report: MemoryIntegrityReport = {
    passed,
    checkedAt: new Date().toISOString(),
    checks,
  };

  log.info(`Memory integrity check: ${passed ? 'passed' : 'FAILED'} (${checks.length} checks)`);
  return report;
}

/**
 * Sessions with observations should have compactions (if the session is >1h old).
 * Warns on sessions with >= 10 observations and no compaction.
 */
async function checkCompactionSessionValidity(): Promise<MemoryIntegrityCheck> {
  try {
    const db = getDb();
    const rows = await db.query<{ cnt: string }>(
      `SELECT COUNT(DISTINCT o.session_id)::text AS cnt
       FROM observations o
       LEFT JOIN memory_compactions mc ON o.session_id = mc.session_id
       WHERE o.session_id IS NOT NULL
         AND mc.id IS NULL
         AND o.created_at < now() - INTERVAL '1 hour'`,
    );

    const count = Number(rows.rows[0]?.cnt ?? 0);
    if (count === 0) {
      return { name: 'compaction-session-validity', passed: true, detail: 'All observation sessions have compactions', severity: 'info' };
    }
    if (count <= 10) {
      return { name: 'compaction-session-validity', passed: true, detail: `${count} uncompacted session(s) — within tolerance`, severity: 'info' };
    }
    return { name: 'compaction-session-validity', passed: false, detail: `${count} sessions have observations but no compaction`, severity: 'warn' };
  } catch (err) {
    return { name: 'compaction-session-validity', passed: false, detail: `Query failed: ${err instanceof Error ? err.message : String(err)}`, severity: 'error' };
  }
}

/**
 * Procedural candidates with status 'approved' for >7 days without promotion
 * indicate a review backlog or stuck pipeline.
 */
async function checkCandidateStatusConsistency(): Promise<MemoryIntegrityCheck> {
  try {
    const db = getDb();
    const rows = await db.query<{ cnt: string; names: string }>(
      `SELECT COUNT(*)::text AS cnt,
              COALESCE(string_agg(name, ', ' ORDER BY updated_at), '') AS names
       FROM procedural_candidates
       WHERE status = 'approved'
         AND updated_at < now() - INTERVAL '7 days'`,
    );

    const count = Number(rows.rows[0]?.cnt ?? 0);
    if (count === 0) {
      return { name: 'candidate-status-consistency', passed: true, detail: 'No stale approved candidates', severity: 'info' };
    }
    return {
      name: 'candidate-status-consistency',
      passed: false,
      detail: `${count} candidate(s) stuck in 'approved' for >7 days: ${rows.rows[0]?.names ?? 'unknown'}`,
      severity: 'warn',
    };
  } catch (err) {
    return { name: 'candidate-status-consistency', passed: false, detail: `Query failed: ${err instanceof Error ? err.message : String(err)}`, severity: 'error' };
  }
}

/**
 * Compactions that reference observations not in the observations table
 * (possible if observations were manually deleted without cascading).
 */
async function checkOrphanedCompactions(): Promise<MemoryIntegrityCheck> {
  try {
    const db = getDb();
    // Check: compactions with observationCount > 0 where the session_id
    // no longer has any observations in the observations table
    const rows = await db.query<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt
       FROM memory_compactions mc
       WHERE CAST(mc.summary_json->>'observationCount' AS integer) > 0
         AND NOT EXISTS (
           SELECT 1 FROM observations o
           WHERE o.session_id = mc.session_id
         )`,
    );

    const count = Number(rows.rows[0]?.cnt ?? 0);
    if (count === 0) {
      return { name: 'orphaned-compactions', passed: true, detail: 'No orphaned compactions', severity: 'info' };
    }
    return { name: 'orphaned-compactions', passed: false, detail: `${count} compaction(s) reference deleted observation sessions`, severity: 'warn' };
  } catch (err) {
    return { name: 'orphaned-compactions', passed: false, detail: `Query failed: ${err instanceof Error ? err.message : String(err)}`, severity: 'error' };
  }
}

/**
 * Check whether the tsvector search_vector is potentially stale.
 * The search_vector is GENERATED ALWAYS AS, so it stays in sync on UPDATE,
 * but bulk data imports or schema changes could theorically cause drift.
 */
async function checkSearchVectorFreshness(): Promise<MemoryIntegrityCheck> {
  try {
    const db = getDb();
    // Check for observations updated > 1s after created_at where the
    // title/summary/content differs from what the tsvector would produce.
    // This is a lightweight heuristic — a full reindex would be heavier.
    const rows = await db.query<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt
       FROM observations
       WHERE updated_at > created_at + INTERVAL '1 second'
         AND search_vector IS NOT NULL`,
    );

    const count = Number(rows.rows[0]?.cnt ?? 0);
    if (count === 0) {
      return { name: 'search-vector-freshness', passed: true, detail: 'No search vector concerns detected', severity: 'info' };
    }
    return { name: 'search-vector-freshness', passed: true, detail: `${count} observation(s) updated — search_vector auto-regenerated on UPDATE`, severity: 'info' };
  } catch (err) {
    return { name: 'search-vector-freshness', passed: false, detail: `Query failed: ${err instanceof Error ? err.message : String(err)}`, severity: 'error' };
  }
}

/**
 * Observation-to-compaction ratio. A very high ratio suggests runaway
 * observation growth without compaction. A very low ratio suggests
 * observations are being aggressively cleaned up.
 */
async function checkObservationCompactionRatio(): Promise<MemoryIntegrityCheck> {
  try {
    const db = getDb();
    const obsRows = await db.query<{ cnt: string }>('SELECT COUNT(*)::text AS cnt FROM observations');
    const compRows = await db.query<{ cnt: string }>('SELECT COUNT(*)::text AS cnt FROM memory_compactions');

    const obsCount = Number(obsRows.rows[0]?.cnt ?? 0);
    const compCount = Number(compRows.rows[0]?.cnt ?? 0);

    if (obsCount === 0 && compCount === 0) {
      return { name: 'observation-compaction-ratio', passed: true, detail: 'No observations or compactions — fresh DB', severity: 'info' };
    }

    const ratio = compCount > 0 ? Math.round(obsCount / compCount) : obsCount;
    const detail = `${obsCount} observations / ${compCount} compactions = ${ratio}:1 ratio`;

    if (compCount === 0 && obsCount > 50) {
      return { name: 'observation-compaction-ratio', passed: false, detail: `${detail} — ${obsCount} observations with zero compactions`, severity: 'warn' };
    }
    if (ratio > 100 && compCount > 0) {
      return { name: 'observation-compaction-ratio', passed: false, detail: `${detail} — high ratio, consider compacting old sessions`, severity: 'warn' };
    }
    return { name: 'observation-compaction-ratio', passed: true, detail, severity: 'info' };
  } catch (err) {
    return { name: 'observation-compaction-ratio', passed: false, detail: `Query failed: ${err instanceof Error ? err.message : String(err)}`, severity: 'error' };
  }
}
