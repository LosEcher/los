import test from 'node:test';
import assert from 'node:assert/strict';

import { sessionEventVisibility } from './session-events.js';

test('sessionEventVisibility: tool_call_state is internal', () => {
  assert.equal(sessionEventVisibility('tool_call_state.updated'), 'internal');
  assert.equal(sessionEventVisibility('tool_call_state.started'), 'internal');
});

test('sessionEventVisibility: governance lifecycle is audit', () => {
  assert.equal(sessionEventVisibility('governance.sweep.started'), 'audit');
  assert.equal(sessionEventVisibility('governance.sweep.completed'), 'audit');
  assert.equal(sessionEventVisibility('governance.job.started'), 'audit');
  assert.equal(sessionEventVisibility('governance.job.completed'), 'audit');
});

test('sessionEventVisibility: coordinator decisions are audit', () => {
  assert.equal(sessionEventVisibility('coordinator.intake_resolved'), 'audit');
  assert.equal(sessionEventVisibility('coordinator.intake_blocked'), 'audit');
});

test('sessionEventVisibility: pre-action evidence is audit', () => {
  assert.equal(sessionEventVisibility('tool.pre_action.failure'), 'audit');
  assert.equal(sessionEventVisibility('tool.gate.feedback.ok'), 'audit');
});

test('sessionEventVisibility: session bookmarks are audit', () => {
  assert.equal(sessionEventVisibility('session.started'), 'audit');
  assert.equal(sessionEventVisibility('session.completed'), 'audit');
  assert.equal(sessionEventVisibility('tool.catalog'), 'audit');
});

test('sessionEventVisibility: default is public', () => {
  assert.equal(sessionEventVisibility('model.delta'), 'public');
  assert.equal(sessionEventVisibility('task.succeeded'), 'public');
});
