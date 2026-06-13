import test from 'node:test';
import assert from 'node:assert/strict';

import { getDb } from '@los/infra/db';
import {
  recordOperatorFollowup,
  recordOperatorSteering,
  recordSessionBranchCreated,
} from './operator-control.js';
import { listSessionEvents } from './session-events.js';

test('operator control helpers persist audit session events', async () => {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const sessionId = `session-operator-control-${suffix}`;

  try {
    const steering = await recordOperatorSteering({
      sessionId,
      runSpecId: `run-${suffix}`,
      taskRunId: `task-${suffix}`,
      tenantId: 'tenant-a',
      projectId: 'project-a',
      userId: 'user-a',
      requestId: `request-${suffix}`,
      traceId: `trace-${suffix}`,
      actor: 'operator-a',
      reason: 'scope correction',
      instruction: 'Do not edit generated files.',
      turnBoundary: 'immediate',
      drainMode: 'finish_current_tool',
    });
    const followup = await recordOperatorFollowup({
      sessionId,
      parentSessionId: `parent-${suffix}`,
      prompt: 'Continue with tests only.',
    });
    const branch = await recordSessionBranchCreated({
      sessionId,
      parentSessionId: `parent-${suffix}`,
      branchAtTurn: 2,
      copiedMessageCount: 5,
      parentMessageCount: 8,
      parentTurnCount: 3,
    });

    assert.equal(steering.type, 'operator.steering');
    assert.equal(steering.source, 'operator');
    assert.equal(steering.visibility, 'audit');
    assert.equal(steering.payload.instruction, 'Do not edit generated files.');
    assert.equal(steering.payload.turnBoundary, 'immediate');
    assert.equal(steering.payload.drainMode, 'finish_current_tool');
    assert.equal(steering.payload.actor, 'operator-a');
    assert.equal(steering.payload.runSpecId, `run-${suffix}`);
    assert.equal(followup.type, 'operator.followup');
    assert.equal(followup.payload.prompt, 'Continue with tests only.');
    assert.equal(followup.payload.parentSessionId, `parent-${suffix}`);
    assert.equal(branch.type, 'session.branch_created');
    assert.equal(branch.payload.parentSessionId, `parent-${suffix}`);
    assert.equal(branch.payload.branchAtTurn, 2);
    assert.equal(branch.payload.copiedMessageCount, 5);

    const events = await listSessionEvents(sessionId);
    assert.deepEqual(events.map((event) => event.type), [
      'operator.steering',
      'operator.followup',
      'session.branch_created',
    ]);
  } finally {
    await getDb().query('DELETE FROM session_events WHERE session_id = $1', [sessionId]).catch(() => undefined);
  }
});
