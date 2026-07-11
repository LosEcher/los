import { after } from 'node:test';
import { loadConfig } from '@los/infra/config';
import { _configureTestSchema, _dropConfiguredTestSchema, initDb } from '@los/infra/db';
import { ensureAllAgentStores } from '@los/agent/ensure-all-stores';

_configureTestSchema('gateway');
const config = await loadConfig();
await initDb(config.databaseUrl);
after(async () => await _dropConfiguredTestSchema(config.databaseUrl));
await ensureAllAgentStores();
