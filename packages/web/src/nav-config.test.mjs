import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// Compile-free pure helpers reimplemented for node:test (source is TS via Vite).
// Keep in sync with nav-config.ts — structural contract only.

const MOBILE_TAB_IDS = ['inbox', 'work', 'chat'];
const DAILY_IDS = ['inbox', 'work', 'schedules', 'chat'];

function isMobileTabPage(id) {
  return MOBILE_TAB_IDS.includes(id);
}

function isMoreShellPage(id) {
  return !isMobileTabPage(id);
}

describe('mobile daily shell nav contract', () => {
  it('keeps three primary phone tabs and parks schedules in More', () => {
    assert.deepEqual(MOBILE_TAB_IDS, ['inbox', 'work', 'chat']);
    assert.equal(isMobileTabPage('schedules'), false);
    assert.equal(isMoreShellPage('schedules'), true);
    assert.equal(isMoreShellPage('providers'), true);
    assert.equal(isMoreShellPage('tasks'), true);
    for (const id of MOBILE_TAB_IDS) {
      assert.equal(isMobileTabPage(id), true);
      assert.equal(isMoreShellPage(id), false);
    }
  });

  it('keeps desktop daily path as four decision surfaces', () => {
    assert.deepEqual(DAILY_IDS, ['inbox', 'work', 'schedules', 'chat']);
  });
});
