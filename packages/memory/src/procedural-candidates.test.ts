import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { loadConfig } from '@los/infra/config';
import { closeDb, getDb, initDb } from '@los/infra/db';
import {
  createProceduralCandidate,
  deleteProceduralCandidate,
  ensureProceduralCandidateStore,
  getProceduralCandidate,
  listActiveCandidates,
  listProceduralCandidates,
  promoteProceduralCandidate,
} from './procedural-candidates.js';

test('procedural candidates: create, get, list, promote lifecycle', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);

  const sessionId = `pc-test-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const compactionId = randomUUID();

  try {
    await ensureProceduralCandidateStore();

    // Create
    const created = await createProceduralCandidate({
      name: 'test-rule',
      content: 'Do not deploy on Fridays',
      severity: 'warn',
      rationale: 'Observed 3 Friday deployment failures',
      confidence: 0.7,
      status: 'draft',
      compactionId,
      sessionId,
      supportingSessionIds: [sessionId, 'other-session-1'],
    });

    assert.ok(created.id.startsWith('pc-'));
    assert.equal(created.name, 'test-rule');
    assert.equal(created.status, 'draft');
    assert.equal(created.severity, 'warn');
    assert.equal(created.evidence.supportingSessionIds.length, 2);

    // Get
    const found = await getProceduralCandidate(created.id);
    assert.ok(found);
    assert.equal(found.name, 'test-rule');

    // List by status
    const drafts = await listProceduralCandidates({ status: 'draft' });
    assert.ok(drafts.some(c => c.id === created.id));

    // listActiveCandidates: should be empty until promoted to active
    const active0 = await listActiveCandidates();
    assert.ok(active0.every(c => c.id !== created.id));

    // Promote draft -> review -> approved -> active
    const reviewed = await promoteProceduralCandidate(created.id, 'review');
    assert.equal(reviewed!.status, 'review');

    const approved = await promoteProceduralCandidate(created.id, 'approved');
    assert.equal(approved!.status, 'approved');

    const active = await promoteProceduralCandidate(created.id, 'active');
    assert.equal(active!.status, 'active');

    const activeList = await listActiveCandidates();
    assert.ok(activeList.some(c => c.id === created.id));

    // Promote active -> retired
    const retired = await promoteProceduralCandidate(created.id, 'retired');
    assert.equal(retired!.status, 'retired');

    // Retired should not appear in active list
    const activeAfterRetire = await listActiveCandidates();
    assert.ok(activeAfterRetire.every(c => c.id !== created.id));

    // Delete
    const deleted = await deleteProceduralCandidate(created.id);
    assert.equal(deleted, true);

    const gone = await getProceduralCandidate(created.id);
    assert.equal(gone, null);
  } finally {
    await getDb().query('DELETE FROM procedural_candidates WHERE session_id = $1', [sessionId]).catch(() => undefined);
    await closeDb().catch(() => undefined);
  }
});

test('procedural candidates: listProceduralCandidates filters by compactionId and sessionId', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);

  const sessionA = `pc-filt-${Date.now()}-a`;
  const sessionB = `pc-filt-${Date.now()}-b`;
  const compA = randomUUID();
  const compB = randomUUID();

  try {
    await ensureProceduralCandidateStore();

    const a = await createProceduralCandidate({
      name: 'rule-a', content: 'A', compactionId: compA, sessionId: sessionA,
    });
    const b = await createProceduralCandidate({
      name: 'rule-b', content: 'B', compactionId: compB, sessionId: sessionB,
    });

    const byComp = await listProceduralCandidates({ compactionId: compA });
    assert.equal(byComp.length, 1);
    assert.equal(byComp[0].id, a.id);

    const bySess = await listProceduralCandidates({ sessionId: sessionB });
    assert.equal(bySess.length, 1);
    assert.equal(bySess[0].id, b.id);
  } finally {
    await getDb().query('DELETE FROM procedural_candidates WHERE session_id IN ($1, $2)', [sessionA, sessionB]).catch(() => undefined);
    await closeDb().catch(() => undefined);
  }
});

test('procedural candidates: promoteProceduralCandidate returns null for unknown id', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);

  try {
    await ensureProceduralCandidateStore();
    const result = await promoteProceduralCandidate('pc-nonexistent', 'active');
    assert.equal(result, null);
  } finally {
    await closeDb().catch(() => undefined);
  }
});
