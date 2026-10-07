#!/usr/bin/env node
/**
 * Guard: the turbo task path must still deliver the DB/test environment.
 *
 * Incident this exists for (2026-08-18 -> 2026-10-07, fixed 2026-10-07):
 * `pnpm test` is `tools/run-tests.sh` -> `turbo test` on GitHub, while Forgejo
 * gate-test calls `pnpm --filter @los/* test` directly (no turbo). Turborepo
 * 2.x defaults to strict env mode, where turbo DELETES every variable from the
 * task process that is not declared in `globalEnv`/`globalPassThroughEnv`.
 * Commit 3130de14 trimmed `globalEnv` down to `[NODE_ENV]` for cache-key
 * stability, which silently stripped `DATABASE_URL`/`TEST_DATABASE_URL` from
 * every test process. The fail-closed guard in packages/infra/src/db.ts then
 * turned that into the visible failure:
 *
 *   Refusing to run tests against non-test database "los"
 *   (TEST_DATABASE_URL is unset)   -> 123 "new" failures across the workspace
 *
 * Because GitHub PRs are all `mirror/*` heads, the heavy gate-test steps were
 * skipped there, so the only lane that exercised the turbo path was the push to
 * `main` — which went red on every push for ~7 weeks while every PR stayed
 * green, and Forgejo (pnpm, no turbo) stayed green too.
 *
 * The correction is `globalPassThroughEnv`, not `globalEnv`: pass-through
 * delivers the value but is excluded from the task hash, so build/check cache
 * keys do not gain the per-run volatility that 3130de14 removed. This checker
 * asserts both halves against the real `turbo.json` by running turbo for real
 * in a throwaway workspace, so a future turbo.json edit cannot quietly
 * reintroduce either the stripping or the cache-key volatility.
 *
 * Exit 0 when the contract holds; exit 1 with the repair instructions when not.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const TURBO = join(ROOT, 'node_modules', '.bin', 'turbo');

/** Variables the DB-backed test lane must receive through turbo. */
const REQUIRED = [
  'DATABASE_URL',
  'TEST_DATABASE_URL',
  'LOS_ALLOW_LIVE_TEST_DB',
  'LOS_TEST_RUN_ID',
  'LOS_FORCE_AUTH_IN_TEST',
];

/** Deliberately undeclared probe: proves this checker can observe stripping. */
const UNDECLARED = 'LOS_TURBO_ENV_PROBE_UNDECLARED';

const failures = [];

function fail(message) {
  failures.push(message);
}

function readTurboConfig() {
  try {
    return JSON.parse(readFileSync(join(ROOT, 'turbo.json'), 'utf8'));
  } catch (error) {
    fail(`turbo.json is unreadable or invalid JSON: ${error.message}`);
    return null;
  }
}

/**
 * Build a throwaway turbo workspace that keeps the repository's real global
 * env settings verbatim and only adds a `probe` task. Testing a copy would let
 * the real config drift away from the guard.
 */
function buildProbeWorkspace(config) {
  const root = mkdtempSync(join(tmpdir(), 'los-turbo-env-'));
  const pkg = join(root, 'packages', 'probe');
  mkdirSync(pkg, { recursive: true });

  writeFileSync(
    join(root, 'turbo.json'),
    JSON.stringify({ ...config, tasks: { ...config.tasks, probe: { cache: false } } }, null, 2),
  );
  // turbo resolves the workspace through the package manager, so the probe
  // workspace must declare the same one the repository pins.
  const { packageManager } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'turbo-env-probe', private: true, packageManager }, null, 2),
  );
  writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n');
  writeFileSync(
    join(pkg, 'package.json'),
    JSON.stringify(
      { name: 'probe', version: '0.0.0', scripts: { probe: 'node probe.mjs' } },
      null,
      2,
    ),
  );
  const watched = [...REQUIRED, UNDECLARED];
  writeFileSync(
    join(pkg, 'probe.mjs'),
    [
      `const keys = ${JSON.stringify(watched)};`,
      'for (const key of keys) {',
      '  const value = process.env[key];',
      "  console.log(`LOSPROBE ${key}=${value === undefined ? '<absent>' : value}`);",
      '}',
      '',
    ].join('\n'),
  );
  return root;
}

function runTurbo(root, args, env) {
  return spawnSync(TURBO, args, {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...env,
      PATH: process.env.PATH ?? '',
      TURBO_TELEMETRY_DISABLED: '1',
      DO_NOT_TRACK: '1',
      TURBO_NO_UPDATE_NOTIFIER: '1',
      TURBO_CACHE_DIR: join(root, '.turbo-cache'),
    },
  });
}

/** Values deliberately differ per run so task-hash stability is observable. */
function probeEnv(databaseUrl) {
  return {
    NODE_ENV: 'test',
    DATABASE_URL: databaseUrl,
    TEST_DATABASE_URL: databaseUrl,
    LOS_ALLOW_LIVE_TEST_DB: '0',
    LOS_TEST_RUN_ID: 'turbo-env-probe-run',
    LOS_FORCE_AUTH_IN_TEST: '1',
    [UNDECLARED]: 'should-not-survive',
  };
}

function parseProbeOutput(stdout) {
  const observed = new Map();
  for (const line of stdout.split('\n')) {
    const match = /LOSPROBE (\S+)=(.*)$/.exec(line.trim());
    if (match) observed.set(match[1], match[2]);
  }
  return observed;
}

function taskHash(root, env) {
  const result = runTurbo(root, ['run', 'probe', '--dry=json'], env);
  const body = result.stdout.slice(result.stdout.indexOf('{'));
  try {
    const dry = JSON.parse(body);
    return dry.tasks?.[0]?.hash ?? null;
  } catch {
    return null;
  }
}

function main() {
  const config = readTurboConfig();
  if (!config) return report();

  // --- Static half: the declaration must exist and must be pass-through. ---
  const globalEnv = config.globalEnv ?? [];
  const passThrough = config.globalPassThroughEnv ?? [];
  for (const name of REQUIRED) {
    if (globalEnv.includes(name)) {
      fail(
        `${name} is in globalEnv. That enters the task hash and makes build/check ` +
          'cache keys volatile (the reason 3130de14 trimmed globalEnv). Move it to globalPassThroughEnv.',
      );
    }
    if (!passThrough.includes(name)) {
      fail(
        `${name} is not declared in globalPassThroughEnv, so turbo strict env mode ` +
          'deletes it from the test process (123-failure incident, 2026-10-07).',
      );
    }
  }

  // --- Functional half: run turbo and observe the real task environment. ---
  const workspace = buildProbeWorkspace(config);
  try {
    const urlA = 'postgres://probe:probe@localhost:5432/los_probe_test';
    const envA = probeEnv(urlA);
    const runA = runTurbo(workspace, ['run', 'probe', '--output-logs=full'], envA);
    const observedA = parseProbeOutput(runA.stdout);

    if (observedA.size === 0) {
      fail(
        `probe task produced no observable output (turbo exit ${runA.status}). ` +
          `stderr: ${(runA.stderr ?? '').trim().split('\n').slice(0, 3).join(' | ')}`,
      );
      return report();
    }

    for (const name of REQUIRED) {
      const seen = observedA.get(name);
      if (seen !== envA[name]) {
        fail(
          `turbo did not deliver ${name} to the task process ` +
            `(expected "${envA[name]}", saw "${seen ?? '<absent>'}").`,
        );
      }
    }

    if (observedA.get(UNDECLARED) !== '<absent>') {
      console.log(
        `turbo-env-passthrough: note — turbo now passes undeclared variables through ` +
          `(${UNDECLARED} survived); the globalPassThroughEnv declaration is no longer ` +
          'load-bearing, but keeping it is still correct.',
      );
    }

    const urlB = 'postgres://probe:probe@localhost:5432/los_probe_other_test';
    const hashA = taskHash(workspace, envA);
    const hashB = taskHash(workspace, probeEnv(urlB));
    if (!hashA || !hashB) {
      fail('turbo --dry=json did not report a task hash; cache-key stability is unverifiable.');
    } else if (hashA !== hashB) {
      fail(
        'task hash changed when only the database URL changed ' +
          `(${hashA} vs ${hashB}); a DB/test variable is feeding the cache key.`,
      );
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }

  return report();
}

function report() {
  if (failures.length === 0) {
    console.log(
      `turbo-env-passthrough: ok — ${REQUIRED.length} variable(s) delivered to the ` +
        'turbo task process; task hash unaffected by their values',
    );
    process.exit(0);
  }

  console.error(`turbo-env-passthrough: ${failures.length} problem(s)`);
  for (const message of failures) console.error(`  - ${message}`);
  console.error(`
Why this is fatal: GitHub's gate-test runs \`pnpm test\` -> tools/run-tests.sh ->
\`turbo test\`, and turbo 2.x strict env mode deletes undeclared variables from
the task process. packages/infra/src/db.ts then fails closed with
"Refusing to run tests against non-test database ... (TEST_DATABASE_URL is
unset)", which surfaces as ~100+ "new" failures in the known-failure gate.

Repair:
  - Keep the DB/test family in turbo.json "globalPassThroughEnv" (NOT "globalEnv"):
    ${REQUIRED.join(', ')}
  - globalEnv values enter the task hash; per-run values there bust build/check
    caches, which is what 3130de14 removed. passThroughEnv delivers without hashing.
  - See docs/governance/github-branch-gates.md ("Turbo test-env passthrough").
`);
  process.exit(1);
}

main();
