import { pathToFileURL } from 'node:url';
import { loadConfig } from '@los/infra/config';
import { closeDb, initDb } from '@los/infra/db';
import { _getPiExecutionKernelIdentity } from './pi-execution-kernel.js';
import { _readPiKernelShadowScenarioReport } from './pi-kernel-shadow-scenarios.js';

async function main(): Promise<void> {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  try {
    const identity = _getPiExecutionKernelIdentity();
    if (identity.kind !== 'pi') throw new Error(`Unexpected Pi kernel identity: ${identity.kind}`);
    const report = await _readPiKernelShadowScenarioReport({ ...identity, kind: 'pi' });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (process.argv.includes('--require-ready') && report.status !== 'ready_for_k4_policy_review') {
      process.exitCode = 2;
    }
  } finally {
    await closeDb().catch(() => undefined);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
