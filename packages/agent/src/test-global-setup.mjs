import { register } from 'tsx/esm/api';

register();

const { loadConfig } = await import('@los/infra/config');
const {
  _configureTestSchema,
  _dropConfiguredTestSchema,
  closeDb,
  initDb,
} = await import('@los/infra/db');
const { ensureAllAgentStores } = await import('./ensure-all-stores.ts');

let databaseUrl;

export async function globalSetup() {
  _configureTestSchema('agent');
  const config = await loadConfig();
  databaseUrl = config.databaseUrl;
  await initDb(databaseUrl);
  await ensureAllAgentStores();
  await closeDb();
  process.env.LOS_TEST_SCHEMA_PREPARED = '1';
}

export async function globalTeardown() {
  await _dropConfiguredTestSchema(databaseUrl);
}
