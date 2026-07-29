import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

export function runPackageTests(options) {
  const discoveredTestFiles = walk('src').filter(path => path.endsWith('.test.ts')).sort();
  // Classification inventory may be a superset of the files this process runs
  // (e.g. CI agent lanes run one LOS_TEST_GROUP but must still classify all).
  const classifiedTestFiles = [
    ...options.sharedProcessTestFiles,
    ...(options.dbBackedTestFiles ?? []),
    ...(options.classifiedIsolatedDatabaseTestFiles ?? options.isolatedDatabaseTestFiles),
  ].sort();

  if (!options.skipClassificationCheck) {
    const missingClassifications = discoveredTestFiles.filter(path => !classifiedTestFiles.includes(path));
    const staleClassifications = classifiedTestFiles.filter(path => !discoveredTestFiles.includes(path));
    const duplicateClassifications = classifiedTestFiles.filter(
      (path, index) => classifiedTestFiles.indexOf(path) !== index,
    );

    if (missingClassifications.length || staleClassifications.length || duplicateClassifications.length) {
      process.stderr.write([
        ...missingClassifications.map(path => `unclassified test: ${path}`),
        ...staleClassifications.map(path => `missing test file: ${path}`),
        ...duplicateClassifications.map(path => `duplicate test classification: ${path}`),
      ].join('\n') + '\n');
      process.exit(1);
    }
  }

  const testRunId = process.env.LOS_TEST_RUN_ID
    ?? `${options.packageId}-${process.pid}-${Date.now()}`;
  const testEnv = {
    ...process.env,
    NODE_ENV: process.env.NODE_ENV ?? 'test',
    LOS_TEST_RUN_ID: testRunId,
  };

  if (process.argv.includes('--coverage')) {
    runLane('coverage', [
      '--import', 'tsx',
      '--import', options.testSetupFile,
      '--test',
      `--test-global-setup=${options.globalSetupFile}`,
      '--test-concurrency', '1',
      '--experimental-test-coverage',
      `--test-coverage-include=${options.coverageInclude ?? 'src/**/*.ts'}`,
      ...discoveredTestFiles,
    ], testEnv);
    return;
  }

  runLane('shared-process', [
    '--import', 'tsx',
    '--test',
    '--test-isolation=none',
    '--test-concurrency', '1',
    ...options.sharedProcessTestFiles,
  ], testEnv);

  const dbBackedFiles = options.dbBackedTestFiles ?? [];
  if (dbBackedFiles.length > 0) {
    runLane('db-backed', [
      '--import', 'tsx',
      '--import', options.testSetupFile,
      '--test',
      `--test-global-setup=${options.globalSetupFile}`,
      '--test-concurrency', '1',
      ...dbBackedFiles,
    ], testEnv);
  }

  runLane('isolated', [
    '--import', 'tsx',
    '--import', options.testSetupFile,
    '--test',
    `--test-global-setup=${options.globalSetupFile}`,
    '--test-concurrency', '1',
    ...options.isolatedDatabaseTestFiles,
  ], testEnv);
}

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name).replaceAll('\\', '/');
    return entry.isDirectory() ? walk(path) : [path];
  });
}

function runLane(name, args, env) {
  process.stdout.write(`test lane: ${name}\n`);
  const result = spawnSync(process.execPath, args, { env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
