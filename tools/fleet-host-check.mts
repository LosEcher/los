#!/usr/bin/env tsx
/**
 * Manual fleet host check (P2).
 *
 * Usage (repo root):
 *   ./packages/gateway/node_modules/.bin/tsx tools/fleet-host-check.mts
 *   ./packages/gateway/node_modules/.bin/tsx tools/fleet-host-check.mts --force
 *   ./packages/gateway/node_modules/.bin/tsx tools/fleet-host-check.mts --dry-run
 */
import { loadConfig } from '../packages/infra/src/config.ts';
import { closeDb, initDb } from '../packages/infra/src/db.ts';
import { runFleetHostChecks } from '../packages/agent/src/fleet-host-checks.ts';

const args = new Set(process.argv.slice(2));
const force = args.has('--force') || args.has('-f');
const dryRun = args.has('--dry-run') || args.has('--dry');

const config = await loadConfig();
await initDb(config.databaseUrl);
try {
  const report = await runFleetHostChecks({ force, dryRun, quiet: dryRun });
  console.log(JSON.stringify(report, null, 2));
  if (report.failed.length > 0) process.exitCode = 2;
  else if (report.degraded.length > 0) process.exitCode = 1;
} finally {
  await closeDb().catch(() => undefined);
}
