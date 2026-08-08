import test from 'node:test';
import assert from 'node:assert/strict';

import {
  _resolveMemorySearchScope,
  _sanitizePatchMetadata,
  _assertObservationOwnership,
} from './routes/data/memory-routes.js';
import {
  ownsObservationBoundary,
  canMutateObservation,
  resolveMemoryScope,
} from '@los/memory';

test('ordinary memory search cannot override request scope with query parameters', () => {
  const scope = _resolveMemorySearchScope({
    tenantId: 'tenant-authenticated',
    projectId: 'project-authenticated',
    userId: 'user-authenticated',
    isOperator: false,
  }, {
    tenantId: 'tenant-forged',
    projectId: 'project-forged',
    userId: 'user-forged',
  });

  assert.deepEqual(scope, {
    tenantId: 'tenant-authenticated',
    projectId: 'project-authenticated',
    userId: 'user-authenticated',
  });
});

test('validated operator memory search may select an explicit scope', () => {
  const scope = _resolveMemorySearchScope({
    tenantId: 'local',
    projectId: 'los',
    userId: 'operator',
    isOperator: true,
  }, {
    tenantId: 'tenant-target',
    projectId: 'project-target',
    userId: 'user-target',
  });

  assert.deepEqual(scope, {
    tenantId: 'tenant-target',
    projectId: 'project-target',
    userId: 'user-target',
  });
});

test('PATCH cannot elevate metadata.scope or forge compaction attestation', () => {
  const elevated = _sanitizePatchMetadata(
    { scope: 'session', memoryLayer: 'episodic' },
    { scope: 'global', memoryLayer: 'episodic' },
  );
  assert.equal(elevated.ok, false);
  if (!elevated.ok) {
    assert.match(elevated.reason, /promote/);
  }

  const forgedAttest = _sanitizePatchMetadata(
    { scope: 'session' },
    { compactionAttested: true },
  );
  assert.equal(forgedAttest.ok, false);

  const forgedPromotable = _sanitizePatchMetadata(
    { scope: 'session' },
    { promotable: true },
  );
  assert.equal(forgedPromotable.ok, false);

  const clearPoison = _sanitizePatchMetadata(
    { scope: 'session', poisonFlag: { pattern: 'instruction-override' } },
    { poisonFlag: null as unknown as undefined },
  );
  assert.equal(clearPoison.ok, false);

  const ok = _sanitizePatchMetadata(
    { scope: 'session', note: 'a' },
    { note: 'b', scope: 'session' },
  );
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.equal(ok.metadata.note, 'b');
    assert.equal(ok.metadata.scope, 'session');
  }
});

test('ownership helper denies cross-project mutate even when scope rank would allow delete', () => {
  // Mirrors the HTTP gate used by PATCH/DELETE: tenant/project first.
  assert.equal(ownsObservationBoundary(
    { tenantId: 't1', projectId: 'mine', isOperator: false },
    { tenantId: 't1', projectId: 'other' },
  ), false);

  assert.equal(canMutateObservation({
    requester: {
      tenantId: 't1',
      projectId: 'mine',
      requesterScope: 'project',
      isOperator: false,
    },
    observation: {
      tenantId: 't1',
      projectId: 'other',
      scope: 'session',
      sessionId: 's-other',
    },
    action: 'delete',
  }), false);
});

test('_assertObservationOwnership returns 403 for foreign project rows', () => {
  const deps = {
    ownsObservationBoundary,
    resolveMemoryScope,
    canMutateObservation,
  };
  const req = {
    headers: {},
    requestContext: {
      requestId: 'req-test',
      traceId: 'tr-test',
      tenantId: 't1',
      projectId: 'mine',
      userId: 'u1',
      isOperator: false,
      isAuthenticated: true,
      log: { child: () => ({}) } as never,
    },
  };

  const denied = _assertObservationOwnership(
    deps,
    req as never,
    {
      tenantId: 't1',
      projectId: 'other',
      sessionId: 's-other',
      userId: 'u2',
      metadata: { scope: 'session' },
    },
    'write',
  );
  assert.equal(denied.ok, false);
  if (!denied.ok) {
    assert.equal(denied.status, 403);
  }

  const allowed = _assertObservationOwnership(
    deps,
    req as never,
    {
      tenantId: 't1',
      projectId: 'mine',
      sessionId: 's1',
      userId: 'u1',
      metadata: { scope: 'session' },
    },
    'write',
    { callerSessionId: 's1' },
  );
  assert.equal(allowed.ok, true);
});
