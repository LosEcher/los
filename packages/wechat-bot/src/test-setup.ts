import { after } from 'node:test';
import { loadConfig } from '@los/infra/config';
import { _configureTestSchema, _dropConfiguredTestSchema, initDb } from '@los/infra/db';
import { ensureWxPusherCallbackClaimStore } from './wxpusher-callback-store.js';

_configureTestSchema('wechat_bot');
const config = await loadConfig();
await initDb(config.databaseUrl);
after(async () => await _dropConfiguredTestSchema(config.databaseUrl));
await ensureWxPusherCallbackClaimStore();
