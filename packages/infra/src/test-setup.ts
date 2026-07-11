/**
 * @los/infra test-setup — load .env values into process.env before tests run.
 *
 * Without this, turbo/pnpm test runs don't inject .env into the test process,
 * so migrate.test.ts's dbUrl() falls back to localhost:5432 → ECONNREFUSED.
 *
 * loadConfig() reads .env and mirrors values into process.env (config.ts:249-253),
 * which is exactly what _resolveDatabaseUrlForInit and migrate.test.ts's dbUrl()
 * need to find TEST_DATABASE_URL.
 */
import { after } from 'node:test';
import { loadConfig } from './config.js';
import { _configureTestSchema, _dropConfiguredTestSchema } from './db.js';

_configureTestSchema('infra');
const config = await loadConfig();
after(async () => await _dropConfiguredTestSchema(config.databaseUrl));
