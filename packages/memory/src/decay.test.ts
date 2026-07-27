import test from 'node:test';
import assert from 'node:assert/strict';

import { decayScore, decayScores, calculateDecayScores, shouldTriggerCompaction, STALE_THRESHOLD, type DecayObservation } from './core/decay.js';
import { loadConfig } from '@los/infra/config';
import { closeDb, getDb, initDb } from '@los/infra/db';
import { ensureMemoryStore, addObservation } from './core/store.js';

function now(): Date { return new Date(); }
function hoursAgo(h: number): Date { return new Date(Date.now() - h * 3_600_000); }

test('decayScore: fresh observation scores high (> 0.8)', () => {
  const result = decayScore({
    createdAt: now(),
    referenceCount: 2,
    toolStatus: 'running',
  });
  assert.ok(result.score >= 0.8, `fresh+refs+running should score high, got ${result.score}`);
  assert.equal(result.stale, false);
});

test('decayScore: old unreferenced failed observation scores stale (< STALE_THRESHOLD)', () => {
  const result = decayScore({
    createdAt: hoursAgo(48),
    referenceCount: 0,
    toolStatus: 'failed',
  });
  assert.ok(result.score < STALE_THRESHOLD, `old+unref+failed should be stale, got ${result.score}`);
  assert.equal(result.stale, true);
});

test('decayScore: factor breakdown is in expected ranges', () => {
  const result = decayScore({
    createdAt: hoursAgo(3),
    referenceCount: 1,
    toolStatus: 'succeeded',
  });
  assert.ok(result.factors.base > 0 && result.factors.base <= 1);
  assert.ok(result.factors.recency > 0 && result.factors.recency <= 1);
  assert.ok(result.factors.referenceCount > 0 && result.factors.referenceCount <= 1);
  assert.ok(result.factors.toolStatus > 0 && result.factors.toolStatus <= 1);
  const expected = Number((result.factors.base * result.factors.recency * result.factors.referenceCount * result.factors.toolStatus).toFixed(4));
  assert.ok(Math.abs(result.score - expected) < 0.001,
    `score ${result.score} ≈ ${expected}`);
});

test('decayScore: tool status protections', () => {
  // running = protected
  const running = decayScore({ createdAt: hoursAgo(12), referenceCount: 0, toolStatus: 'running' });
  // failed with same age and refs
  const failed = decayScore({ createdAt: hoursAgo(12), referenceCount: 0, toolStatus: 'failed' });
  assert.ok(running.score > failed.score, 'running should outscore failed at same age/refs');

  // requested = protected
  const requested = decayScore({ createdAt: hoursAgo(12), referenceCount: 0, toolStatus: 'requested' });
  assert.ok(requested.score > failed.score, 'requested should outscore failed');
});

test('decayScore: reference count boosts score', () => {
  const unref = decayScore({ createdAt: hoursAgo(6), referenceCount: 0 });
  const singleRef = decayScore({ createdAt: hoursAgo(6), referenceCount: 1 });
  const multiRef = decayScore({ createdAt: hoursAgo(6), referenceCount: 2 });
  assert.ok(singleRef.score > unref.score, '1 ref should outscore 0 refs');
  assert.ok(multiRef.score > singleRef.score, '2+ refs should outscore 1 ref');
});

test('decayScore: score is always in [0, 1]', () => {
  const extremes: DecayObservation[] = [
    { createdAt: now(), referenceCount: 10, toolStatus: 'running' },
    { createdAt: hoursAgo(720), referenceCount: 0, toolStatus: 'failed' },
    { createdAt: hoursAgo(24), referenceCount: 0 },
    { createdAt: hoursAgo(1), referenceCount: 0, toolStatus: 'cancelled' },
  ];
  for (const obs of extremes) {
    const result = decayScore(obs);
    assert.ok(result.score >= 0 && result.score <= 1, `score ${result.score} out of [0,1]`);
  }
});

test('decayScores: empty array returns sensible defaults', () => {
  const result = decayScores([]);
  assert.deepStrictEqual(result.scores, []);
  assert.equal(result.staleCount, 0);
  assert.equal(result.staleRatio, 0);
  assert.equal(result.averageScore, 1);
});

test('decayScores: all-fresh session has low stale ratio', () => {
  const obs: DecayObservation[] = Array.from({ length: 5 }, () => ({
    createdAt: now(),
    referenceCount: 2,
    toolStatus: 'running' as const,
  }));
  const result = decayScores(obs);
  assert.equal(result.staleCount, 0);
  assert.equal(result.staleRatio, 0);
  assert.ok(result.averageScore > 0.8);
});

test('decayScores: all-stale session has high stale ratio', () => {
  const obs: DecayObservation[] = Array.from({ length: 5 }, () => ({
    createdAt: hoursAgo(100),
    referenceCount: 0,
    toolStatus: 'failed' as const,
  }));
  const result = decayScores(obs);
  assert.equal(result.staleCount, 5);
  assert.equal(result.staleRatio, 1);
  assert.ok(result.averageScore < STALE_THRESHOLD);
});

test('decayScores: mixed session computes correct aggregate', () => {
  const obs: DecayObservation[] = [
    { createdAt: now(), referenceCount: 2, toolStatus: 'running' },
    { createdAt: hoursAgo(50), referenceCount: 0, toolStatus: 'failed' },
    { createdAt: hoursAgo(3), referenceCount: 1 },
    { createdAt: hoursAgo(48), referenceCount: 0, toolStatus: 'cancelled' },
  ];
  const result = decayScores(obs);
  assert.ok(result.staleCount > 0 && result.staleCount < obs.length, 'mixed should have some stale');
  assert.ok(result.averageScore > 0 && result.averageScore < 1);
  assert.equal(result.scores.length, obs.length);
});

// ── DB-backed tests ─────────────────────────────────────────────

test('calculateDecayScores: empty session returns sensible default', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  const sessionId = `decay-empty-${Date.now()}`;
  try {
    await ensureMemoryStore();
    const result = await calculateDecayScores(sessionId);
    assert.equal(result.sessionId, sessionId);
    assert.equal(result.observationCount, 0);
    assert.equal(result.staleCount, 0);
    assert.equal(result.staleRatio, 0);
    assert.equal(result.results.length, 0);
  } finally {
    await closeDb().catch(() => undefined);
  }
});

test('calculateDecayScores: scores fresh observation correctly', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  const sessionId = `decay-fresh-${Date.now()}`;
  try {
    await ensureMemoryStore();
    await addObservation({ title: 'fresh obs', kind: 'note', sessionId });
    // Set referenceCount and toolStatus in metadata
    await getDb().query(
      `UPDATE observations SET metadata_json = $2::jsonb WHERE session_id = $1`,
      [sessionId, JSON.stringify({ referenceCount: 2, toolStatus: 'running' })],
    );
    const result = await calculateDecayScores(sessionId);
    assert.equal(result.observationCount, 1);
    assert.equal(result.staleCount, 0);
    assert.ok(result.averageScore > 0.8, `fresh+refs+running should be > 0.8, got ${result.averageScore}`);
  } finally {
    await getDb().query('DELETE FROM observations WHERE session_id = $1', [sessionId]).catch(() => undefined);
    await closeDb().catch(() => undefined);
  }
});

test('calculateDecayScores: stale ratio computed across multiple observations', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  const sessionId = `decay-mix-${Date.now()}`;
  try {
    await ensureMemoryStore();
    // Fresh observation
    await addObservation({ title: 'fresh', kind: 'note', sessionId });
    // Stale observation (old, no refs, failed tool)
    await addObservation({ title: 'stale', kind: 'note', sessionId });
    await getDb().query(
      `UPDATE observations SET
         metadata_json = CASE
           WHEN title = 'fresh' THEN $2::jsonb
           WHEN title = 'stale' THEN $3::jsonb
         END
       WHERE session_id = $1`,
      [sessionId,
       JSON.stringify({ referenceCount: 2, toolStatus: 'running' }),
       JSON.stringify({ referenceCount: 0, toolStatus: 'failed' })],
    );
    // Manually age the stale observation
    await getDb().query(
      `UPDATE observations SET created_at = now() - interval '72 hours' WHERE session_id = $1 AND title = 'stale'`,
      [sessionId],
    );
    const result = await calculateDecayScores(sessionId);
    assert.equal(result.observationCount, 2);
    assert.ok(result.staleCount >= 1, 'at least 1 stale');
    assert.ok(result.averageScore > 0 && result.averageScore < 1);
    assert.equal(result.staleObservationIds.length, result.staleCount);
  } finally {
    await getDb().query('DELETE FROM observations WHERE session_id = $1', [sessionId]).catch(() => undefined);
    await closeDb().catch(() => undefined);
  }
});

// ── Auto-trigger tests ──────────────────────────────────────────

test('shouldTriggerCompaction: empty session does not trigger', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  const sessionId = `trig-empty-${Date.now()}`;
  try {
    await ensureMemoryStore();
    const decision = await shouldTriggerCompaction(sessionId);
    assert.equal(decision.triggered, false);
    assert.equal(decision.reason, 'none');
  } finally {
    await closeDb().catch(() => undefined);
  }
});

test('shouldTriggerCompaction: low decay + volume triggers', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  const sessionId = `trig-low-${Date.now()}`;
  try {
    await ensureMemoryStore();
    for (let i = 0; i < 20; i++) {
      await addObservation({ title: `old-${i}`, kind: 'note', sessionId });
    }
    await getDb().query(
      `UPDATE observations SET created_at = now() - interval '100 hours',
         metadata_json = $2::jsonb WHERE session_id = $1`,
      [sessionId, JSON.stringify({ referenceCount: 0, toolStatus: 'failed' })],
    );
    const decision = await shouldTriggerCompaction(sessionId);
    assert.equal(decision.triggered, true);
    assert.equal(decision.reason, 'low_decay');
    assert.ok(decision.averageScore < 0.3);
  } finally {
    await getDb().query('DELETE FROM observations WHERE session_id = $1', [sessionId]).catch(() => undefined);
    await closeDb().catch(() => undefined);
  }
});

test('shouldTriggerCompaction: high stale ratio triggers', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  const sessionId = `trig-stale-${Date.now()}`;
  try {
    await ensureMemoryStore();
    for (let i = 0; i < 3; i++) await addObservation({ title: `s-${i}`, kind: 'note', sessionId });
    for (let i = 0; i < 2; i++) await addObservation({ title: `f-${i}`, kind: 'note', sessionId });
    await getDb().query(
      `UPDATE observations SET created_at = now() - interval '100 hours',
         metadata_json = $2::jsonb WHERE session_id = $1 AND title LIKE 's-%'`,
      [sessionId, JSON.stringify({ referenceCount: 0, toolStatus: 'failed' })],
    );
    const decision = await shouldTriggerCompaction(sessionId);
    assert.equal(decision.triggered, true);
    assert.equal(decision.reason, 'high_stale');
    assert.ok(decision.staleRatio > 0.4);
  } finally {
    await getDb().query('DELETE FROM observations WHERE session_id = $1', [sessionId]).catch(() => undefined);
    await closeDb().catch(() => undefined);
  }
});

test('shouldTriggerCompaction: fresh session does not trigger', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  const sessionId = `trig-fresh-${Date.now()}`;
  try {
    await ensureMemoryStore();
    await addObservation({ title: 'fresh', kind: 'note', sessionId });
    await getDb().query(
      `UPDATE observations SET metadata_json = $2::jsonb WHERE session_id = $1`,
      [sessionId, JSON.stringify({ referenceCount: 2, toolStatus: 'running' })],
    );
    const decision = await shouldTriggerCompaction(sessionId);
    assert.equal(decision.triggered, false);
  } finally {
    await getDb().query('DELETE FROM observations WHERE session_id = $1', [sessionId]).catch(() => undefined);
    await closeDb().catch(() => undefined);
  }
});
