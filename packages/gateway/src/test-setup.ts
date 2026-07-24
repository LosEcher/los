import { after } from 'node:test';
import { loadConfig } from '@los/infra/config';
import {
  _configureTestSchema,
  _dropConfiguredTestSchema,
  getDb,
  initDb,
} from '@los/infra/db';
import { ensureAllAgentStores } from '@los/agent/ensure-all-stores';

_configureTestSchema('gateway');
const config = await loadConfig();
await initDb(config.databaseUrl);
const schemaPrepared = process.env.LOS_TEST_SCHEMA_PREPARED === '1';
if (schemaPrepared) await resetPreparedTestSchema();
after(async () => {
  if (schemaPrepared) return;
  await _dropConfiguredTestSchema(config.databaseUrl);
});
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
