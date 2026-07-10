import { loadConfig } from '@los/infra/config';
import { getDb, initDb } from '@los/infra/db';
import { ensureWxPusherCallbackClaimStore } from './wxpusher-callback-store.js';

const config = await loadConfig();
await initDb(config.databaseUrl);
await ensureWxPusherCallbackClaimStore();
await getDb().exec('TRUNCATE TABLE wxpusher_callback_claims');
