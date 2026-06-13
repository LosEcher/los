/**
 * @los/infra/db — PostgreSQL database wrapper.
 *
 * los treats PostgreSQL as the default persistence layer for both single-node
 * and mesh deployments. A single-node deployment is just a mesh deployment
 * with one database and one active node.
 */

import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { getLogger } from './logger.js';

const log = getLogger('db');

export interface DbConnection {
  query<T extends QueryResultRow = QueryResultRow>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  exec(sql: string): Promise<void>;
  notify(channel: string, payload: string): Promise<void>;
  close(): Promise<void>;
  readonly open: boolean;
  readonly dbType: 'postgres';
}

let _pool: Pool | null = null;

export async function initDb(databaseUrl?: string): Promise<DbConnection> {
  if (_pool) return wrap(_pool);

  const url = resolveDatabaseUrlForInit(databaseUrl);
  if (!url) {
    throw new Error(
      'DATABASE_URL is not configured. Set DATABASE_URL=postgres://user:pass@host:5432/db ' +
      'via the .env file, environment variable, or ~/.los/config.yaml.',
    );
  }
  if (!url.startsWith('postgres://') && !url.startsWith('postgresql://')) {
    throw new Error(`los uses PostgreSQL for persistence. Set DATABASE_URL=postgres://... (got ${url})`);
  }

  _pool = new Pool({
    connectionString: url,
    max: 20,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 10000,
    allowExitOnIdle: true,
  });
  await _pool.query('select 1');
  log.info('Database: PostgreSQL connected');
  return wrap(_pool);
}

export function resolveDatabaseUrlForInit(databaseUrl?: string): string | undefined {
  if (isLikelyTestProcess()) {
    const testUrl = normalizeOptionalString(process.env.TEST_DATABASE_URL);
    if (testUrl) return testUrl;

    const candidate = databaseUrl ?? process.env.DATABASE_URL;
    if (
      candidate
      && !isSafeTestDatabaseUrl(candidate)
      && process.env.LOS_ALLOW_LIVE_TEST_DB !== '1'
    ) {
      throw new Error(
        `Refusing to run tests against non-test database "${redactedDatabaseName(candidate)}". ` +
        'Set TEST_DATABASE_URL=postgres://.../los_test or LOS_ALLOW_LIVE_TEST_DB=1 for an explicit one-off override.',
      );
    }
    return candidate;
  }

  return databaseUrl ?? process.env.DATABASE_URL;
}

export function isSafeTestDatabaseUrl(databaseUrl: string): boolean {
  try {
    const parsed = new URL(databaseUrl);
    const dbName = parsed.pathname.replace(/^\/+/, '').toLowerCase();
    if (!dbName) return false;
    return /(^|[-_])test($|[-_])/.test(dbName) || dbName.endsWith('_test') || dbName.endsWith('-test');
  } catch {
    return false;
  }
}

function isLikelyTestProcess(): boolean {
  if (process.env.NODE_ENV === 'test') return true;
  if (process.env.LOS_TEST_MODE === '1') return true;
  if (process.env.NODE_TEST_CONTEXT) return true;
  return process.argv.some((arg) => /\.(test|spec)\.[cm]?[jt]s$/.test(arg));
}

function redactedDatabaseName(databaseUrl: string): string {
  try {
    const parsed = new URL(databaseUrl);
    return parsed.pathname.replace(/^\/+/, '') || '<none>';
  } catch {
    return '<invalid-url>';
  }
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function wrap(pool: Pool): DbConnection {
  return {
    query: async <T extends QueryResultRow = QueryResultRow>(sql: string, params: unknown[] = []) => {
      const result = await pool.query<T>(sql, params);
      return { rows: result.rows };
    },
    exec: async (sql: string) => {
      await pool.query(sql);
    },
    notify: async (channel: string, payload: string) => {
      await pool.query(`SELECT pg_notify($1, $2)`, [channel, payload]);
    },
    close: async () => {
      await pool.end();
      _pool = null;
    },
    get open() { return true; },
    get dbType() { return 'postgres' as const; },
  };
}

export function getPool(): Pool {
  if (!_pool) throw new Error('Database not initialized. Call initDb() first.');
  return _pool;
}

export function getDb(): DbConnection {
  if (!_pool) throw new Error('Database not initialized. Call initDb() first.');
  return wrap(_pool);
}

export function getDbType(): 'postgres' {
  return 'postgres';
}

export async function closeDb(): Promise<void> {
  if (_pool) {
    await _pool.end();
    _pool = null;
  }
}

export async function withInitDb<T>(fn: () => Promise<T>): Promise<T> {
  const { loadConfig } = await import('./config.js');
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  try {
    return await fn();
  } finally {
    await closeDb().catch(() => undefined);
  }
}

export async function withDbClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  getDb();
  const client = await _pool!.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}
