import test from 'node:test';
import assert from 'node:assert/strict';

import { getDb } from '@los/infra/db';
import { ensureMemoryStore, upsertObservation } from './index.js';

test('concurrent observation upserts keep one row per scope and dedupe key', async () => {
  await ensureMemoryStore();
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const tenantId = `tenant-${suffix}`;
  const projectId = `project-${suffix}`;
  const userId = `user-${suffix}`;
  const dedupeKey = `concurrent:${suffix}`;

  try {
    const writes = await Promise.all(Array.from({ length: 16 }, (_, index) => (
      upsertObservation({
        title: `Concurrent observation ${index}`,
        summary: `attempt-${index}`,
        tags: [`tag-${index}`],
        content: `content-${index}`,
        tenantId,
        projectId,
        userId,
        dedupeKey,
      })
    )));

    assert.equal(new Set(writes.map(row => row.id)).size, 1);
    const rows = await getDb().query<{ id: string; tags_json: string[] }>(
      `SELECT id, tags_json
       FROM observations
       WHERE tenant_id = $1 AND project_id = $2 AND user_id = $3 AND dedupe_key = $4`,
      [tenantId, projectId, userId, dedupeKey],
    );
    assert.equal(rows.rows.length, 1);
    assert.equal(rows.rows[0]?.tags_json.length, 16);

    const otherScope = await upsertObservation({
      title: 'Same key, separate project',
      tenantId,
      projectId: `${projectId}-other`,
      userId,
      dedupeKey,
    });
    assert.notEqual(otherScope.id, writes[0]?.id);
  } finally {
    await getDb().query(
      'DELETE FROM observations WHERE tenant_id = $1 AND dedupe_key = $2',
      [tenantId, dedupeKey],
    );
  }
});
