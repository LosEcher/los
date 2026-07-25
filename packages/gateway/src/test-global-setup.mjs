import { register } from 'tsx/esm/api';

register();

const { ensureAllAgentStores } = await import('@los/agent/ensure-all-stores');
const { loadConfig } = await import('@los/infra/config');
const {
  _configureTestSchema,
  _dropConfiguredTestSchema,
  closeDb,
  initDb,
} = await import('@los/infra/db');

let databaseUrl;

export async function globalSetup() {
  _configureTestSchema('gateway');
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
