import { after } from 'node:test';
import { loadConfig } from '@los/infra/config';
import { _configureTestSchema, _dropConfiguredTestSchema, initDb } from '@los/infra/db';

// Pre-initialize DB and all agent stores before tests run concurrently.
// ensureAllAgentStores() is the single source of truth — one function
// covers every agent-owned store in dependency-safe order. When a new
// ensure*Store is added, update ensureAllAgentStores(); this file
// stays unchanged.

_configureTestSchema('agent');
const config = await loadConfig();
await initDb(config.databaseUrl);
after(async () => await _dropConfiguredTestSchema(config.databaseUrl));

import { ensureAllAgentStores } from './ensure-all-stores.js';
await ensureAllAgentStores();
