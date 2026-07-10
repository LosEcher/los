import test from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig } from '@los/infra/config';
import { closeDb, getDb, initDb } from '@los/infra/db';
import { ensureSessionEventStore } from '@los/agent/session-events';
import { persistChatIntakeEvent } from './chat-intake-events.js';

test.before(async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  await ensureSessionEventStore();
});

test.after(async () => {
  await closeDb().catch(() => undefined);
});

test('persists blocked and resolved intake decisions as audit events', async () => {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const blockedSessionId = `session-intake-blocked-${suffix}`;
  const resolvedSessionId = `session-intake-resolved-${suffix}`;

  try {
    const blocked = await persistChatIntakeEvent({
      sessionId: blockedSessionId,
      tenantId: 'local',
      userId: 'local-user',
      requestId: `request-blocked-${suffix}`,
      traceId: `trace-blocked-${suffix}`,
      requestedProjectId: 'missing',
      resolution: {
        status: 'blocked',
        reason: 'unknown_explicit_project',
        blocker: 'Project is not bound: missing',
      },
    });
    assert.equal(blocked.type, 'coordinator.intake_blocked');
    assert.equal(blocked.visibility, 'audit');
    assert.equal(blocked.projectId, undefined);
    assert.deepEqual(blocked.payload, {
      requestedProjectId: 'missing',
      requestedWorkspaceRoot: null,
      ownerRepo: null,
      workspaceRoot: null,
      reason: 'unknown_explicit_project',
      blocker: 'Project is not bound: missing',
      runSpecId: null,
    });

    const resolved = await persistChatIntakeEvent({
      sessionId: resolvedSessionId,
      tenantId: 'local',
      userId: 'local-user',
      requestId: `request-resolved-${suffix}`,
      traceId: `trace-resolved-${suffix}`,
      requestedWorkspaceRoot: '/workspace/los',
      runSpecId: `run-intake-${suffix}`,
      resolution: {
        status: 'resolved',
        ownerRepo: 'los',
        workspaceRoot: '/workspace/los',
        reason: 'workspace_binding',
      },
    });
    assert.equal(resolved.type, 'coordinator.intake_resolved');
    assert.equal(resolved.visibility, 'audit');
    assert.equal(resolved.projectId, 'los');
    assert.equal(resolved.payload.runSpecId, `run-intake-${suffix}`);
  } finally {
    await getDb().query(
      'DELETE FROM session_events WHERE session_id = ANY($1::text[])',
      [[blockedSessionId, resolvedSessionId]],
    ).catch(() => undefined);
  }
});
