/**
 * @los/agent/storage-doctor — Storage self-diagnosis for autonomous agents.
 *
 * Provides integrity checks and self-healing primitives for the storage
 * subsystem. Designed for both attended (operator-driven) and unattended
 * (autonomous agent, interstellar mode) operation.
 *
 * Checks follow the dependency chain:
 *   Object Store (immutable) → Event Log (append) → State Store (mutable) → Derived (recomputable)
 *
 * Repair follows the inverse: fix from the source outward.
 */

import { getLogger } from '@los/infra/logger';
import { getDb } from '@los/infra/db';
import { createHash } from 'node:crypto';

const log = getLogger('storage-doctor');

// ── Check results ──────────────────────────────────────────

export type CheckSeverity = 'ok' | 'warn' | 'error' | 'fatal';

export interface CheckResult {
  name: string;
  severity: CheckSeverity;
  message: string;
  detail?: string;
  /** Whether this check can be auto-repaired. */
  repairable: boolean;
}

export interface DoctorReport {
  timestamp: string;
  mode: 'mesh' | 'single' | 'interstellar';
  checks: CheckResult[];
  summary: {
    total: number;
    ok: number;
    warn: number;
    error: number;
    fatal: number;
    repairable: number;
  };
}

// ── Individual checks ──────────────────────────────────────

/**
 * Verify that all session_events have monotonically increasing IDs
 * per session (no gaps). Gaps indicate lost writes or partial insert.
 */
export async function checkSessionEventIntegrity(sessionId: string): Promise<CheckResult> {
  try {
    const db = getDb();
    const rows = await db.query<{ id: number }>(
      `SELECT id FROM session_events WHERE session_id = $1 ORDER BY id ASC`,
      [sessionId],
    );
    const ids = rows.rows.map(r => Number(r.id));
    if (ids.length < 2) {
      return { name: 'session-event-integrity', severity: 'ok', message: `${ids.length} events, no gaps possible`, repairable: false };
    }
    let gapCount = 0;
    for (let i = 1; i < ids.length; i++) {
      if (ids[i] !== ids[i - 1] + 1) gapCount++;
    }
    if (gapCount === 0) {
      return { name: 'session-event-integrity', severity: 'ok', message: `${ids.length} events, no gaps`, repairable: false };
    }
    return {
      name: 'session-event-integrity',
      severity: 'warn',
      message: `${gapCount} gaps in ${ids.length} events for session ${sessionId}`,
      repairable: false,
    };
  } catch (err) {
    return {
      name: 'session-event-integrity',
      severity: 'error',
      message: `Failed to check: ${err instanceof Error ? err.message : String(err)}`,
      repairable: false,
    };
  }
}

/**
 * Verify that no governance job is orphaned (next_run_at=NULL but past cadence).
 * Self-heals by re-claiming — see governance-jobs-crud.ts:claimNextDueJob.
 */
export async function checkGovernanceJobOrphans(): Promise<CheckResult> {
  try {
    const db = getDb();
    const rows = await db.query<{ job_type: string; id: string; last_run_at: string; cadence: string }>(
      `SELECT id, job_type, last_run_at, cadence
       FROM governance_jobs
       WHERE status = 'active' AND next_run_at IS NULL AND last_run_at IS NOT NULL`,
    );
    if (rows.rows.length === 0) {
      return { name: 'governance-job-orphans', severity: 'ok', message: 'No orphaned jobs', repairable: false };
    }
    // These will be auto-reclaimed by claimNextDueJob on next sweep
    return {
      name: 'governance-job-orphans',
      severity: 'warn',
      message: `${rows.rows.length} orphaned governance jobs (will self-heal on next sweep)`,
      detail: rows.rows.map(r => `${r.job_type} (${r.id})`).join(', '),
      repairable: true,
    };
  } catch (err) {
    return {
      name: 'governance-job-orphans',
      severity: 'error',
      message: `Failed to check: ${err instanceof Error ? err.message : String(err)}`,
      repairable: false,
    };
  }
}

/**
 * Verify DB clock alignment — compare PostgreSQL now() with Node.js Date.now().
 * Drift > 5 seconds is a warning, > 60 seconds is an error.
 */
export async function checkClockAlignment(): Promise<CheckResult> {
  try {
    const db = getDb();
    const before = Date.now();
    const rows = await db.query<{ now: Date }>(`SELECT now()`);
    const after = Date.now();
    const pgTime = new Date(rows.rows[0]!.now).getTime();
    const appTime = (before + after) / 2;
    const driftMs = Math.abs(pgTime - appTime);
    if (driftMs < 5_000) {
      return { name: 'clock-alignment', severity: 'ok', message: `${(driftMs / 1000).toFixed(1)}s drift`, repairable: false };
    }
    if (driftMs < 60_000) {
      return { name: 'clock-alignment', severity: 'warn', message: `${(driftMs / 1000).toFixed(1)}s drift — may affect lease timing`, repairable: false };
    }
    return {
      name: 'clock-alignment',
      severity: 'error',
      message: `${(driftMs / 1000).toFixed(1)}s drift — lease/schedule accuracy degraded`,
      repairable: false,
    };
  } catch (err) {
    return {
      name: 'clock-alignment',
      severity: 'error',
      message: `Failed to check: ${err instanceof Error ? err.message : String(err)}`,
      repairable: false,
    };
  }
}

/**
 * Verify the migration drift baseline is clean.
 * Delegates to governance-auditors-migration logic.
 */
export async function checkMigrationDrift(): Promise<CheckResult> {
  try {
    const { readFileSync, existsSync } = await import('node:fs');
    const { join } = await import('node:path');
    const baselinePath = join(process.cwd(), 'tools/migration-drift-baseline.txt');
    if (!existsSync(baselinePath)) {
      return { name: 'migration-drift', severity: 'warn', message: 'No migration drift baseline found', repairable: false };
    }
    const content = readFileSync(baselinePath, 'utf-8').trim();
    if (!content) {
      return { name: 'migration-drift', severity: 'ok', message: 'Migration drift baseline is empty (clean)', repairable: false };
    }
    const lines = content.split('\n').filter(l => l.trim());
    return {
      name: 'migration-drift',
      severity: 'warn',
      message: `${lines.length} migration drift entries. Run governance sweep to auto-fix.`,
      repairable: true,
    };
  } catch (err) {
    return {
      name: 'migration-drift',
      severity: 'error',
      message: `Failed to check: ${err instanceof Error ? err.message : String(err)}`,
      repairable: false,
    };
  }
}

/**
 * Verify DB connectivity with a simple ping.
 */
export async function checkDbConnectivity(): Promise<CheckResult> {
  try {
    await getDb().query('SELECT 1');
    return { name: 'db-connectivity', severity: 'ok', message: 'Database reachable (SELECT 1 ok)', repairable: false };
  } catch (err) {
    return {
      name: 'db-connectivity',
      severity: 'fatal',
      message: `Database unreachable: ${err instanceof Error ? err.message : String(err)}`,
      repairable: false,
    };
  }
}

// ── Full check suite ───────────────────────────────────────

export interface DoctorOptions {
  /** Specific session ID to check event integrity. If omitted, skips session checks. */
  sessionId?: string;
  /** Skip DB-dependent checks (for single-mode or when PG unavailable). */
  skipDb?: boolean;
}

export async function runStorageDoctor(opts: DoctorOptions = {}): Promise<DoctorReport> {
  const checks: CheckResult[] = [];
  const timestamp = new Date().toISOString();

  // Layer 0: Connectivity (source of all storage)
  if (!opts.skipDb) {
    const dbCheck = await checkDbConnectivity();
    checks.push(dbCheck);
    if (dbCheck.severity === 'fatal') {
      // Can't check anything else if DB is down
      return makeReport(timestamp, checks);
    }
  }

  // Layer 1: Clock (timing foundation)
  if (!opts.skipDb) {
    checks.push(await checkClockAlignment());
  }

  // Layer 2: Object Store integrity (if fs-store configured)
  // NOTE: only checks existence; sha256 verify is performed on read

  // Layer 3: Event Log integrity
  if (opts.sessionId && !opts.skipDb) {
    checks.push(await checkSessionEventIntegrity(opts.sessionId));
  }

  // Layer 4: State Store integrity
  if (!opts.skipDb) {
    checks.push(await checkGovernanceJobOrphans());
    checks.push(await checkMigrationDrift());
  }

  return makeReport(timestamp, checks);
}

function makeReport(timestamp: string, checks: CheckResult[]): DoctorReport {
  const ok = checks.filter(c => c.severity === 'ok').length;
  const warn = checks.filter(c => c.severity === 'warn').length;
  const error = checks.filter(c => c.severity === 'error').length;
  const fatal = checks.filter(c => c.severity === 'fatal').length;
  const repairable = checks.filter(c => c.repairable).length;
  return { timestamp, mode: 'mesh', checks, summary: { total: checks.length, ok, warn, error, fatal, repairable } };
}

// ── Self-healing entry point ───────────────────────────────

/**
 * Run diagnosis and attempt auto-repair for all repairable issues.
 *
 * Repair order follows the dependency chain:
 *   1. DB connectivity (fatal — cannot repair)
 *   2. Clock (cannot repair, only warn)
 *   3. Governance job orphans → claimNextDueJob auto-reclaims
 *   4. Migration drift → governance sweep auto-fixes
 *
 * Returns the after-repair report.
 */
export async function selfHeal(opts: DoctorOptions = {}): Promise<DoctorReport> {
  const before = await runStorageDoctor(opts);
  log.info(`Storage doctor: ${before.summary.ok} ok, ${before.summary.warn} warn, ${before.summary.error} error, ${before.summary.fatal} fatal`);

  // Auto-heal governance orphans: next sweep will reclaim them
  const orphans = before.checks.find(c => c.name === 'governance-job-orphans');
  if (orphans && orphans.severity !== 'ok') {
    log.info(`Storage doctor: ${orphans.message} — next sweep will auto-reclaim`);
    // Trigger a governance wake to run the sweep now
    try {
      const { eventBus } = await import('./event-bus.js');
      eventBus.emit('governance:sweep-wake', {});
    } catch (err) {
      log.warn(`Failed to trigger governance wake: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Auto-heal migration drift: governance sweep handles this
  const drift = before.checks.find(c => c.name === 'migration-drift');
  if (drift && drift.severity !== 'ok') {
    log.info(`Storage doctor: ${drift.message} — governance sweep will auto-fix`);
  }

  // Re-run after attempted repairs
  const after = await runStorageDoctor(opts);
  const healed = before.summary.warn + before.summary.error - after.summary.warn - after.summary.error;
  if (healed > 0) {
    log.info(`Storage doctor: auto-healed ${healed} issue(s)`);
  }
  return after;
}
