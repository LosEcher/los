import { loadConfig } from '@los/infra/config';
import { initDb, getDb } from '@los/infra/db';
import { ensureAllAgentStores } from '@los/agent/ensure-all-stores';

const config = await loadConfig();
await initDb(config.databaseUrl);
await ensureAllAgentStores();

// Drop stale procedural_candidates table from previous partial test runs
await getDb().exec('DROP TABLE IF EXISTS procedural_candidates CASCADE').catch(() => undefined);
