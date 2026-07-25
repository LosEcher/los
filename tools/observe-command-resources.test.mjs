import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const observer = fileURLToPath(new URL('./observe-command-resources.mjs', import.meta.url));

test('observer writes one JSON record for a successful command', () => {
  const directory = mkdtempSync(join(tmpdir(), 'los-resource-observer-'));
  const output = join(directory, 'observation.json');
  try {
    const result = runObserver(output, 'setTimeout(() => {}, 80)');
    assert.equal(result.status, 0, result.stderr);
    const observation = JSON.parse(readFileSync(output, 'utf8'));
    assert.equal(observation.schemaVersion, 1);
    assert.equal(observation.label, 'fixture');
    assert.equal(observation.exitCode, 0);
    assert.ok(observation.elapsedSeconds >= 0);
    assert.ok(observation.sampleCount >= 1);
    assert.equal(typeof observation.host, 'object');
    assert.equal(typeof observation.cgroupV2, 'object');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('observer preserves a failing command exit code and still writes evidence', () => {
  const directory = mkdtempSync(join(tmpdir(), 'los-resource-observer-'));
  const output = join(directory, 'observation.json');
  try {
    const result = runObserver(output, 'process.exit(7)');
    assert.equal(result.status, 7, result.stderr);
    const observation = JSON.parse(readFileSync(output, 'utf8'));
    assert.equal(observation.exitCode, 7);
    assert.equal(observation.signal, null);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

function runObserver(output, fixture) {
  return spawnSync(process.execPath, [
    observer,
    '--label', 'fixture',
    '--output', output,
    '--interval-ms', '20',
    '--', process.execPath, '-e', fixture,
  ], { encoding: 'utf8' });
}
