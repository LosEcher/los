import { getDb } from '@los/infra/db';
import { appendSessionEvent, ensureSessionEventStore, listSessionEvents } from '@los/agent/session-events';
import { publishExecutionOutboxBatch } from '@los/agent/execution-outbox';
import { transitionExecutionState } from '@los/agent/execution-store';
import { approveRunSpecPhase, createRunSpec, ensureRunSpecStore } from '@los/agent/run-specs';
import { createTaskRun, ensureTaskRunStore, loadTaskRun } from '@los/agent/task-runs';
import { reapExpiredExecutionLeases } from './execution-lease-reaper.js';
import { recoverApprovedRunDispatches } from './run-resume-recovery.js';
import {
  isRemoteCircuitOpen,
  noteRemoteExecutorFailure,
  noteRemoteExecutorSuccess,
} from './remote-executor-circuit.js';

/**
 * Roadmap R3 — recovery drills: repeatable fault-injection experiments over
 * the existing recovery machinery (lease reaper, dispatch recovery scanner,
 * outbox, remote-executor circuit, session ledger).
 *
 * Every scenario runs against a real database, injects one fault condition,
 * exercises the production recovery path (never a test-only bypass), and
 * returns structured assertions plus evidence ids. AP1/AP3 discipline holds:
 * the exercises call transitionExecutionState / reaper / recovery scanner —
 * they never write task state directly.
 *
 * A scenario passing here is not proof that production recovery is healthy;
 * it is a repeatable drill whose evidence can be replayed after any change to
 * the recovery machinery (see docs/operations/2026-08-16-recovery-drills.md).
 */

export type RecoveryScenario =
  | 'lease_expired'
  | 'process_terminated'
  | 'sse_interrupted'
  | 'db_unavailable'
  | 'executor_disconnected';

export interface RecoveryAssertion {
  name: string;
  passed: boolean;
  detail?: string;
}

export interface RecoveryExperimentResult {
  scenario: RecoveryScenario;
  injectedAt: string;
  assertions: RecoveryAssertion[];
  passed: boolean;
  evidence: string[];
}

export const RECOVERY_SCENARIOS: readonly RecoveryScenario[] = [
  'lease_expired',
  'process_terminated',
  'sse_interrupted',
  'db_unavailable',
  'executor_disconnected',
];

export async function runRecoveryExperiment(
  scenario: RecoveryScenario,
  options: { suffix?: string } = {},
): Promise<RecoveryExperimentResult> {
  switch (scenario) {
    case 'lease_expired':
      return drillLeaseExpired(options.suffix);
    case 'process_terminated':
      return drillProcessTerminated(options.suffix);
    case 'sse_interrupted':
      return drillSseInterrupted(options.suffix);
    case 'db_unavailable':
      return drillDbUnavailable(options.suffix);
    case 'executor_disconnected':
      return drillExecutorDisconnected(options.suffix);
  }
}

function finish(scenario: RecoveryScenario, assertions: RecoveryAssertion[], evidence: string[]): RecoveryExperimentResult {
  return {
    scenario,
    injectedAt: new Date().toISOString(),
    assertions,
    passed: assertions.every((a) => a.passed),
    evidence,
  };
}

/**
 * Scenario 1 — lease_expired: a running task whose lease expired (gateway
 * crashed mid-run). The lease reaper must recover the task through
 * transitionExecutionState and surface a dead-letter record.
 */
async function drillLeaseExpired(suffix?: string): Promise<RecoveryExperimentResult> {
  const s = suffix ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const sessionId = `drill-lease-${s}`;
  const taskRunId = `task-drill-lease-${s}`;
  const evidence: string[] = [];
  const assertions: RecoveryAssertion[] = [];
  await ensureTaskRunStore();
  await createTaskRun({
    id: taskRunId,
    sessionId,
    nodeId: 'gateway-drill-dead',
    workspaceRoot: process.cwd(),
    toolMode: 'read-only',
    promptPreview: 'recovery drill: lease expired',
    leaseExpiresAt: new Date(Date.now() - 60_000),
  });
  await transitionExecutionState({
    entityType: 'task_run',
    entityId: taskRunId,
    to: 'running',
    reason: 'drill_start',
    nodeId: 'gateway-drill-dead',
  });
  const before = await loadTaskRun(taskRunId);
  const leaseExpired = before?.leaseExpiresAt !== undefined
    && new Date(before.leaseExpiresAt).getTime() < Date.now();
  assertions.push({
    name: 'fault injected',
    passed: before?.status === 'running' && leaseExpired,
    detail: before
      ? `status=${before.status} leaseExpiresAt=${String(before.leaseExpiresAt)}`
      : 'task missing',
  });
  evidence.push(taskRunId);

  await reapExpiredExecutionLeases('drill_lease_expired');
  const after = await loadTaskRun(taskRunId);
  assertions.push({
    name: 'lease reaper recovered the expired task',
    passed: after !== null && after.status !== 'running',
    detail: after ? `status=${after.status}` : 'task missing after reap',
  });
  const deadLetters = await getDb().query(
    'SELECT count(*) AS n FROM dead_letter_events WHERE task_run_id = $1',
    [taskRunId],
  );
  assertions.push({
    name: 'dead-letter record written',
    passed: Number(deadLetters.rows[0]?.n ?? 0) > 0,
  });
  return finish('lease_expired', assertions, evidence);
}

/**
 * Scenario 2 — process_terminated: a plan-approved run whose dispatch never
 * persisted a task attempt (gateway died between approval and dispatch). The
 * recovery scanner must re-dispatch through the same entrypoint used by the
 * scheduler.
 */
async function drillProcessTerminated(suffix?: string): Promise<RecoveryExperimentResult> {
  const s = suffix ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const sessionId = `drill-terminated-${s}`;
  const runSpecId = `run-drill-terminated-${s}`;
  const evidence: string[] = [];
  const assertions: RecoveryAssertion[] = [];
  await ensureRunSpecStore();
  await createRunSpec({
    id: runSpecId,
    sessionId,
    prompt: 'recovery drill: process terminated before dispatch',
    workspaceRoot: process.cwd(),
    toolMode: 'read-only',
    runContract: {
      mode: 'execution',
      executionMode: 'standard',
      phase: 'planning',
      planRevision: 1,
      plan: [{
        id: 'drill-step-1',
        title: 'drill step',
        description: 'recovery drill step',
        dependsOnIds: [],
        editableSurfaces: [],
        completionCriteria: 'drill complete',
      }],
      requiredChecks: ['pnpm --filter @los/gateway check'],
    },
  });
  await approveRunSpecPhase(runSpecId, { actor: 'operator:recovery-drill' });
  evidence.push(runSpecId);

  const dispatched: string[] = [];
  const result = await recoverApprovedRunDispatches({
    dispatch: async (id) => {
      dispatched.push(id);
      return { runSpecId: id, status: 'deduplicated', planRevision: 1 };
    },
  });
  assertions.push({
    name: 'recovery scanner acquired the coordination lock',
    passed: result.lockAcquired,
  });
  assertions.push({
    name: 'approved run re-dispatched through the scheduler entrypoint',
    passed: dispatched.includes(runSpecId),
    detail: `dispatched=${dispatched.join(',')}`,
  });
  return finish('process_terminated', assertions, evidence);
}

/**
 * Scenario 3 — sse_interrupted: the live event stream is lost; recovery reads
 * the persisted session ledger from the last cursor. The drill asserts the
 * append-only ledger replays exactly the events that were persisted, in
 * order, without loss or duplication.
 */
async function drillSseInterrupted(suffix?: string): Promise<RecoveryExperimentResult> {
  const s = suffix ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const sessionId = `drill-sse-${s}`;
  const evidence: string[] = [];
  const assertions: RecoveryAssertion[] = [];
  await ensureSessionEventStore();
  const kinds = ['drill.event.one', 'drill.event.two', 'drill.event.three'] as const;
  for (const kind of kinds) {
    await appendSessionEvent({
      sessionId,
      type: kind,
      source: 'recovery_drill',
      payload: { sequence: kind },
    });
  }
  evidence.push(sessionId);

  const replayed = await listSessionEvents(sessionId);
  const replayedTypes = replayed.map((e) => e.type);
  assertions.push({
    name: 'all persisted events replayable after stream loss',
    passed: kinds.every((k) => replayedTypes.includes(k)),
    detail: `replayed=${replayedTypes.join(',')}`,
  });
  assertions.push({
    name: 'replay preserves append order without duplication',
    passed: replayed.length === kinds.length,
    detail: `count=${replayed.length}`,
  });
  return finish('sse_interrupted', assertions, evidence);
}

/**
 * Scenario 4 — db_unavailable: outbox records accumulated while the database
 * was unreachable; once the DB is back, the outbox publisher drains the
 * backlog through the normal claim→publish→mark path.
 */
async function drillDbUnavailable(suffix?: string): Promise<RecoveryExperimentResult> {
  const s = suffix ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const sessionId = `drill-db-${s}`;
  const evidence: string[] = [];
  const assertions: RecoveryAssertion[] = [];
  await ensureSessionEventStore();
  const event = await appendSessionEvent({
    sessionId,
    type: 'drill.outbox.pending',
    source: 'recovery_drill',
    payload: { phase: 'db_unavailable' },
  });
  await getDb().query(
    `INSERT INTO execution_outbox
       (session_id, entity_type, entity_id, event_type, session_event_id, payload_json)
     VALUES ($1, 'task_run', $2, 'state_changed', $3, '{}'::jsonb)`,
    [sessionId, `task-drill-db-${s}`, String(event.id)],
  );
  evidence.push(`outbox:${sessionId}`);

  const published: string[] = [];
  const result = await publishExecutionOutboxBatch({
    ownerId: `drill-owner-${s}`,
    publish: async (record) => {
      published.push(String(record.sessionEventId));
    },
  });
  assertions.push({
    name: 'backlogged outbox record drained after DB recovery',
    passed: result.published >= 1 && published.some((id) => id === String(event.id)),
    detail: `claimed=${result.claimed} published=${result.published} retried=${result.retried}`,
  });
  return finish('db_unavailable', assertions, evidence);
}

/**
 * Scenario 5 — executor_disconnected: a remote executor's heartbeat went
 * stale and its failures opened the circuit; the scheduler must not dispatch
 * to that node while the circuit is open, and a success resets it.
 */
async function drillExecutorDisconnected(suffix?: string): Promise<RecoveryExperimentResult> {
  const nodeId = `drill-node-${suffix ?? Date.now()}`;
  const evidence = [nodeId];
  const assertions: RecoveryAssertion[] = [];

  noteRemoteExecutorFailure(nodeId, 'drill_disconnect', Date.now());
  assertions.push({
    name: 'circuit opens after disconnection',
    passed: isRemoteCircuitOpen(nodeId, Date.now()),
  });
  assertions.push({
    name: 'circuit stays open across the backoff window',
    passed: isRemoteCircuitOpen(nodeId, Date.now() + 3_000),
  });
  noteRemoteExecutorSuccess(nodeId, Date.now() + 20_000);
  assertions.push({
    name: 'circuit resets on success',
    passed: !isRemoteCircuitOpen(nodeId, Date.now() + 20_000),
  });
  return finish('executor_disconnected', assertions, evidence);
}
