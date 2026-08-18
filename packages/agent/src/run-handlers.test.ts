import assert from 'node:assert/strict';
import test from 'node:test';

import { shouldTriggerFleetRepair } from './scheduled-work/run-handlers.js';

test('shouldTriggerFleetRepair: quorum-guarded single-node repair trigger', () => {
  // Consent required
  assert.equal(shouldTriggerFleetRepair(['a'], 4, false), false);
  // Nothing offline
  assert.equal(shouldTriggerFleetRepair([], 4, true), false);
  // Empty fleet / unknown fleet size
  assert.equal(shouldTriggerFleetRepair(['a'], 0, true), false);

  // Single node offline within quorum → trigger
  assert.equal(shouldTriggerFleetRepair(['a'], 4, true), true);
  // 2 of 4 offline (50%) → trigger (<= 0.5)
  assert.equal(shouldTriggerFleetRepair(['a', 'b'], 4, true), true);
  // Majority offline (3 of 4) → control-plane outage, do NOT trigger
  assert.equal(shouldTriggerFleetRepair(['a', 'b', 'c'], 4, true), false);

  // Custom threshold
  assert.equal(shouldTriggerFleetRepair(['a', 'b'], 4, true, 0.4), false);
});
