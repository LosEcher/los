import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ciGate = fileURLToPath(new URL('./ci-gate.sh', import.meta.url));
const passingChecks = [
  'check-security.sh',
  'check-structure.sh',
  'check-ci-workflow-policy.sh',
  'check-test-isolation.sh',
  'check-coupling.sh',
  'check-state-machine-bypass.sh',
  'check-contracts.sh',
  'check-delete-safety.sh',
  'check-unwired-exports.sh',
  'check-static-analysis.sh',
];

test('gate passes when the test command succeeds and removes its temp log', () => {
  const fixture = runGate('success');
  try {
    assert.equal(fixture.result.status, 0, fixture.result.stdout + fixture.result.stderr);
    assert.match(fixture.result.stdout, /fixture-success-tail/);
    assert.match(fixture.result.stdout, /GATE PASSED/);
    assertTempLogRemoved(fixture.tempDirectory);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('gate continues when all test failures are classified as known', () => {
  const fixture = runGate('known');
  try {
    assert.equal(fixture.result.status, 0, fixture.result.stdout + fixture.result.stderr);
    assert.match(fixture.result.stdout, /fixture-known-tail/);
    assert.match(fixture.result.stdout, /All test failures are KNOWN/);
    assert.match(fixture.result.stdout, /GATE PASSED/);
    assertTempLogRemoved(fixture.tempDirectory);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('gate blocks new test failures after printing the captured log tail', () => {
  const fixture = runGate('new');
  try {
    assert.equal(fixture.result.status, 1, fixture.result.stdout + fixture.result.stderr);
    assert.match(fixture.result.stdout, /fixture-new-tail/);
    assert.match(fixture.result.stdout, /NEW test failures or unparsed failure output/);
    assert.match(fixture.result.stdout, /tests \(new failures beyond known-failure baseline\)/);
    assert.match(fixture.result.stdout, /GATE FAILED/);
    assertTempLogRemoved(fixture.tempDirectory);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('gate folds turbo cache stats from the typecheck summary into its output', () => {
  const fixture = runGate('success');
  try {
    assert.equal(fixture.result.status, 0, fixture.result.stdout + fixture.result.stderr);
    // Phase 1 parses the turbo run summary (fixture emits a turbo 2.9-style
    // "Cached: N cached, M total" line + per-task hit/miss lines) and prints
    // the folded stats; the same TURBO record lands in the gate summary JSON
    // ("turbo" block) consumed by CI's emit-gate-summary steps.
    assert.match(fixture.result.stdout, /turbo cache: 7\/16 tasks cached/);
    assert.match(fixture.result.stdout, /hit lines=7, miss lines=9/);
    assert.match(fixture.result.stdout, /GATE PASSED/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

function runGate(testCase) {
  const root = mkdtempSync(join(tmpdir(), 'los-ci-gate-'));
  const toolsDirectory = join(root, 'tools');
  const binDirectory = join(root, 'bin');
  const tempDirectory = join(root, 'tmp');
  mkdirSync(toolsDirectory);
  mkdirSync(binDirectory);
  mkdirSync(tempDirectory);
  symlinkSync(ciGate, join(toolsDirectory, 'ci-gate.sh'));

  for (const name of passingChecks) {
    writeExecutable(join(toolsDirectory, name), '#!/usr/bin/env bash\nexit 0\n');
  }
  writeExecutable(join(toolsDirectory, 'check-known-failures.sh'), `#!/usr/bin/env bash
cat >/dev/null
# success: tests passed — allow clean baseline check
# known: failures present but all known — allow continue
# new: real regression — block
case "\${GATE_TEST_CASE:-}" in
  known|success) exit 0 ;;
  *) exit 1 ;;
esac
`);
  writeExecutable(join(binDirectory, 'pnpm'), `#!/usr/bin/env bash
if [ "\${1:-}" = "run" ] && [ "\${2:-}" = "_typecheck" ]; then
  # turbo 2.9-style summary + per-task hit/miss lines (parsed by phase 1).
  # 7 hits + 9 misses = 16 tasks, matching the "Cached: 7 cached, 16 total".
  printf 'Tasks:    16 successful, 16 total\n'
  printf 'Cached:    7 cached, 16 total\n'
  for index in $(seq 0 6); do
    printf '@los/pkg:check: cache hit, replaying logs 000000000000000%s\n' "$index"
  done
  for index in $(seq 7 15); do
    printf '@los/pkg:check: cache miss, executing 000000000000000%s\n' "$index"
  done
  exit 0
fi
if [ "\${1:-}" = "run" ] && [ "\${2:-}" = "_test" ]; then
  for index in $(seq 1 35); do
    printf 'fixture-output-%s\n' "$index"
  done
  printf 'fixture-%s-tail\n' "\${GATE_TEST_CASE:-unknown}"
  if [ "\${GATE_TEST_CASE:-}" = "success" ]; then
    exit 0
  fi
  exit 2
fi
exit 0
`);

  const result = spawnSync('bash', [join(toolsDirectory, 'ci-gate.sh')], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GATE_TEST_CASE: testCase,
      PATH: `${binDirectory}:${process.env.PATH ?? ''}`,
      TMPDIR: tempDirectory,
    },
  });
  return { root, tempDirectory, result };
}

function writeExecutable(path, content) {
  writeFileSync(path, content, { mode: 0o755 });
}

function assertTempLogRemoved(tempDirectory) {
  const leftovers = readdirSync(tempDirectory)
    .filter((name) => name.startsWith('los-test-output.'));
  assert.deepEqual(leftovers, []);
}
