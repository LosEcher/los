import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig } from '@los/infra/config';
import { closeDb, getDb, initDb } from '@los/infra/db';
import { createK4ExecutionKernelSelection, getLosKernelSelectionIdentity } from './execution-kernel-selection.js';
import {
  approveExecutionExperiment,
  createExecutionExperiment,
  setExecutionExperimentCandidate,
} from './execution-experiments.js';
import {
  assertPersistedRunSpecKernelSelection,
  authorizeRunSpecKernelCanary,
  rollbackRunSpecExecutionKernel,
} from './run-spec-kernel-selection.js';
import { createRunSpec, loadRunSpec } from './run-specs.js';
import { listSessionEvents } from './session-events.js';

test('run-spec kernel authorization and rollback persist atomically without creating an attempt', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const runSpecId = `run-k4-selection-${suffix}`;
  const sessionId = `session-k4-selection-${suffix}`;
  const experimentId = `experiment-k4-selection-${suffix}`;
  try {
    await createRunSpec({
      id: runSpecId,
      sessionId,
      tenantId: 'tenant-test',
      projectId: 'project-test',
      prompt: 'inspect without writes',
      workspaceRoot: process.cwd(),
      toolMode: 'read-only',
      allowedTools: ['read_file'],
      runContract: {
        mode: 'audit',
        executionMode: 'standard',
        editableSurfaces: [],
        requiredChecks: [],
        allowedSkippedChecks: [],
        stopConditions: ['stop on canonical transcript drift'],
        evidenceRequired: ['canonical kernel events'],
        externalEvidenceAllowed: [],
        rawEvidenceProhibited: [],
        phase: 'plan_approved',
        plan: [{
          id: 'inspect',
          title: 'Inspect candidate',
          description: 'Inspect the bounded workspace without writes.',
          dependsOnIds: [],
          editableSurfaces: [],
          completionCriteria: 'Canonical evidence is persisted.',
        }],
        planRevision: 1,
        executionKernel: createK4ExecutionKernelSelection({
          experimentId,
          disposition: 'inspection',
          actor: 'operator:select',
        }),
      },
    });
    await createExecutionExperiment({
      id: experimentId,
      tenantId: 'tenant-test',
      projectId: 'project-test',
      source: {
        sessionId,
        runSpecId: `source-${suffix}`,
        eventCursor: 0,
        evidenceHash: 'sha256:k4-selection',
      },
      configDiff: [{ path: 'executionKernel', value: { kind: 'pi', version: '0.81.1+los.3', protocolVersion: '0.1.0', disposition: 'inspection' } }],
      createdBy: 'operator:create',
    });
    await setExecutionExperimentCandidate(experimentId, runSpecId, { tenantId: 'tenant-test', projectId: 'project-test' });
    await approveExecutionExperiment(experimentId, 'operator:approve', { tenantId: 'tenant-test', projectId: 'project-test' });

    const authorized = await authorizeRunSpecKernelCanary({
      runSpecId,
      experimentId,
      actor: 'operator:authorize',
    });
    assert.equal(authorized.canaryAuthorization.status, 'granted');
    await assertPersistedRunSpecKernelSelection({
      runSpecId,
      selection: authorized,
      tenantId: 'tenant-test',
      projectId: 'project-test',
    });

    const rolledBack = await rollbackRunSpecExecutionKernel({
      runSpecId,
      experimentId,
      actor: 'operator:rollback',
      reason: 'operator requested baseline',
    });
    assert.deepEqual(rolledBack.selected, getLosKernelSelectionIdentity());
    assert.equal(rolledBack.canaryAuthorization.status, 'not_granted');
    await assertPersistedRunSpecKernelSelection({
      runSpecId,
      selection: rolledBack,
      tenantId: 'tenant-test',
      projectId: 'project-test',
    });

    const persisted = await loadRunSpec(runSpecId);
    assert.deepEqual(persisted?.runContract?.executionKernel, rolledBack);
    const events = await listSessionEvents(sessionId);
    assert.deepEqual(events.map(event => event.type).filter(type => type.startsWith('run.kernel_')), [
      'run.kernel_canary_authorized', 'run.kernel_rollback_applied',
    ]);
    const attempts = await getDb().query<{ count: string }>('SELECT count(*)::text AS count FROM task_runs WHERE run_spec_id = $1', [runSpecId]);
    assert.equal(attempts.rows[0]?.count, '0');
    const outbox = await getDb().query<{ event_type: string }>(
      'SELECT event_type FROM execution_outbox WHERE run_spec_id = $1 ORDER BY id',
      [runSpecId],
    );
    assert.deepEqual(outbox.rows.map(row => row.event_type), [
      'run.kernel_canary_authorized',
      'run.kernel_rollback_applied',
    ]);
  } finally {
    await getDb().query('DELETE FROM execution_outbox WHERE run_spec_id = $1', [runSpecId]).catch(() => undefined);
    await getDb().query('DELETE FROM session_events WHERE session_id = $1', [sessionId]).catch(() => undefined);
    await getDb().query('DELETE FROM verification_records WHERE run_spec_id = $1', [runSpecId]).catch(() => undefined);
    await getDb().query('DELETE FROM execution_experiments WHERE id = $1', [experimentId]).catch(() => undefined);
    await getDb().query('DELETE FROM run_specs WHERE id = $1', [runSpecId]).catch(() => undefined);
    await closeDb().catch(() => undefined);
  }
});

test('K4 kernel assertion accepts a running experiment (execute endpoint order)', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const runSpecId = `run-k4-running-${suffix}`;
  const sessionId = `session-k4-running-${suffix}`;
  const experimentId = `experiment-k4-running-${suffix}`;
  try {
    await createRunSpec({
      id: runSpecId,
      sessionId,
      tenantId: 'tenant-test',
      projectId: 'project-test',
      prompt: 'inspect without writes',
      workspaceRoot: process.cwd(),
      toolMode: 'read-only',
      allowedTools: ['read_file'],
      runContract: {
        mode: 'audit',
        executionMode: 'standard',
        editableSurfaces: [],
        phase: 'plan_approved',
        plan: [{
          id: 'inspect',
          title: 'Inspect candidate',
          description: 'Inspect the bounded workspace without writes.',
          dependsOnIds: [],
          editableSurfaces: [],
          completionCriteria: 'Canonical evidence is persisted.',
        }],
        planRevision: 1,
        executionKernel: createK4ExecutionKernelSelection({
          experimentId,
          disposition: 'inspection',
          actor: 'operator:select',
        }),
      },
    });
    await createExecutionExperiment({
      id: experimentId,
      tenantId: 'tenant-test',
      projectId: 'project-test',
      source: { sessionId, runSpecId, eventCursor: 0, evidenceHash: 'sha256:k4-running' },
      configDiff: [],
      createdBy: 'operator:create',
    });
    await setExecutionExperimentCandidate(experimentId, runSpecId, { tenantId: 'tenant-test', projectId: 'project-test' });
    await approveExecutionExperiment(experimentId, 'operator:approve', { tenantId: 'tenant-test', projectId: 'project-test' });
    await authorizeRunSpecKernelCanary({
      runSpecId,
      experimentId,
      actor: 'operator:authorize',
    });
    // Simulate the execute endpoint moving the experiment to running before dispatch.
    await getDb().query(
      "UPDATE execution_experiments SET status='running' WHERE id=$1",
      [experimentId],
    );
    const selection = (await loadRunSpec(runSpecId))?.runContract?.executionKernel;
    assert.ok(selection);
    await assertPersistedRunSpecKernelSelection({
      runSpecId,
      selection,
      tenantId: 'tenant-test',
      projectId: 'project-test',
    });
    // Sanity: a non-approved, non-running experiment still blocks.
    await getDb().query(
      "UPDATE execution_experiments SET status='blocked' WHERE id=$1",
      [experimentId],
    );
    await assert.rejects(
      assertPersistedRunSpecKernelSelection({
        runSpecId,
        selection,
        tenantId: 'tenant-test',
        projectId: 'project-test',
      }),
      /Pi K4 execution experiment is not approved/,
    );
  } finally {
    await getDb().query('DELETE FROM execution_experiments WHERE id=$1', [experimentId]).catch(() => undefined);
    await getDb().query('DELETE FROM run_specs WHERE id=$1', [runSpecId]).catch(() => undefined);
    await getDb().query('DELETE FROM session_events WHERE session_id=$1', [sessionId]).catch(() => undefined);
    await closeDb().catch(() => undefined);
  }
});
