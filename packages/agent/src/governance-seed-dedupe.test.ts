/**
 * Governance seed-classification tests — pure-function, hermetic (no DB).
 *
 * Regression guard for the duplicate-generator observed 2026-09/10: three
 * `dead_letter` governance jobs with the same `dedupe_key` accumulated because
 * the seeder looked up only `status='active'`. A job that paused itself under
 * the no-op throttle therefore fell out of the lookup, and the unique index
 * (`WHERE dedupe_key IS NOT NULL AND status='active'`) accepted a brand new row
 * on the next seed. `decideGovernanceSeedAction` now keys off the dedupe_key
 * across all statuses, so paused/retired rows suppress the insert.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { decideGovernanceSeedAction } from './governance-jobs-crud.js';

const row = (id: string, status: 'active' | 'paused' | 'retired') => ({ id, status });

describe('governance seed classification', () => {
  it('seeds only when the dedupe_key is absent entirely', () => {
    assert.deepEqual(decideGovernanceSeedAction([]), { action: 'insert' });
  });

  it('keeps an existing active row instead of inserting', () => {
    assert.deepEqual(
      decideGovernanceSeedAction([row('govjob-a', 'active')]),
      { action: 'active', activeIds: ['govjob-a'] },
    );
  });

  it('never re-creates a paused job (the duplicate-generator)', () => {
    // This is the exact shape that produced 3 dead_letter jobs: all rows paused.
    assert.deepEqual(
      decideGovernanceSeedAction([row('govjob-a', 'paused')]),
      { action: 'held', heldIds: ['govjob-a'] },
    );
  });

  it('treats retired as durable decommission', () => {
    assert.deepEqual(
      decideGovernanceSeedAction([row('govjob-a', 'retired')]),
      { action: 'held', heldIds: ['govjob-a'] },
    );
  });

  it('holds every non-active row it finds', () => {
    assert.deepEqual(
      decideGovernanceSeedAction([
        row('govjob-old', 'retired'),
        row('govjob-mid', 'retired'),
        row('govjob-new', 'paused'),
      ]),
      { action: 'held', heldIds: ['govjob-old', 'govjob-mid', 'govjob-new'] },
    );
  });

  it('prefers the active row when a mix is present (held rows never win)', () => {
    assert.deepEqual(
      decideGovernanceSeedAction([
        row('govjob-old', 'retired'),
        row('govjob-live', 'active'),
      ]),
      { action: 'active', activeIds: ['govjob-live'] },
    );
  });
});
