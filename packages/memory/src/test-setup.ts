import { loadConfig } from '@los/infra/config';
import { initDb } from '@los/infra/db';
import { ensureTaskRunStore } from '@los/agent/task-runs';
import { ensureRunEvalStore } from '@los/agent/run-evals';

const config = await loadConfig();
await initDb(config.databaseUrl);
await ensureTaskRunStore();
await ensureRunEvalStore();
