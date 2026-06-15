import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { loadConfig } from '@los/infra/config';
import { closeDb, getDb, initDb } from '@los/infra/db';
import {
  addObservation,
  ensureMemoryStore,
} from './store.js';
import {
  compactSession,
  ensureMemoryCompactionStore,
  getCompaction,
  listCompactions,
  attestCompaction,
  promoteCandidate,
} from './compaction.js';

test('memory compaction summarises session observations and task runs', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);

  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const sessionId = `session-compact-${suffix}`;

  try {
    await ensureMemoryStore();
    await addObservation({
      title: 'compaction test observation',
      summary: 'testing session compaction',
      kind: 'note',
      sessionId,
    });

    await ensureMemoryCompactionStore();
    const compaction = await compactSession({
      sessionId,
      createdBy: 'test-runner',
    });

    assert.equal(compaction.sessionId, sessionId);
    assert.equal(compaction.createdBy, 'test-runner');
    assert.equal(compaction.confidence, 0);

    const summary = compaction.summary;
    assert.equal(summary.sessionId, sessionId);
    assert.equal(summary.observationCount, 1);
    assert.equal(compaction.evidenceCount, 1);

    const loaded = await getCompaction(compaction.id);
    assert.ok(loaded);
    assert.equal(loaded?.id, compaction.id);
    assert.equal(loaded?.sessionId, sessionId);

    const listed = await listCompactions({ sessionId, limit: 10 });
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.id, compaction.id);
  } finally {
    await getDb().query('DELETE FROM memory_compactions WHERE session_id = $1', [sessionId]).catch(() => undefined);
    await closeDb().catch(() => undefined);
  }
});

test('compaction detects executor failover patterns from run evals', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);

  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const sessionId = `session-compact-failover-${suffix}`;

  try {
    await ensureMemoryCompactionStore();
    await ensureMemoryStore();

    await addObservation({
      title: 'failover observation',
      kind: 'note',
      sessionId,
    });

    // Insert an eval record with executor failover scope
    await getDb().query(
      `INSERT INTO run_evals (id, run_spec_id, session_id, success, failover_scope, failure_class)
       VALUES ($1, $2, $3, false, 'executor', 'executor_failure')`,
      [`eval-compact-failover-${suffix}`, `run-compact-${suffix}`, sessionId],
    );

    const compaction = await compactSession({ sessionId });

    assert.equal(compaction.evidenceCount, 2); // observations + evals
    assert.equal(compaction.summary.evalCount, 1);
    assert.ok(compaction.observedPatterns.some(
      (p: Record<string, unknown>) => p.kind === 'executor_failover',
    ));
    assert.ok(compaction.proceduralCandidates.length > 0);
    assert.ok(compaction.proceduralCandidates.some(
      (c) => c.name.includes('executor-failover'),
    ));
  } finally {
    await getDb().query('DELETE FROM run_evals WHERE session_id = $1', [sessionId]).catch(() => undefined);
    await getDb().query('DELETE FROM memory_compactions WHERE session_id = $1', [sessionId]).catch(() => undefined);
    await closeDb().catch(() => undefined);
  }
});

test('cross-session evidence: same pattern across 3 sessions produces review candidate', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);

  const prefix = `cross-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;

  try {
    await ensureMemoryStore();
    await ensureMemoryCompactionStore();

    const results: Array<{ sessionId: string }> = [];
    for (let i = 0; i < 3; i++) {
      const sessionId = `${prefix}-s${i}`;
      await addObservation({ title: `cross-obs-${i}`, kind: 'note', sessionId });
      await getDb().query(
        `INSERT INTO run_evals (id, run_spec_id, session_id, success, failover_scope, failure_class)
         VALUES ($1, $2, $3, false, 'executor', 'executor_failure')`,
        [`${prefix}-eval${i}`, `${prefix}-run${i}`, sessionId],
      );
      await compactSession({ sessionId });
      results.push({ sessionId });
    }

    const all = await listCompactions({ limit: 20 });
    const matching = all.filter(c => c.sessionId.startsWith(prefix));
    assert.equal(matching.length, 3);

    // First session: solo => draft (crossSessions < 2)
    const s0 = matching.find(c => c.sessionId === `${prefix}-s0`)!;
    assert.equal(s0.proceduralCandidates[0].status, 'draft');

    // Third session: crossSessions >= 2 => review
    const s2 = matching.find(c => c.sessionId === `${prefix}-s2`)!;
    assert.equal(s2.proceduralCandidates[0].status, 'review');
    assert.ok(s2.proceduralCandidates[0].confidence >= 0.7);
    assert.ok(s2.evidenceCount >= 3);

    for (const r of results) {
      await getDb().query('DELETE FROM run_evals WHERE session_id = $1', [r.sessionId]).catch(() => undefined);
      await getDb().query('DELETE FROM memory_compactions WHERE session_id = $1', [r.sessionId]).catch(() => undefined);
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
    await addObservation({ title: 'attest obs', kind: 'note', sessionId });
    const compaction = await compactSession({ sessionId });
    assert.ok(!compaction.attestedAt);

    const attested = await attestCompaction(compaction.id, 'operator-test');
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
    assert.equal(compaction.summary.observationCount, 1);
    assert.equal(compaction.summary.taskRunCount, 0);
    assert.equal(compaction.summary.evalCount, 0);
    assert.equal(compaction.proceduralCandidates.length, 0);
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
    assert.equal(compaction.summary.observationCount, 0);
    assert.equal(compaction.summary.taskRunCount, 0);
    assert.equal(compaction.summary.evalCount, 0);
    assert.equal(compaction.evidenceCount, 0);
    assert.equal(compaction.confidence, 0);
    assert.equal(compaction.proceduralCandidates.length, 0);
  } finally {
    await getDb().query('DELETE FROM memory_compactions WHERE session_id = $1', [sessionId]).catch(() => undefined);
    await closeDb().catch(() => undefined);
  }
});
