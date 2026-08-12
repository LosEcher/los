import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyCompanionSessionEvent,
  formatWorkerAskReason,
  shouldDeliverToBoundSession,
} from './operator-companion-events.js';

test('classifies worker.ask as needs_decision', () => {
  const result = classifyCompanionSessionEvent({
    type: 'worker.ask',
    payload: { question: 'Ship it?', options: ['yes', 'no'], messageId: 'm1' },
  });
  assert.equal(result.shouldNotify, true);
  assert.equal(result.kind, 'needs_decision');
  assert.match(result.title, /Worker/);
});

test('classifies success and verification failure', () => {
  assert.equal(classifyCompanionSessionEvent({ type: 'run.succeeded' }).kind, 'success');
  assert.equal(classifyCompanionSessionEvent({ type: 'run.verification_failed' }).kind, 'needs_decision');
  assert.equal(classifyCompanionSessionEvent({ type: 'run.verification_failed' }).severity, 'critical');
});

test('ignores unrelated chatter', () => {
  assert.equal(classifyCompanionSessionEvent({ type: 'model.delta' }).shouldNotify, false);
  assert.equal(classifyCompanionSessionEvent({ type: 'tool.call.upsert' }).shouldNotify, false);
});

test('bound session filter allows pin and global ops', () => {
  assert.equal(shouldDeliverToBoundSession('sess-a', 'sess-a'), true);
  assert.equal(shouldDeliverToBoundSession('sess-a', 'sess-b'), false);
  assert.equal(shouldDeliverToBoundSession(undefined, 'sess-b'), true);
  assert.equal(
    shouldDeliverToBoundSession('sess-a', '', { allowGlobalOps: true, eventType: 'ops.daily_digest' }),
    true,
  );
});

test('formatWorkerAskReason lists options', () => {
  assert.match(
    formatWorkerAskReason({ question: 'Continue?', options: ['yes', 'no'] }),
    /yes \/ no/,
  );
});
