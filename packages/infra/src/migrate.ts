/**
 * @los/infra/migrate — Ordered database migration runner.
 *
 * Reads versioned .sql files from a migrations/ directory, tracks applied
 * migrations in a `schema_migrations` table, and applies any that haven't
 * been run yet. This replaces the ad-hoc `CREATE TABLE IF NOT EXISTS` +
 * `ALTER TABLE ADD COLUMN IF NOT EXISTS` pattern used by individual
 * `ensure*Store()` functions.
 *
 * Usage:
 *   await migrateDir('/path/to/migrations', db);
 *
 * Migration files follow the pattern: `<seq>_<name>.sql`
 * Example: `001_initial_task_runs.sql`, `002_add_tool_call_states.sql`
 *
 * Files are sorted lexicographically by filename (which matches seq ordering
 * when using zero-padded numeric prefixes). Each file is executed in a
 * transaction. Applied migrations are recorded in schema_migrations; files
 * with the same seq are skipped on subsequent runs.
 */

import type { DbConnection } from './db.js';
import { readdirSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';

const MIGRATIONS_TABLE = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  seq TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
)`;

export interface MigrationRecord {
  seq: string;
  name: string;
  appliedAt: string;
}

async function ensureMigrationsTable(db: DbConnection): Promise<void> {
  await db.exec(MIGRATIONS_TABLE);
}

async function getAppliedSeqs(db: DbConnection): Promise<Set<string>> {
  await ensureMigrationsTable(db);
  const result = await db.query<{ seq: string }>('SELECT seq FROM schema_migrations');
  return new Set(result.rows.map(r => r.seq));
}

async function recordMigration(db: DbConnection, seq: string, name: string): Promise<void> {
  await db.query('INSERT INTO schema_migrations (seq, name) VALUES ($1, $2)', [seq, name]);
}

export interface MigrateResult {
  applied: string[];
  skipped: string[];
  errors: string[];
}

export async function migrateDir(migrationsDir: string, db: DbConnection): Promise<MigrateResult> {
  await ensureMigrationsTable(db);

  let files: string[];
  try {
    files = readdirSync(migrationsDir)
      .filter(f => f.endsWith('.sql'))
      .sort();
  } catch {
    return { applied: [], skipped: [], errors: [`Cannot read migrations dir: ${migrationsDir}`] };
  }

  if (files.length === 0) return { applied: [], skipped: [], errors: [] };

  const appliedSeqs = await getAppliedSeqs(db);
  const result: MigrateResult = { applied: [], skipped: [], errors: [] };

  for (const file of files) {
    const seq = file.replace(/_.*$/, '');
    if (appliedSeqs.has(seq)) {
      result.skipped.push(file);
      continue;
    }

    try {
      const sql = readFileSync(join(migrationsDir, file), 'utf-8');
      await db.exec(sql);
      await recordMigration(db, seq, basename(file));
      result.applied.push(file);
    } catch (err: any) {
      result.errors.push(`${file}: ${err.message}`);
    }
  }

  return result;
}

export async function loadAppliedMigrations(db: DbConnection): Promise<MigrationRecord[]> {
  await ensureMigrationsTable(db);
  const result = await db.query<{ seq: string; name: string; applied_at: string }>(
    'SELECT seq, name, applied_at FROM schema_migrations ORDER BY seq',
  );
  return result.rows.map(r => ({ seq: r.seq, name: r.name, appliedAt: r.applied_at }));
}
