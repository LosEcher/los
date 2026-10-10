/**
 * @los/agent/session — DB-backed integration tests.
 *
 * `session.test.ts` covers the pure normalization helpers; the functions that
 * need PostgreSQL (saveSession / loadSession / listSessions / deleteSession)
 * live here, which is what that file's header already points to.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { closeDb, initDb } from '@los/infra/db';
import { loadConfig } from '@los/infra/config';

import { ensureSessionStore, listSessions, saveSession } from './session.js';

test('scoped session listing isolates tenants and leaves the unscoped view unchanged', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  const stamp = Date.now();
  const tenantA = `scope-a-${stamp}`;
  const tenantB = `scope-b-${stamp}`;
  const makeSession = (suffix: string, tenantId?: string) =>
    saveSession({
      id: `session-scope-${stamp}-${suffix}`,
      tenantId,
      projectId: `project-scope-${stamp}`,
      userId: 'user-scope',
      nodeId: 'node-scope',
      requestId: `req-scope-${stamp}-${suffix}`,
      traceId: `trace-scope-${stamp}-${suffix}`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages: [],
      turns: [],
      metadata: {},
    });

  try {
    await ensureSessionStore();
    const inA = await makeSession('a', tenantA);
    void inA;
    await makeSession('b', tenantB);
    await makeSession('legacy');

    const idA = `session-scope-${stamp}-a`;
    const idB = `session-scope-${stamp}-b`;
    const idLegacy = `session-scope-${stamp}-legacy`;

    const scopedA = await listSessions(5000, { tenantId: tenantA });
    const idsA = scopedA.map(session => session.id);
    assert.ok(idsA.includes(idA));
    assert.ok(!idsA.includes(idB), 'another tenant session must not leak into the scoped projection');
    assert.ok(
      !idsA.includes(idLegacy),
      'a NULL-tenant legacy session is fail-closed for a scoped (non-operator) reader',
    );

    const scopedB = await listSessions(5000, { tenantId: tenantB });
    assert.ok(scopedB.some(session => session.id === idB));
    assert.ok(!scopedB.some(session => session.id === idA));

    const unscoped = await listSessions(5000);
    const allIds = new Set(unscoped.map(session => session.id));
    assert.ok(
      allIds.has(idA) && allIds.has(idB) && allIds.has(idLegacy),
      'the unscoped projection (operator / local mode) must stay unchanged',
    );
  } finally {
    await closeDb().catch(() => undefined);
  }
});
