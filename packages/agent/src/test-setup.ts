import { after } from 'node:test';
import { loadConfig } from '@los/infra/config';
import {
  _configureTestSchema,
  _dropConfiguredTestSchema,
  closeDb,
  getDb,
  initDb,
} from '@los/infra/db';

// Pre-initialize DB and all agent stores before tests run concurrently.
// ensureAllAgentStores() is the single source of truth — one function
// covers every agent-owned store in dependency-safe order. When a new
// ensure*Store is added, update ensureAllAgentStores(); this file
// stays unchanged.

_configureTestSchema('agent');
const config = await loadConfig();
await initDb(config.databaseUrl);
const schemaPrepared = process.env.LOS_TEST_SCHEMA_PREPARED === '1';
if (schemaPrepared) await resetPreparedTestSchema();
after(async () => {
  if (schemaPrepared) {
    await closeDb();
    return;
  }
  await _dropConfiguredTestSchema(config.databaseUrl);
});

import { ensureAllAgentStores } from './ensure-all-stores.js';
if (!schemaPrepared) await ensureAllAgentStores();

async function resetPreparedTestSchema(): Promise<void> {
  const tables = await getDb().query<{ table_name: string }>(`
    SELECT format('%I.%I', schemaname, tablename) AS table_name
    FROM pg_tables
    WHERE schemaname = current_schema()
    ORDER BY tablename
  `);
  if (tables.rows.length === 0) return;
  await getDb().exec(
    `TRUNCATE TABLE ${tables.rows.map(row => row.table_name).join(', ')} RESTART IDENTITY CASCADE`,
  );
}
