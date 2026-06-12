import test from 'node:test';
import assert from 'node:assert/strict';

import { buildToolCallUpsertFromSessionEvent, createRunningToolCallUpsert } from './tool-call-upsert.js';

test('createRunningToolCallUpsert returns preview-only running patch', () => {
  const upsert = createRunningToolCallUpsert('call-1', 'read_file', { path: '/tmp/demo.txt' });
  assert.deepEqual(upsert, {
    callId: 'call-1',
    toolName: 'read_file',
    status: 'running',
    argsPreview: '{"path":"/tmp/demo.txt"}',
  });
});

test('buildToolCallUpsertFromSessionEvent maps tool.result to completed patch', () => {
  const upsert = buildToolCallUpsertFromSessionEvent({
    id: 1,
    sessionId: 'session-1',
    turn: 2,
    type: 'tool.result',
    source: 'agent',
    toolName: 'read_file',
    payload: {
      callId: 'call-1',
      ok: true,
      denied: false,
      contentPreview: '127.0.0.1 localhost',
      durationMs: 12,
      attempts: 1,
    },
    visibility: 'public',
    createdAt: new Date().toISOString(),
  });
  assert.deepEqual(upsert, {
    callId: 'call-1',
    toolName: 'read_file',
    status: 'completed',
    resultPreview: '127.0.0.1 localhost',
    errorPreview: undefined,
    durationMs: 12,
    attempts: 1,
  });
});

test('buildToolCallUpsertFromSessionEvent maps denied tool.result to denied patch', () => {
  const upsert = buildToolCallUpsertFromSessionEvent({
    id: 2,
    sessionId: 'session-1',
    turn: 2,
    type: 'tool.result',
    source: 'agent',
    toolName: 'run_shell',
    payload: {
      callId: 'call-2',
      ok: false,
      denied: true,
      errorPreview: 'blocked by policy',
      durationMs: 1,
      attempts: 1,
    },
    visibility: 'public',
    createdAt: new Date().toISOString(),
  });
  assert.deepEqual(upsert, {
    callId: 'call-2',
    toolName: 'run_shell',
    status: 'denied',
    resultPreview: undefined,
    errorPreview: 'blocked by policy',
    durationMs: 1,
    attempts: 1,
  });
});
