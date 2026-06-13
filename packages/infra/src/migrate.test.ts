import test from 'node:test';
import assert from 'node:assert/strict';
import { migrateDir, loadAppliedMigrations } from './migrate.js';
import { initDb, closeDb, getDb } from './db.js';
import { rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function dbUrl(): string {
  return process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? 'postgres://localhost:5432/los';
}

test('migrateDir applies pending migrations in order', async () => {
  const db = await initDb(dbUrl());
  const dir = join(tmpdir(), `los-migration-test-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true });

  try {
    writeFileSync(join(dir, '001_one.sql'), 'CREATE TABLE IF NOT EXISTS migration_test_1 (id SERIAL PRIMARY KEY, label TEXT);');
    writeFileSync(join(dir, '002_two.sql'), "INSERT INTO migration_test_1 (label) VALUES ('hello');");

    const result = await migrateDir(dir, db);
    assert.equal(result.applied.length, 2, `expected 2 applied, got ${result.applied.length}: ${result.errors.join(', ')}`);
    assert.equal(result.skipped.length, 0);
    assert.equal(result.errors.length, 0);

    const applied = await loadAppliedMigrations(db);
    assert.equal(applied.length, 2);

    const rows = await db.query<{ label: string }>('SELECT label FROM migration_test_1');
    assert.equal(rows.rows[0]?.label, 'hello');

    // Run again — should skip both
    const result2 = await migrateDir(dir, db);
    assert.equal(result2.applied.length, 0);
    assert.equal(result2.skipped.length, 2);
  } finally {
    await db.exec('DROP TABLE IF EXISTS migration_test_1 CASCADE');
    await db.exec("DELETE FROM schema_migrations WHERE name LIKE '%.sql'");
    rmSync(dir, { recursive: true, force: true });
    await closeDb();
  }
});

test('migrateDir handles empty dir gracefully', async () => {
  const db = await initDb(dbUrl());
  const dir = join(tmpdir(), `los-migration-empty-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true });

  try {
    const result = await migrateDir(dir, db);
    assert.equal(result.applied.length, 0);
    assert.equal(result.skipped.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await closeDb();
  }
});
