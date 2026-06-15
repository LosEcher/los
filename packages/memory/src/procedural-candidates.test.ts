import test from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig } from '@los/infra/config';
import { closeDb, getDb, initDb } from '@los/infra/db';
import {
  ensureProceduralCandidateStore,
  createProceduralCandidate,
  upsertProceduralCandidate,
  promoteCandidate,
  listProceduralCandidates,
  loadProceduralCandidate,
} from './procedural-candidates.js';
import { ensureMemoryCompactionStore } from './compaction.js';

test('createProceduralCandidate stores a candidate row', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);

  const sessionId = `pc-create-${Date.now()}`;
  const compactionId = `comp-${Date.now()}`;

  try {
    await ensureMemoryCompactionStore();
    await getDb().query(
      `INSERT INTO memory_compactions (id, session_id, summary_json) VALUES ($1, $2, '{}'::jsonb)`,
      [compactionId, sessionId],
    );

    await ensureProceduralCandidateStore();
    const pc = await createProceduralCandidate({
      compactionId,
      name: 'test-candidate',
      content: 'test rule content',
      severity: 'warn',
      confidence: 0.8,
      status: 'draft',
      supportingSessionIds: [sessionId],
    });

    assert.equal(pc.name, 'test-candidate');
    assert.equal(pc.status, 'draft');
    assert.equal(pc.confidence, 0.8);

    const loaded = await loadProceduralCandidate(pc.id);
    assert.ok(loaded);
    assert.equal(loaded!.name, 'test-candidate');
  } finally {
    await getDb().query('DELETE FROM procedural_candidates WHERE compaction_id = $1', [compactionId]).catch(() => undefined);
    await getDb().query('DELETE FROM memory_compactions WHERE id = $1', [compactionId]).catch(() => undefined);
    await closeDb().catch(() => undefined);
  }
});

test('promoteCandidate transitions through lifecycle', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);

  const sessionId = `pc-promote-${Date.now()}`;
  const compactionId = `comp-${Date.now()}`;

  try {
    await ensureMemoryCompactionStore();
    await getDb().query(
      `INSERT INTO memory_compactions (id, session_id, summary_json) VALUES ($1, $2, '{}'::jsonb)`,
      [compactionId, sessionId],
    );

    const pc = await createProceduralCandidate({
      compactionId,
      name: 'promote-test',
      content: 'rule content',
      status: 'draft',
    });

    const approved = await promoteCandidate(pc.id, 'approved');
    assert.equal(approved!.status, 'approved');

    const act = await promoteCandidate(pc.id, 'active');
    assert.equal(act!.status, 'active');

    const retired = await promoteCandidate(pc.id, 'retired', 'no longer relevant');
    assert.equal(retired!.status, 'retired');
    assert.equal(retired!.rejectionReason, 'no longer relevant');
    assert.ok(retired!.rejectedAt);
  } finally {
    await getDb().query('DELETE FROM procedural_candidates WHERE compaction_id = $1', [compactionId]).catch(() => undefined);
    await getDb().query('DELETE FROM memory_compactions WHERE id = $1', [compactionId]).catch(() => undefined);
    await closeDb().catch(() => undefined);
  }
});

test('upsertProceduralCandidate updates existing record', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);

  const sessionId = `pc-upsert-${Date.now()}`;
  const compactionId = `comp-${Date.now()}`;

  try {
    await ensureMemoryCompactionStore();
    await getDb().query(
      `INSERT INTO memory_compactions (id, session_id, summary_json) VALUES ($1, $2, '{}'::jsonb)`,
      [compactionId, sessionId],
    );

    const first = await createProceduralCandidate({
      compactionId,
      name: 'upsert-test',
      content: 'original',
      confidence: 0.3,
    });
    assert.equal(first.confidence, 0.3);

    const updated = await upsertProceduralCandidate({
      id: first.id,
      compactionId,
      name: 'upsert-test',
      confidence: 0.9,
      content: 'updated',
    });
    assert.equal(updated.confidence, 0.9);
    assert.equal(updated.content, 'updated');
  } finally {
    await getDb().query('DELETE FROM procedural_candidates WHERE compaction_id = $1', [compactionId]).catch(() => undefined);
    await getDb().query('DELETE FROM memory_compactions WHERE id = $1', [compactionId]).catch(() => undefined);
    await closeDb().catch(() => undefined);
  }
});

test('listProceduralCandidates filters by status', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);

  const sessionId = `pc-list-${Date.now()}`;
  const compactionId = `comp-${Date.now()}`;

  try {
    await ensureMemoryCompactionStore();
    await getDb().query(
      `INSERT INTO memory_compactions (id, session_id, summary_json) VALUES ($1, $2, '{}'::jsonb)`,
      [compactionId, sessionId],
    );

    await createProceduralCandidate({ compactionId, name: 'draft-1', content: 'draft content', status: 'draft' });
    await createProceduralCandidate({ compactionId, name: 'review-1', content: 'review content', status: 'review' });
    await createProceduralCandidate({ compactionId, name: 'active-1', content: 'active content', status: 'active' });

    const active = await listProceduralCandidates({ status: 'active' });
    assert.equal(active.length, 1);
    assert.equal(active[0].name, 'active-1');

    const multipl = await listProceduralCandidates({ status: ['draft', 'review'] });
    assert.ok(multipl.length >= 2);
  } finally {
    await getDb().query('DELETE FROM procedural_candidates WHERE compaction_id = $1', [compactionId]).catch(() => undefined);
    await getDb().query('DELETE FROM memory_compactions WHERE id = $1', [compactionId]).catch(() => undefined);
    await closeDb().catch(() => undefined);
  }
});
