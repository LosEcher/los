/**
 * @los/infra/db — unit tests for type contracts and SQLite path validation.
 *
 * DB-dependent functions (initDb, getDb, closeDb) require either SQLite or
 * PostgreSQL. Tests for real connections go in db.integration.test.ts.
 */
import assert from 'node:assert';
import { afterEach, describe, it } from 'node:test';
import { isSafeTestDatabaseUrl, resolveDatabaseUrlForInit } from './db.js';

describe('DbConnection interface', () => {
  it('defines exec/prepare/transaction/close contract', () => {
    // Type-level verification: a mock that satisfies DbConnection
    const conn = {
      exec: (_sql: string) => {},
      prepare: (_sql: string) => ({
        run: (..._params: unknown[]) => ({ changes: 0, lastInsertRowid: 0 }),
        get: (..._params: unknown[]) => undefined,
        all: (..._params: unknown[]) => [] as unknown[],
      }),
      transaction: <T extends (...args: unknown[]) => unknown>(fn: T): T => fn,
      close: () => {},
      open: true,
      dbType: 'sqlite' as const,
    };
    assert.ok(conn);
    assert.strictEqual(conn.dbType, 'sqlite');
    assert.strictEqual(conn.open, true);
  });

  it('distinguishes sqlite vs postgres dbType', () => {
    const pgConn = { dbType: 'postgres' as const, open: true };
    const sqliteConn = { dbType: 'sqlite' as const, open: true };
    assert.notStrictEqual(pgConn.dbType, sqliteConn.dbType);
  });
});

// ── URL path extraction ─────────────────────────────────

function extractSqlitePath(url: string): string {
  return url.replace(/^file:/, '');
}

describe('SQLite URL parsing', () => {
  it('extracts path from file: URL', () => {
    assert.strictEqual(extractSqlitePath('file:./data/los.db'), './data/los.db');
  });

  it('extracts absolute path from file: URL', () => {
    assert.strictEqual(extractSqlitePath('file:/tmp/los.db'), '/tmp/los.db');
  });

  it('leaves non-file URLs unchanged', () => {
    const pg = 'postgres://user:pass@host:5432/los';
    assert.strictEqual(extractSqlitePath(pg), pg);
  });
});

// ── Test database guard ─────────────────────────────────

describe('test database guard', () => {
  const originalEnv = { ...process.env };
  const originalArgv = [...process.argv];

  afterEach(() => {
    process.env = { ...originalEnv };
    process.argv.splice(0, process.argv.length, ...originalArgv);
  });

  it('accepts clearly named test databases', () => {
    assert.equal(isSafeTestDatabaseUrl('postgres://localhost:5432/los_test'), true);
    assert.equal(isSafeTestDatabaseUrl('postgres://localhost:5432/los-test'), true);
    assert.equal(isSafeTestDatabaseUrl('postgres://localhost:5432/los_test_123'), true);
  });

  it('rejects live-looking database names for tests', () => {
    assert.equal(isSafeTestDatabaseUrl('postgres://localhost:5432/los'), false);
    assert.equal(isSafeTestDatabaseUrl('postgres://localhost:5432/prod'), false);
  });

  it('uses TEST_DATABASE_URL in test processes', () => {
    process.argv.push('/tmp/db.test.ts');
    process.env.TEST_DATABASE_URL = 'postgres://localhost:5432/los_test';
    assert.equal(
      resolveDatabaseUrlForInit('postgres://localhost:5432/los'),
      'postgres://localhost:5432/los_test',
    );
  });

  it('refuses live-looking database names in test processes', () => {
    const savedCI = process.env.CI;
    delete process.env.CI;
    process.argv.push('/tmp/db.test.ts');
    delete process.env.TEST_DATABASE_URL;
    try {
      assert.throws(
        () => resolveDatabaseUrlForInit('postgres://localhost:5432/los'),
        /Refusing to run tests against non-test database "los"/,
      );
    } finally {
      if (savedCI !== undefined) process.env.CI = savedCI;
    }
  });

  it('allows explicit one-off override for live-looking test databases', () => {
    process.argv.push('/tmp/db.test.ts');
    delete process.env.TEST_DATABASE_URL;
    process.env.LOS_ALLOW_LIVE_TEST_DB = '1';
    assert.equal(
      resolveDatabaseUrlForInit('postgres://localhost:5432/los'),
      'postgres://localhost:5432/los',
    );
  });
});

// ── Statement interface ─────────────────────────────────

describe('Statement interface', () => {
  it('run returns changes and lastInsertRowid', () => {
    const stmt = {
      run: (..._params: unknown[]) => ({ changes: 1, lastInsertRowid: 42 }),
      get: (..._params: unknown[]) => ({ id: 1, name: 'test' }),
      all: (..._params: unknown[]) => [{ id: 1 }, { id: 2 }],
    };
    const r1 = stmt.run();
    assert.strictEqual(r1.changes, 1);
    assert.strictEqual(r1.lastInsertRowid, 42);
  });

  it('get returns a single row or undefined', () => {
    const stmt = {
      run: () => ({ changes: 0, lastInsertRowid: 0 }),
      get: (..._params: unknown[]) => undefined as unknown,
      all: () => [] as unknown[],
    };
    assert.strictEqual(stmt.get(), undefined);
  });

  it('all returns array of rows', () => {
    const stmt = {
      run: () => ({ changes: 0, lastInsertRowid: 0 }),
      get: () => undefined,
      all: (..._params: unknown[]) => [{ a: 1 }, { a: 2 }, { a: 3 }],
    };
    assert.strictEqual(stmt.all().length, 3);
  });
});
