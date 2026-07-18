import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readMemoryMd, syncMemoryMd } from './markdown.js';

test('explicit syncMemoryMd writes bounded recent observations with metadata', () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'los-memory-md-'));

  try {
    assert.equal(readMemoryMd(workspaceRoot), null);
    syncMemoryMd(workspaceRoot, [
      {
        title: 'Provider readiness classified',
        summary: 'DeepSeek is ready while Anthropic is blocked by a missing key.',
        kind: 'operation',
        tags: ['provider', 'readiness'],
        createdAt: '2026-06-02T10:00:00.000Z',
      },
    ], 'LOS Memory');

    const content = readMemoryMd(workspaceRoot);
    assert.ok(content);
    assert.match(content, /^# LOS Memory/m);
    assert.match(content, /## Recent Observations/);
    assert.match(content, /### Provider readiness classified/);
    assert.match(content, /DeepSeek is ready while Anthropic is blocked by a missing key\./);
    assert.match(content, /- \*\*Kind\*\*: operation \| \*\*Date\*\*: 2026-06-02 `provider` `readiness`/);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('readMemoryMd returns null when MEMORY.md is absent', () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'los-memory-md-empty-'));

  try {
    assert.equal(readMemoryMd(workspaceRoot), null);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});
