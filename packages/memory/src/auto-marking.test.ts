import test from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig } from '@los/infra/config';
import { closeDb, getDb, initDb } from '@los/infra/db';
import { ensureMemoryStore, addObservation, type Observation } from './core/store.js';
import { archiveStaleObservations, AUTO_MARK_SCORE } from './core/auto-marking.js';

function hoursAgo(h: number): Date { return new Date(Date.now() - h * 3_600_000); }

async function seedObservation(overrides: Partial<Observation> = {}): Promise<Observation> {
  return addObservation({
    title: 'seed',
    kind: 'note',
    sessionId: 'auto-mark-test',
    content: 'seed content',
    tags: [],
    metadata: {},
    source: 'test',
    ...overrides,
  });
}

test('auto-marking archives only stale unreferenced plain observations', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  const sessionId = `auto-mark-${Date.now()}`;
  try {
    await ensureMemoryStore();

    // 1. Very old, unreferenced note -> qualifies (score < 0.2).
    const stale = await seedObservation({ sessionId, kind: 'note' });
    await getDb().query(
      `UPDATE observations SET created_at = $2 WHERE id = $1`,
      [stale.id, hoursAgo(120)],
    );

    // 2. Fresh note -> kept.
    await seedObservation({ sessionId, kind: 'note' });

    // 3. Old but referenced -> kept.
    const referenced = await seedObservation({ sessionId, kind: 'note' });
    await getDb().query(
      `UPDATE observations SET created_at = $2, metadata_json = jsonb_set(metadata_json, '{referenceCount}', '2') WHERE id = $1`,
      [referenced.id, hoursAgo(120)],
    );

    // 4. Old, in-flight tool call -> kept.
    const running = await seedObservation({ sessionId, kind: 'note' });
    await getDb().query(
      `UPDATE observations SET created_at = $2, metadata_json = jsonb_set(metadata_json, '{toolStatus}', '"running"') WHERE id = $1`,
      [running.id, hoursAgo(120)],
    );

    // 5. Old failure observation -> kept (protected kind).
    const failed = await seedObservation({ sessionId, kind: 'failed' });
    await getDb().query(
      `UPDATE observations SET created_at = $2 WHERE id = $1`,
      [failed.id, hoursAgo(120)],
    );

    // 6. Old note with task association -> kept.
    const taskLinked = await seedObservation({ sessionId, kind: 'note' });
    await getDb().query(
      `UPDATE observations SET created_at = $2, metadata_json = jsonb_set(metadata_json, '{taskRunId}', '"task-1"') WHERE id = $1`,
      [taskLinked.id, hoursAgo(120)],
    );

    const result = await archiveStaleObservations(sessionId);
    assert.equal(result.archivedCount, 1, 'only the stale unreferenced note is archived');
    assert.equal(result.skippedCount, 5);
    assert.equal(result.candidates.length, 1);
    assert.ok(result.candidates[0]!.score < AUTO_MARK_SCORE);

    const archived = await getDb().query<{ archived: string | null; reason: string | null }>(
      `SELECT metadata_json->>'archived' AS archived, metadata_json->>'archivedReason' AS reason
       FROM observations WHERE id = $1`,
      [stale.id],
    );
    assert.equal(archived.rows[0]!.archived, 'true');
    assert.equal(archived.rows[0]!.reason, 'auto-decay');

    // Idempotent: second run archives nothing new.
    const second = await archiveStaleObservations(sessionId);
    assert.equal(second.archivedCount, 0);
  } finally {
    await getDb().query('DELETE FROM observations WHERE session_id = $1', [sessionId]).catch(() => undefined);
    await closeDb().catch(() => undefined);
  }
});
