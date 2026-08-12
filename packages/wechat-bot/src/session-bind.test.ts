import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { clearBoundSession, loadBoundSession, saveBoundSession } from './session-bind.js';

test('session bind save/load/clear roundtrip', () => {
  const dir = mkdtempSync(join(tmpdir(), 'los-bind-'));
  const path = join(dir, 'bind.json');
  try {
    assert.equal(loadBoundSession(path), null);
    const saved = saveBoundSession('session-abc', path);
    assert.equal(saved.sessionId, 'session-abc');
    assert.equal(loadBoundSession(path)?.sessionId, 'session-abc');
    clearBoundSession(path);
    assert.equal(loadBoundSession(path), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
