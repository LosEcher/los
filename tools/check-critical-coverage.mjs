#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const agentRoot = fileURLToPath(new URL('../packages/agent/', import.meta.url));

const criticalModules = [
  {
    source: 'src/execution-transitions.ts',
    test: 'src/execution-transitions.test.ts',
    lines: 100,
    branches: 90,
    functions: 100,
  },
  {
    source: 'src/verification-records.ts',
    test: 'src/verification-records.test.ts',
    lines: 88,
    branches: 75,
    functions: 88,
  },
  {
    source: 'src/stream-lease.ts',
    test: 'src/stream-lease.test.ts',
    lines: 95,
    branches: 70,
    functions: 100,
  },
  {
    source: 'src/identity-loader.ts',
    test: 'src/identity-loader.test.ts',
    lines: 90,
    branches: 65,
    functions: 85,
  },
];

for (const coverage of criticalModules) {
  process.stdout.write(`\ncritical coverage: ${coverage.source}\n`);
  const result = spawnSync(process.execPath, [
    '--import', 'tsx',
    '--import', './src/test-setup.ts',
    '--test',
    '--test-concurrency', '1',
    '--experimental-test-coverage',
    `--test-coverage-include=${coverage.source}`,
    `--test-coverage-lines=${coverage.lines}`,
    `--test-coverage-branches=${coverage.branches}`,
    `--test-coverage-functions=${coverage.functions}`,
    coverage.test,
  ], {
    cwd: agentRoot,
    env: process.env,
    stdio: 'inherit',
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.stderr.write(`critical coverage failed from ${repoRoot}: ${coverage.source}\n`);
    process.exit(result.status ?? 1);
  }
}
