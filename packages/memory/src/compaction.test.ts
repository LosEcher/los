import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { loadConfig } from '@los/infra/config';
import { closeDb, getDb, initDb } from '@los/infra/db';
import { ensureMemoryStore, addObservation } from './core/store.js';
import {
  compactSession,
  ensureMemoryCompactionStore,
  getCompaction,
  listCompactions,
  attestCompaction,
  promoteCandidate,
} from './core/compaction.js';

test('cross-session evidence: same pattern across 3 sessions produces review candidate', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);

  const prefix = `cross-session-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;

  try {
    await ensureMemoryStore();
    await ensureMemoryCompactionStore();

    // Clean up ALL compactions to prevent cross-session pollution from previous runs
    await getDb().query('DELETE FROM memory_compactions').catch(() => undefined);
    await getDb().query('DELETE FROM run_evals').catch(() => undefined);

    // Create 3 sessions, each with an executor failover eval (same pattern kind)
    const sessionResults = [];
    for (let i = 0; i < 3; i++) {
      const sessionId = `${prefix}-s${i}`;
      const evalId = `${prefix}-eval${i}`;
      const runSpecId = `${prefix}-run${i}`;

      await addObservation({
        title: `cross-session test observation ${i}`,
        kind: 'note',
        sessionId,
      });

      await getDb().query(
        `INSERT INTO run_evals (id, run_spec_id, session_id, success, failover_scope, failure_class)
         VALUES ($1, $2, $3, false, 'executor', 'executor_failure')`,
        [evalId, runSpecId, sessionId],
      );

      const compaction = await compactSession({ sessionId });
      sessionResults.push({ sessionId, compaction });
    }

    // Session 0: only 1 session => confidence = 0.5, status = draft
    assert.equal(sessionResults[0].compaction!.proceduralCandidates.length, 1);
    assert.equal(sessionResults[0].compaction!.proceduralCandidates[0].status, 'draft');
    assert.equal(sessionResults[0].compaction!.proceduralCandidates[0].confidence, 0.5);

    // Session 2: at least 2 other sessions already have this pattern => crossSessions >= 2
    const thirdCompaction = sessionResults[2].compaction!;
    const thirdCandidate = thirdCompaction.proceduralCandidates[0];
    assert.equal(thirdCandidate.status, 'review', `expected review, got ${thirdCandidate.status}`);
    assert.ok(thirdCandidate.confidence >= 0.7, `expected confidence >= 0.7, got ${thirdCandidate.confidence}`);
    assert.ok(thirdCompaction.evidenceCount >= 3, `expected evidenceCount >= 3, got ${thirdCompaction.evidenceCount}`);

    // List compactions: should return all 3
    const all = await listCompactions({ limit: 10 });
    const matching = all.filter(c => c.sessionId.startsWith(prefix));
    assert.equal(matching.length, 3);

    // Cleanup
    for (const { sessionId } of sessionResults) {
      await getDb().query('DELETE FROM run_evals WHERE session_id = $1', [sessionId]).catch(() => undefined);
      await getDb().query('DELETE FROM memory_compactions WHERE session_id = $1', [sessionId]).catch(() => undefined);
    }
  } finally {
    await closeDb().catch(() => undefined);
  }
});

test('attestCompaction stores attestation in summary_json', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);

  const sessionId = `attest-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;

  try {
    await ensureMemoryStore();
    await ensureMemoryCompactionStore();

    await addObservation({ title: 'attest test obs', kind: 'note', sessionId });
    const compaction = await compactSession({ sessionId });
    assert.ok(compaction, 'compaction should not be null for session with observations');
    assert.ok(!compaction!.attestedAt);

    const attested = await attestCompaction(compaction!.id, 'operator-test');
    assert.ok(attested);
    assert.equal(attested.attestedBy, 'operator-test');
    assert.ok(typeof attested.attestedAt === 'string');
  } finally {
    await getDb().query('DELETE FROM memory_compactions WHERE session_id = $1', [sessionId]).catch(() => undefined);
    await closeDb().catch(() => undefined);
  }
});

test('promoteCandidate transitions candidate status correctly', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);

  const sessionId = `promote-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;

  try {
    await ensureMemoryStore();
    await ensureMemoryCompactionStore();

    await addObservation({ title: 'promote test obs', kind: 'note', sessionId });

    // Create a compaction with a procedural candidate
    await getDb().query(
      `INSERT INTO memory_compactions (id, session_id, summary_json, observed_patterns_json, procedural_candidates_json, confidence, evidence_count)
       VALUES ($1, $2, '{}'::jsonb, '[{"kind":"test"}]'::jsonb, $3::jsonb, 0.8, 3)`,
      [randomUUID(), sessionId, JSON.stringify([{
        name: 'test-candidate',
        content: 'test rule content',
        severity: 'warn',
        rationale: 'test rationale',
        confidence: 0.8,
        status: 'draft',
        supportingSessionIds: [sessionId],
      }])],
    );

    const [compaction] = await listCompactions({ sessionId, limit: 1 });
    assert.ok(compaction);
    assert.equal(compaction!.proceduralCandidates[0].status, 'draft');

    // Promote draft → review
    const reviewed = await promoteCandidate(compaction!.id, 'test-candidate', 'review');
    assert.ok(reviewed);
    assert.equal(reviewed.proceduralCandidates[0].status, 'review');

    // Promote review → approved
    const approved = await promoteCandidate(compaction!.id, 'test-candidate', 'approved');
    assert.ok(approved);
    assert.equal(approved.proceduralCandidates[0].status, 'approved');

    // Promote approved → active
    const active = await promoteCandidate(compaction!.id, 'test-candidate', 'active');
    assert.ok(active);
    assert.equal(active.proceduralCandidates[0].status, 'active');

    // Promote active → retired
    const retired = await promoteCandidate(compaction!.id, 'test-candidate', 'retired');
    assert.ok(retired);
    assert.equal(retired.proceduralCandidates[0].status, 'retired');
  } finally {
    await getDb().query('DELETE FROM memory_compactions WHERE session_id = $1', [sessionId]).catch(() => undefined);
    await closeDb().catch(() => undefined);
  }
});

test('compactSession handles session with observations but no tasks or evals', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);

  const sessionId = `empty-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;

  try {
    await ensureMemoryStore();
    await ensureMemoryCompactionStore();

    // Only add observations, no task_runs or run_evals
    await addObservation({ title: 'solo observation', kind: 'note', sessionId });

    const compaction = await compactSession({ sessionId });
    assert.equal(compaction!.summary.observationCount, 1);
    assert.equal(compaction!.summary.taskRunCount, 0);
    assert.equal(compaction!.summary.evalCount, 0);
    assert.equal(compaction!.evidenceCount, 1);
    assert.equal(compaction!.proceduralCandidates.length, 0);
  } finally {
    await getDb().query('DELETE FROM memory_compactions WHERE session_id = $1', [sessionId]).catch(() => undefined);
    await closeDb().catch(() => undefined);
  }
});

test('compactSession handles empty session gracefully', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);

  const sessionId = `really-empty-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;

  try {
    await ensureMemoryStore();
    await ensureMemoryCompactionStore();

    const compaction = await compactSession({ sessionId });
    assert.equal(compaction, null, 'empty session should return null');
  } finally {
    await getDb().query('DELETE FROM memory_compactions WHERE session_id = $1', [sessionId]).catch(() => undefined);
    await closeDb().catch(() => undefined);
  }
});

test('attestCompaction stores attestation in summary_json', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);

  const sessionId = `attest-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;

  try {
    await ensureMemoryStore();
    await ensureMemoryCompactionStore();
    await addObservation({ title: 'attest obs', kind: 'note', sessionId });
    const compaction = await compactSession({ sessionId });
    assert.ok(!compaction!.attestedAt);

    const attested = await attestCompaction(compaction!.id, 'operator-test');
    assert.ok(attested);
    assert.equal(attested.attestedBy, 'operator-test');
    assert.ok(typeof attested.attestedAt === 'string');
  } finally {
    await getDb().query('DELETE FROM memory_compactions WHERE session_id = $1', [sessionId]).catch(() => undefined);
    await closeDb().catch(() => undefined);
  }
});

test('promoteCandidate transitions draft→review→approved→active→retired', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);

  const sessionId = `promote-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;

  try {
    await ensureMemoryCompactionStore();

    const compactionId = randomUUID();
    await getDb().query(
      `INSERT INTO memory_compactions (id, session_id, summary_json, observed_patterns_json, procedural_candidates_json, confidence, evidence_count)
       VALUES ($1, $2, '{}'::jsonb, '[{"kind":"test"}]'::jsonb, $3::jsonb, 0.8, 3)`,
      [compactionId, sessionId, JSON.stringify([{
        name: 'test-candidate', content: 'test rule', severity: 'warn',
        rationale: 'test', confidence: 0.8, status: 'draft', supportingSessionIds: [sessionId],
      }])],
    );

    const reviewed = await promoteCandidate(compactionId, 'test-candidate', 'review');
    assert.equal(reviewed!.proceduralCandidates[0].status, 'review');

    const approved = await promoteCandidate(compactionId, 'test-candidate', 'approved');
    assert.equal(approved!.proceduralCandidates[0].status, 'approved');

    const active = await promoteCandidate(compactionId, 'test-candidate', 'active');
    assert.equal(active!.proceduralCandidates[0].status, 'active');

    const retired = await promoteCandidate(compactionId, 'test-candidate', 'retired');
    assert.equal(retired!.proceduralCandidates[0].status, 'retired');
  } finally {
    await getDb().query('DELETE FROM memory_compactions WHERE session_id = $1', [sessionId]).catch(() => undefined);
    await closeDb().catch(() => undefined);
  }
});

test('compactSession with observations but no tasks or evals', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);

  const sessionId = `solo-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;

  try {
    await ensureMemoryStore();
    await ensureMemoryCompactionStore();
    await addObservation({ title: 'solo obs', kind: 'note', sessionId });

    const compaction = await compactSession({ sessionId });
    assert.equal(compaction!.summary.observationCount, 1);
    assert.equal(compaction!.summary.taskRunCount, 0);
    assert.equal(compaction!.summary.evalCount, 0);
    assert.equal(compaction!.proceduralCandidates.length, 0);
  } finally {
    await getDb().query('DELETE FROM memory_compactions WHERE session_id = $1', [sessionId]).catch(() => undefined);
    await closeDb().catch(() => undefined);
  }
});

test('compactSession handles completely empty session', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);

  const sessionId = `empty-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;

  try {
    await ensureMemoryCompactionStore();
    const compaction = await compactSession({ sessionId });
    assert.equal(compaction, null, 'completely empty session should return null');
  } finally {
    await getDb().query('DELETE FROM memory_compactions WHERE session_id = $1', [sessionId]).catch(() => undefined);
    await closeDb().catch(() => undefined);
  }
});
