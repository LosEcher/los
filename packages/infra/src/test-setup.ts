/**
 * @los/infra test-setup — load .env values into process.env before tests run.
 *
 * Without this, turbo/pnpm test runs don't inject .env into the test process,
 * so migrate.test.ts's dbUrl() falls back to localhost:5432 → ECONNREFUSED.
 *
 * loadConfig() reads .env and mirrors values into process.env (config.ts:249-253),
 * which is exactly what resolveDatabaseUrlForInit and migrate.test.ts's dbUrl()
 * need to find TEST_DATABASE_URL.
 */
import { loadConfig } from './config.js';

await loadConfig();
