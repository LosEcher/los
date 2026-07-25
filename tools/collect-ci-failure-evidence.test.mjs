import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const collector = fileURLToPath(new URL('./collect-ci-failure-evidence.mjs', import.meta.url));

test('collector retains log tail, files, and unavailable inputs in its manifest', () => {
  const root = mkdtempSync(join(tmpdir(), 'los-ci-evidence-'));
  try {
    const log = join(root, 'test.log');
    const resource = join(root, 'resource.json');
    const output = join(root, 'bundle');
    writeFileSync(log, 'prefix-0123456789');
    writeFileSync(resource, '{"peak":42}\n');

    const result = runCollector([
      '--output', output,
      '--max-bytes', '131072',
      '--tail-bytes', '10',
      '--tail', `test-log=${log}`,
      '--file', `resources=${resource}`,
      '--file', `cancelled-observer=${join(root, 'missing.json')}`,
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(join(output, 'test-log.log'), 'utf8'), '0123456789');
    assert.equal(readFileSync(join(output, 'resources.json'), 'utf8'), '{"peak":42}\n');
    const manifest = JSON.parse(readFileSync(join(output, 'manifest.json'), 'utf8'));
    assert.equal(manifest.inputs[0].status, 'partial');
    assert.equal(manifest.inputs[1].status, 'included');
    assert.equal(manifest.inputs[2].status, 'unavailable');
    assert.ok(manifest.totalBytes <= manifest.maxBundleBytes);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('collector keeps tree evidence bounded and excludes cache dependency trees', () => {
  const root = mkdtempSync(join(tmpdir(), 'los-ci-evidence-'));
  try {
    const tree = join(root, 'test-results');
    const output = join(root, 'bundle');
    mkdirSync(join(tree, 'case-a'), { recursive: true });
    mkdirSync(join(tree, 'node_modules', 'dependency'), { recursive: true });
    writeFileSync(join(tree, 'case-a', 'screenshot.png'), Buffer.alloc(40_000, 1));
    writeFileSync(join(tree, 'case-a', 'trace.zip'), Buffer.alloc(90_000, 2));
    writeFileSync(join(tree, 'node_modules', 'dependency', 'secret.txt'), 'excluded');

    const result = runCollector([
      '--output', output,
      '--max-bytes', '131072',
      '--tree', `playwright=${tree}`,
    ]);
    assert.equal(result.status, 0, result.stderr);
    const manifest = JSON.parse(readFileSync(join(output, 'manifest.json'), 'utf8'));
    assert.equal(manifest.inputs[0].status, 'partial');
    assert.deepEqual(manifest.inputs[0].includedFiles, ['playwright/case-a/screenshot.png']);
    assert.equal(manifest.inputs[0].skippedFiles[0].reason, 'cap_exceeded');
    assert.ok(manifest.totalBytes <= 131072);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('collector reports the exact bundle size across a manifest digit boundary', () => {
  const root = mkdtempSync(join(tmpdir(), 'los-ci-evidence-'));
  try {
    const input = join(root, 'input.bin');
    const output = join(root, 'bundle');
    writeFileSync(input, Buffer.alloc(99_551));

    const result = runCollector([
      '--output', output,
      '--max-bytes', '200000',
      '--file', `input=${input}`,
    ]);
    assert.equal(result.status, 0, result.stderr);
    const manifestPath = join(output, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const actualBytes = statSync(join(output, 'input.bin')).size + statSync(manifestPath).size;
    assert.equal(manifest.totalBytes, actualBytes);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('collector refuses to overwrite an existing output directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'los-ci-evidence-'));
  try {
    const output = join(root, 'bundle');
    mkdirSync(output);
    const result = runCollector(['--output', output]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /output already exists/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function runCollector(args) {
  return spawnSync(process.execPath, [collector, ...args], { encoding: 'utf8' });
}
