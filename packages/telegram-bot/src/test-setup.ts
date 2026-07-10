import { loadConfig } from '@los/infra/config';
import { initDb } from '@los/infra/db';
import { ensureTelegramActionStore } from './telegram-action-store.js';

const config = await loadConfig();
await initDb(config.databaseUrl);
await ensureTelegramActionStore();
