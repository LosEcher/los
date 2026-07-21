import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import { createRunSpec, loadRunSpec } from '@los/agent/run-specs';
import { createTaskRun, loadTaskRun } from '@los/agent/task-runs';
import { appendSessionEvent } from '@los/agent/session-events';
import { saveSession } from '@los/agent/session';
import { transitionExecutionState } from '@los/agent/execution-store';
import { upsertServiceInstance } from '@los/agent/service-instances';
import { getDb } from '@los/infra/db';
import { reclaimOrphanedRuns } from './chat-session-helpers.js';

test('active session failover reclaims a long task after its owner process is killed', async () => {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const sessionId = `session-active-failover-${suffix}`;
  const runSpecId = `run-active-failover-${suffix}`;
  const taskRunId = `task-active-failover-${suffix}`;
  const oldGateway = `gateway-active-failover-old-${suffix}`;
  const newGateway = `gateway-active-failover-new-${suffix}`;
  const ownerProcess = spawn(process.execPath, [
    '-e',
    "process.send?.('ready'); setInterval(() => {}, 1_000);",
  ], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  await once(ownerProcess, 'message');

  await saveSession({
    id: sessionId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    messages: [{ role: 'user', content: 'continue this long session after failover' }],
    turns: [],
    metadata: { test: 'active-session-failover' },
  });
  await upsertServiceInstance({
    serviceId: oldGateway,
    serviceKind: 'gateway',
    status: 'online',
    role: 'active',
    lastProbeAt: new Date(Date.now() - 120_000).toISOString(),
    capabilities: { processId: ownerProcess.pid },
  });
  await createRunSpec({
    id: runSpecId,
    sessionId,
    prompt: 'continue this long session after failover',
    workspaceRoot: process.cwd(),
    toolMode: 'project-write',
    gatewayId: oldGateway,
  });
  await transitionExecutionState({ entityType: 'run_spec', entityId: runSpecId, to: 'running', sessionId, reason: 'test_long_session_start' });
  await createTaskRun({
    id: taskRunId,
    sessionId,
    runSpecId,
    nodeId: oldGateway,
    workspaceRoot: process.cwd(),
    toolMode: 'project-write',
    promptPreview: 'long provider stream',
    leaseVersion: 7,
    leaseExpiresAt: new Date(Date.now() + 60_000),
  });
  await transitionExecutionState({
    entityType: 'task_run', entityId: taskRunId, to: 'running', sessionId,
    reason: 'test_provider_stream_started', nodeId: oldGateway, leaseVersion: 7,
  });
  await appendSessionEvent({ sessionId, type: 'model.delta', source: 'provider', payload: { text: 'partial answer' } });

  try {
    ownerProcess.kill('SIGKILL');
    const [exitCode, signal] = await once(ownerProcess, 'exit');
    assert.equal(exitCode, null);
    assert.equal(signal, 'SIGKILL');
    await getDb().query(
      'UPDATE service_instances SET last_heartbeat_at = now() - interval \'2 minutes\' WHERE service_id = $1',
      [oldGateway],
    );

    const result = await reclaimOrphanedRuns(newGateway);
    assert.deepEqual(result.claimedRunSpecIds, [runSpecId]);
    assert.deepEqual(result.errors, []);
    assert.equal((await loadRunSpec(runSpecId))?.gatewayId, newGateway);
    assert.equal((await loadRunSpec(runSpecId))?.status, 'failed');
    assert.equal((await loadTaskRun(taskRunId))?.status, 'failed');
    assert.equal((await loadTaskRun(taskRunId))?.metadata.recoveryReason, 'gateway_failover_takeover');

    await assert.rejects(
      transitionExecutionState({
        entityType: 'task_run', entityId: taskRunId, to: 'succeeded', sessionId,
        reason: 'stale_gateway_completion', nodeId: oldGateway, leaseVersion: 7,
      }),
      /terminal_state:task_run:failed/,
    );

    const replay = await getDb().query<{ type: string }>(
      'SELECT type FROM session_events WHERE session_id = $1 ORDER BY id', [sessionId],
    );
    assert.ok(replay.rows.some(row => row.type === 'model.delta'));
    assert.ok(replay.rows.some(row => row.type === 'task_run.failed'));
  } finally {
    if (ownerProcess.exitCode === null && ownerProcess.signalCode === null) ownerProcess.kill('SIGKILL');
    await getDb().query('DELETE FROM execution_outbox WHERE session_id = $1', [sessionId]).catch(() => undefined);
    await getDb().query('DELETE FROM session_events WHERE session_id = $1', [sessionId]).catch(() => undefined);
    await getDb().query('DELETE FROM task_runs WHERE id = $1', [taskRunId]).catch(() => undefined);
    await getDb().query('DELETE FROM run_specs WHERE id = $1', [runSpecId]).catch(() => undefined);
    await getDb().query('DELETE FROM sessions WHERE id = $1', [sessionId]).catch(() => undefined);
    await getDb().query('DELETE FROM service_instances WHERE service_id IN ($1, $2)', [oldGateway, newGateway]).catch(() => undefined);
  }
});
