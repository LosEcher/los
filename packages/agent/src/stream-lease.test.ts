/**
 * stream-lease tests — cross-gateway session ownership.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { getDb } from '@los/infra/db';
import {
  acquireStreamLease,
  releaseStreamLease,
  heartbeatStreamLease,
  getActiveLease,
} from './stream-lease.js';

describe('stream-lease', () => {
  it('acquires a lease for a new session', async () => {
    const result = await acquireStreamLease({
      sessionId: 'sess-lease-1',
      gateway: 'gw-1',
    });
    assert.ok(result.canTakeover);
    assert.ok(result.newLease);
    assert.equal(result.newLease.status, 'active');
    assert.equal(result.newLease.gateway, 'gw-1');
  });

  it('rejects acquire when another gateway holds a fresh lease', async () => {
    await acquireStreamLease({ sessionId: 'sess-lease-2', gateway: 'gw-1' });
    const result = await acquireStreamLease({
      sessionId: 'sess-lease-2',
      gateway: 'gw-2',
      ttlSeconds: 30,
    });
    assert.equal(result.canTakeover, false);
    assert.ok(result.previousLease);
    assert.equal(result.previousLease.gateway, 'gw-1');
    assert.match(result.reason, /gw-1/);
  });

  it('releases a lease', async () => {
    await acquireStreamLease({ sessionId: 'sess-lease-3', gateway: 'gw-1' });
    await releaseStreamLease('sess-lease-3', 'gw-1');
    const active = await getActiveLease('sess-lease-3');
    assert.equal(active, null);
  });

  it('heartbeat keeps lease alive', async () => {
    await acquireStreamLease({ sessionId: 'sess-lease-4', gateway: 'gw-1' });
    await heartbeatStreamLease('sess-lease-4', 'gw-1');
    const lease = await getActiveLease('sess-lease-4');
    assert.ok(lease);
    assert.equal(lease.status, 'active');
    assert.ok(new Date(lease.heartbeatAt).getTime() > Date.now() - 5000);
  });

  it('returns null for session with no active lease', async () => {
    const lease = await getActiveLease('sess-nonexistent');
    assert.equal(lease, null);
  });

  it('different session leases do not conflict', async () => {
    const r1 = await acquireStreamLease({ sessionId: 'sess-lease-5a', gateway: 'gw-1' });
    const r2 = await acquireStreamLease({ sessionId: 'sess-lease-5b', gateway: 'gw-2' });
    assert.ok(r1.canTakeover);
    assert.ok(r2.canTakeover);
    assert.equal(r1.newLease?.sessionId, 'sess-lease-5a');
    assert.equal(r2.newLease?.sessionId, 'sess-lease-5b');
  });
});
