import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GOVERNANCE_NOTIFY_SESSION_ID,
  governanceNotifyEventType,
} from './governance-notify.js';

test('governance notify event types map by kind', () => {
  assert.equal(governanceNotifyEventType('escalation'), 'governance.job.escalated');
  assert.equal(governanceNotifyEventType('progress'), 'governance.job.progress');
  assert.equal(governanceNotifyEventType('bootstrap_finding'), 'governance.bootstrap.findings');
  assert.equal(governanceNotifyEventType('sweep_digest'), 'governance.sweep.digest');
  assert.equal(GOVERNANCE_NOTIFY_SESSION_ID, 'governance:system');
});
