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

  const url = databaseUrl ?? process.env.DATABASE_URL ?? 'postgres://los:los@127.0.0.1:5432/los';
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

export async function withDbClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  getDb();
  const client = await _pool!.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}
