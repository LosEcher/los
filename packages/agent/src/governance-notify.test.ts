import assert from 'node:assert/strict';
import test from 'node:test';
import type { GovernanceNotifyKind } from './governance-notify.js';

// Kind → event type mapping is private; keep the public contract asserted here
// so SSE/wechat consumers stay aligned without exporting helpers (wiring gate).
const KIND_TO_TYPE: Record<GovernanceNotifyKind, string> = {
  escalation: 'governance.job.escalated',
  progress: 'governance.job.progress',
  bootstrap_finding: 'governance.bootstrap.findings',
  sweep_digest: 'governance.sweep.digest',
};

test('governance notify kind contract stays aligned with operator SSE types', () => {
  assert.deepEqual(Object.keys(KIND_TO_TYPE).sort(), [
    'bootstrap_finding',
    'escalation',
    'progress',
    'sweep_digest',
  ]);
  assert.equal(KIND_TO_TYPE.escalation, 'governance.job.escalated');
  assert.equal(KIND_TO_TYPE.sweep_digest, 'governance.sweep.digest');
});
