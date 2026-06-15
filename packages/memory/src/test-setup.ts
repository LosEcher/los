import { loadConfig } from '@los/infra/config';
import { initDb, getDb } from '@los/infra/db';
import { ensureTaskRunStore } from '@los/agent/task-runs';
import { ensureRunEvalStore } from '@los/agent/run-evals';

const config = await loadConfig();
await initDb(config.databaseUrl);
await ensureTaskRunStore();
await ensureRunEvalStore();

// Drop stale procedural_candidates table from previous partial test runs
await getDb().exec('DROP TABLE IF EXISTS procedural_candidates CASCADE').catch(() => undefined);
