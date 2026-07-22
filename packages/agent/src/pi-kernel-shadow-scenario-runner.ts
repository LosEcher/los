import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { loadConfig } from '@los/infra/config';
import { closeDb, initDb } from '@los/infra/db';
import { _getPiExecutionKernelIdentity } from './pi-execution-kernel.js';
import { _collectPiKernelShadowDeterministicEvidence } from './pi-kernel-shadow-fixtures.js';
import { _collectPiKernelShadowLiveEvidence } from './pi-kernel-shadow-live.js';
import {
  _readPiKernelShadowScenarioReport,
  type PiKernelShadowScenarioReport,
} from './pi-kernel-shadow-scenarios.js';
import type { KernelIdentity } from './execution-kernel.js';

interface LiveCollectionDependencies {
  collect?: typeof _collectPiKernelShadowLiveEvidence;
  readReport?: typeof _readPiKernelShadowScenarioReport;
}

export async function _collectOutstandingPiKernelShadowLiveEvidence(
  input: {
    report: PiKernelShadowScenarioReport;
    identity: KernelIdentity & { kind: 'pi' };
    provider: string;
    model: string;
    workspaceRoot: string;
  },
  dependencies: LiveCollectionDependencies = {},
) {
  let report = input.report;
  if (hasLiveFailure(report)) {
    throw new Error('Pi shadow live collection refused: current corpus already has failing live-provider evidence');
  }
  const counts = Object.fromEntries(report.requirements
    .filter(item => item.evidenceClass === 'live-provider')
    .map(item => [item.scenarioId, Math.max(0, item.required - item.observed)]));
  const readReport = dependencies.readReport ?? _readPiKernelShadowScenarioReport;
  let observedCount = report.observedCount;
  const observations = await (dependencies.collect ?? _collectPiKernelShadowLiveEvidence)({
    provider: input.provider,
    model: input.model,
    counts,
    workspaceRoot: input.workspaceRoot,
  }, {
    afterObservation: async observation => {
      report = await readReport(input.identity);
      const persisted = report.observedCount > observedCount;
      observedCount = report.observedCount;
      return observation.status !== 'completed' || !persisted || hasLiveFailure(report) ? 'stop' : 'continue';
    },
  });
  report = await readReport(input.identity);
  return { observations, report };
}

async function main(): Promise<void> {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  try {
    const identity = _getPiExecutionKernelIdentity();
    if (identity.kind !== 'pi') throw new Error(`Unexpected Pi kernel identity: ${identity.kind}`);
    let report = await _readPiKernelShadowScenarioReport({ ...identity, kind: 'pi' });
    if (process.argv.includes('--collect-deterministic')) {
      const counts = Object.fromEntries(report.requirements
        .filter(item => item.evidenceClass === 'deterministic')
        .map(item => [item.scenarioId, Math.max(0, item.required - item.observed)]));
      const observations = await _collectPiKernelShadowDeterministicEvidence(counts);
      report = await _readPiKernelShadowScenarioReport({ ...identity, kind: 'pi' });
      process.stdout.write(`${JSON.stringify({ observations, report }, null, 2)}\n`);
    } else if (process.argv.includes('--collect-live')) {
      const collected = await _collectOutstandingPiKernelShadowLiveEvidence({
        report,
        identity: { ...identity, kind: 'pi' },
        provider: config.agent.defaultProvider,
        model: config.agent.defaultModel,
        workspaceRoot: resolve(import.meta.dirname, '..'),
      });
      report = collected.report;
      process.stdout.write(`${JSON.stringify(collected, null, 2)}\n`);
    } else {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    }
    if (process.argv.includes('--require-ready') && report.status !== 'ready_for_k4_policy_review') {
      process.exitCode = 2;
    }
  } finally {
    await closeDb().catch(() => undefined);
  }
}

function hasLiveFailure(report: PiKernelShadowScenarioReport): boolean {
  return report.requirements.some(item => item.evidenceClass === 'live-provider' && item.failing > 0);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
