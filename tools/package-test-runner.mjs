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

  // Include LOS_TEST_GROUP when present so three CI agent groups never share a
  // base id even if forked in the same millisecond with the same pid namespace.
  const testRunId = process.env.LOS_TEST_RUN_ID
    ?? `${options.packageId}-g${process.env.LOS_TEST_GROUP ?? 'all'}-${process.pid}-${Date.now()}`;
  const testEnv = {
    ...process.env,
    NODE_ENV: process.env.NODE_ENV ?? 'test',
    LOS_TEST_RUN_ID: testRunId,
  };

  if (process.argv.includes('--coverage')) {
    // Optional LOS_TEST_SKIP_PATTERN skips tests whose *name* matches the
    // pattern in coverage mode (e.g. the macOS sandbox-exec denial recorded
    // in tools/.known-test-failures.txt; the test name is "all mode executes
    // shell commands through the OS sandbox"). CI never sets it, so coverage
    // collection there stays complete.
    const skipPattern = process.env.LOS_TEST_SKIP_PATTERN;
    runLane('coverage', [
      '--import', 'tsx',
      '--import', options.testSetupFile,
      '--test',
      `--test-global-setup=${options.globalSetupFile}`,
      '--test-concurrency', '1',
      '--experimental-test-coverage',
      `--test-coverage-include=${options.coverageInclude ?? 'src/**/*.ts'}`,
      ...(skipPattern ? [`--test-skip-pattern=${skipPattern}`] : []),
      ...discoveredTestFiles,
    ], testEnv, testRunId);
    return;
  }

  // Default node --test isolation (one process per file) — NOT
  // --test-isolation=none: sharing one process across files lets a file that
  // leaves handles open (app boot, DB pool) cancel later files with
  // "Promise resolution is still pending but the event loop has already
  // resolved" under turbo full-suite runs (observed 2026-08-17 on gateway
  // routes tests; files passed individually). Serial concurrency keeps the
  // order deterministic. The test setup (loadConfig + initDb) is imported per
  // process so shared-process files that relied on the old shared-process
  // config singleton still work under process isolation.
  runLane('shared-process', [
    '--import', 'tsx',
    ...(options.testSetupFile ? ['--import', options.testSetupFile] : []),
    '--test',
    '--test-concurrency', '1',
    ...options.sharedProcessTestFiles,
  ], testEnv, testRunId);

  const dbBackedFiles = options.dbBackedTestFiles ?? [];
  if (dbBackedFiles.length > 0) {
    runLane('db-backed', [
      '--import', 'tsx',
      '--import', options.testSetupFile,
      '--test',
      `--test-global-setup=${options.globalSetupFile}`,
      '--test-concurrency', '1',
      ...dbBackedFiles,
    ], testEnv, testRunId);
  }

  runLane('isolated', [
    '--import', 'tsx',
    '--import', options.testSetupFile,
    '--test',
    `--test-global-setup=${options.globalSetupFile}`,
    '--test-concurrency', '1',
    ...options.isolatedDatabaseTestFiles,
  ], testEnv, testRunId);
}

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name).replaceAll('\\', '/');
    return entry.isDirectory() ? walk(path) : [path];
  });
}

function runLane(name, args, env, testRunId) {
  // Every lane gets a distinct LOS_TEST_RUN_ID so test schemas derived from it
  // (e.g. _configureTestSchema()) stay unique per lane process. Sharing one id
  // across lanes makes the second lane's schema DDL collide with the first
  // (CREATE TYPE ... already exists) on the same PostgreSQL database.
  const laneEnv = testRunId
    ? { ...env, LOS_TEST_RUN_ID: `${testRunId}-${name}` }
    : env;
  process.stdout.write(`test lane: ${name}\n`);
  const result = spawnSync(process.execPath, args, { env: laneEnv, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
