import { loadConfig } from '@los/infra/config';
import { initDb, getDb, resolveDatabaseUrlForInit, isSafeTestDatabaseUrl } from '@los/infra/db';

// Pre-initialize DB and all agent stores before tests run concurrently.
// ensureAllAgentStores() is the single source of truth — one function
// covers every agent-owned store in dependency-safe order. When a new
// ensure*Store is added, update ensureAllAgentStores(); this file
// stays unchanged.

const config = await loadConfig();
await initDb(config.databaseUrl);

// Reset governance_jobs for a clean test run — but ONLY on a safe test DB.
const effectiveDbUrl = resolveDatabaseUrlForInit(config.databaseUrl);
if (effectiveDbUrl && isSafeTestDatabaseUrl(effectiveDbUrl)) {
  await getDb().exec('DROP TABLE IF EXISTS governance_jobs CASCADE').catch(() => undefined);
}

import { ensureAllAgentStores } from './ensure-all-stores.js';
await ensureAllAgentStores();
