import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { classifyPaths, isSafePath } from './path-gate.mjs';

const cli = fileURLToPath(new URL('./path-gate.mjs', import.meta.url));

const DOCS_ONLY = [
  'docs/operations/2026-08-18-runner-topology-and-turbo-persistence.md',
  'docs/operations/ci-observability.md',
];

test('docs/ nested paths are safe (the #291 group-$ regression)', () => {
  assert.equal(isSafePath('docs/operations/foo.md'), true);
  assert.equal(isSafePath('tools/path-gate.mjs'), true);
  assert.equal(isSafePath('.forgejo/workflows/ci.yml'), true);
  assert.equal(isSafePath('README.md'), true);
  assert.equal(isSafePath('packages/agent/src/x.ts'), false);
});

test('classifyPaths skips docs-only, tools-only, and listed root metadata', () => {
  assert.equal(classifyPaths(DOCS_ONLY).skipHeavy, true);
  assert.equal(classifyPaths(['tools/ci-gate.sh', 'tools/path-gate.mjs']).skipHeavy, true);
  assert.equal(
    classifyPaths(['docs/a.md', 'README.md', 'LICENSE', '.gitignore']).skipHeavy,
    true,
  );
  assert.equal(classifyPaths([]).skipHeavy, true);
});

test('classifyPaths runs full on any package or unknown root path', () => {
  const mixed = classifyPaths([...DOCS_ONLY, 'packages/web/src/App.tsx']);
  assert.equal(mixed.skipHeavy, false);
  assert.deepEqual(mixed.unsafe, ['packages/web/src/App.tsx']);

  assert.equal(classifyPaths(['AGENTS.md']).skipHeavy, false);
  assert.equal(classifyPaths(['package.json']).skipHeavy, false);
  assert.equal(classifyPaths(['pnpm-lock.yaml']).skipHeavy, false);
});

test('list failure is fail-closed (full suite)', () => {
  const listed = classifyPaths(null);
  assert.equal(listed.skipHeavy, false);
  assert.equal(listed.mode, 'error');
});

test('CLI writes skip_heavy to GITHUB_OUTPUT and always exits 0', () => {
  const root = mkdtempSync(join(tmpdir(), 'los-path-gate-'));
  try {
    const files = join(root, 'files.txt');
    const output = join(root, 'github-output');
    writeFileSync(files, DOCS_ONLY.join('\n') + '\n');
    const result = spawnSync(process.execPath, [cli, '--files-from', files], {
      env: { ...process.env, GITHUB_OUTPUT: output },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /PATH-GATE: skip_heavy=true/);
    assert.match(readFileSync(output, 'utf8'), /^skip_heavy=true$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CLI fail-closed when --files-from is missing', () => {
  const result = spawnSync(
    process.execPath,
    [cli, '--files-from', join(tmpdir(), 'los-path-gate-missing.txt')],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /PATH-GATE: skip_heavy=false/);
});
