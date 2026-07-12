import test from 'node:test';
import assert from 'node:assert/strict';

import { _requiresActorContext } from './request-context.js';

test('infrastructure health and heartbeat paths do not require actor context', () => {
  for (const path of ['/health', '/live', '/ready', '/nodes/heartbeat', '/health?probe=1']) {
    assert.equal(_requiresActorContext(path), false, path);
  }
});

test('user and operator routes continue to require actor context', () => {
  for (const path of ['/chat', '/nodes', '/services', '/runs/run-1']) {
    assert.equal(_requiresActorContext(path), true, path);
  }
});
