import test from 'node:test';
import assert from 'node:assert/strict';

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
      (c: Record<string, unknown>) => String(c.name ?? '').includes('executor-failover'),
    ));
  } finally {
    await getDb().query('DELETE FROM run_evals WHERE session_id = $1', [sessionId]).catch(() => undefined);
    await getDb().query('DELETE FROM memory_compactions WHERE session_id = $1', [sessionId]).catch(() => undefined);
    await closeDb().catch(() => undefined);
  }
});
