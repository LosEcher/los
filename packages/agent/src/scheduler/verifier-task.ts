import { randomUUID } from 'node:crypto';
import {
  createAgentTaskAttempt,
  listAgentTaskAttempts,
  updateAgentTaskStatus,
  type AgentTaskAttemptStatus,
  type AgentTaskRecord,
} from '../agent-task-graph.js';
import {
  runVerificationRecordsForRunSpec,
  type RunVerificationRecordsForRunSpecResult,
} from '../verification-runner.js';
import { normalizeOptionalString } from './helpers.js';
import type { RunAgentTaskGraphSerialInput, RunAgentTaskGraphSerialResult } from './types.js';

export async function runClaimedVerifierGraphTask(
  task: AgentTaskRecord,
  input: RunAgentTaskGraphSerialInput,
): Promise<RunAgentTaskGraphSerialResult['executedTasks'][number]> {
  const attempts = await listAgentTaskAttempts(task.id);
  const attempt = attempts.length + 1;
  const attemptId = `${task.id}-attempt-${attempt}-${randomUUID()}`;
  const runSpecId = task.runSpecId ?? input.runSpecId;
  const nodeId = normalizeOptionalString(input.nodeId)
    ?? normalizeOptionalString(input.executor?.nodeId)
    ?? 'gateway-local';

  await createAgentTaskAttempt({
    id: attemptId,
    graphId: task.graphId,
    taskId: task.id,
    attempt,
    status: 'running',
    nodeId,
  });

  try {
    if (!runSpecId) {
      throw new Error(`verifier task ${task.id} cannot run without a runSpecId`);
    }

    const verification = await runVerificationRecordsForRunSpec(runSpecId, {
      timeoutMs: input.timeoutMs,
    });
    if (verification.records.length === 0) {
      throw new Error(`verifier task ${task.id} found no verification records for run spec ${runSpecId}`);
    }

    const verificationRecordId = firstVerificationRecordId(verification);
    const outputSummary = summarizeVerificationRun(verification);
    const status: AgentTaskAttemptStatus = verification.decision.status === 'succeeded' ? 'succeeded' : 'failed';
    const metadata = {
      attemptId,
      verificationRecordId,
      verificationRecordIds: verification.records.map(record => record.id),
      ranVerificationRecordIds: verification.ranRecordIds,
      blockedVerificationRecordIds: verification.decision.blockedVerificationRecordIds,
      failedVerificationRecordIds: verification.decision.failedVerificationRecordIds,
      pendingVerificationRecordIds: verification.decision.pendingVerificationRecordIds,
      outputSummary,
    };

    await updateAgentTaskStatus(task.id, status, metadata);
    await createAgentTaskAttempt({
      id: attemptId,
      graphId: task.graphId,
      taskId: task.id,
      attempt,
      status,
      nodeId,
      verificationRecordId,
      outputSummary,
      error: status === 'failed' ? outputSummary : undefined,
    });
    return {
      taskId: task.id,
      attemptId,
      status,
      verificationRecordId,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await updateAgentTaskStatus(task.id, 'failed', {
      attemptId,
      error: message,
    });
    await createAgentTaskAttempt({
      id: attemptId,
      graphId: task.graphId,
      taskId: task.id,
      attempt,
      status: 'failed',
      nodeId,
      error: message,
    });
    return { taskId: task.id, attemptId, status: 'failed' };
  }
}

function firstVerificationRecordId(result: RunVerificationRecordsForRunSpecResult): string | undefined {
  return result.ranRecordIds[0] ?? result.records.find(record => record.required)?.id ?? result.records[0]?.id;
}

function summarizeVerificationRun(result: RunVerificationRecordsForRunSpecResult): string {
  const blocked = result.decision.blockedVerificationRecordIds.length;
  const failed = result.decision.failedVerificationRecordIds.length;
  const pending = result.decision.pendingVerificationRecordIds.length;
  return `verification ${result.decision.status}; ran=${result.ranRecordIds.length}; records=${result.records.length}; blocked=${blocked}; failed=${failed}; pending=${pending}`;
}
