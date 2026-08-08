/**
 * getLatestCheckpoint — tenant/project scoped lookup guard.
 *
 * Regression: the gateway checkpoint route used to read by sessionId only,
 * letting any authenticated user fetch another tenant/project's compaction
 * summary. The lookup must enforce the caller's access context.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from '@los/infra/db';
import { ensureMemoryCompactionStore } from './core/compaction.js';
import { getLatestCheckpoint } from './core/checkpoint.js';

const suffix = () => `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;

async function insertCheckpoint(opts: {
  sessionId: string;
  tenantId?: string | null;
  projectId?: string | null;
  createdAt?: string;
}): Promise<string> {
  await ensureMemoryCompactionStore();
  const id = `chkpt-test-${suffix()}`;
  await getDb().query(
    `INSERT INTO memory_compactions (id, session_id, tenant_id, project_id, summary_json, created_at)
     VALUES ($1, $2, $3, $4, '{}'::jsonb, COALESCE($5::timestamptz, now()))`,
    [id, opts.sessionId, opts.tenantId ?? null, opts.projectId ?? null, opts.createdAt ?? null],
  );
  return id;
}

test('getLatestCheckpoint filters by tenant/project access context', async () => {
  await ensureMemoryCompactionStore();
  const sessionId = `chkpt-session-${suffix()}`;
  const mine = await insertCheckpoint({
    sessionId, tenantId: 't1', projectId: 'p1', createdAt: '2026-08-08T10:00:00Z',
  });
  const newerForeign = await insertCheckpoint({
    sessionId, tenantId: 't2', projectId: 'p2', createdAt: '2026-08-08T11:00:00Z',
  });
  try {
    // Fail-closed: omitting the access context hides attributed rows entirely.
    const noContext = await getLatestCheckpoint(sessionId);
    assert.equal(noContext, null, 'missing access context must not read attributed rows');

    // Explicit context with no scope values keeps the unrestricted behavior
    // (internal operator-style callers).
    const any = await getLatestCheckpoint(sessionId, {});
    assert.ok(any);
    assert.equal(any!.id, newerForeign);

    // Scoped to t1/p1: the newer foreign row is invisible.
    const scoped = await getLatestCheckpoint(sessionId, { tenantId: 't1', projectId: 'p1' });
    assert.ok(scoped);
    assert.equal(scoped!.id, mine);

    // Scoped to a tenant with no rows: null, never a foreign row.
    const foreign = await getLatestCheckpoint(sessionId, { tenantId: 't3', projectId: 'p3' });
    assert.equal(foreign, null);
  } finally {
    await getDb().query('DELETE FROM memory_compactions WHERE id IN ($1, $2)', [mine, newerForeign]);
  }
});

test('getLatestCheckpoint keeps legacy NULL-owned rows visible under any scope', async () => {
  await ensureMemoryCompactionStore();
  const sessionId = `chkpt-legacy-${suffix()}`;
  const legacy = await insertCheckpoint({ sessionId }); // NULL ownership
  try {
    const scoped = await getLatestCheckpoint(sessionId, { tenantId: 't9', projectId: 'p9' });
    assert.ok(scoped, 'NULL-owned legacy rows remain visible (listCompactions parity)');
    assert.equal(scoped!.id, legacy);
    // Fail-closed mode still surfaces NULL-owned rows.
    const noContext = await getLatestCheckpoint(sessionId);
    assert.equal(noContext?.id, legacy);
  } finally {
    await getDb().query('DELETE FROM memory_compactions WHERE id = $1', [legacy]);
  }
});
