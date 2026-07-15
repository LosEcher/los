import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findImporters } from './check-delete-importers.mjs';

test('delete import resolution distinguishes a moved module with the same basename', () => {
  const root = mkdtempSync(join(tmpdir(), 'los-delete-importers-'));
  const sources = [
    'packages/agent/src/consumer.ts',
    'packages/infra/src/config.ts',
    'packages/infra/src/provider-defaults.ts',
  ];
  write(root, sources[0], "import { defaults } from './provider-defaults.js';\n");
  write(root, sources[1], "import { defaults } from './provider-defaults.js';\n");
  write(root, sources[2], 'export const defaults = {};\n');

  assert.deepEqual(findImporters({
    root,
    deletedFile: 'packages/agent/src/provider-defaults.ts',
    sourceFiles: sources,
  }), ['packages/agent/src/consumer.ts']);
});

test('delete import resolution recognizes package subpath imports', () => {
  const root = mkdtempSync(join(tmpdir(), 'los-delete-importers-'));
  const source = 'packages/gateway/src/consumer.ts';
  write(root, source, "import { defaults } from '@los/agent/provider-defaults';\n");

  assert.deepEqual(findImporters({
    root,
    deletedFile: 'packages/agent/src/provider-defaults.ts',
    sourceFiles: [source],
  }), [source]);
});

function write(root, file, content) {
  const target = join(root, file);
  mkdirSync(join(target, '..'), { recursive: true });
  writeFileSync(target, content);
}
