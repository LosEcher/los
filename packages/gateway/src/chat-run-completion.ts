import type { RunSpecStatus } from '@los/agent/run-specs';
import { loadRunSpec } from '@los/agent/run-specs';
import type { VerificationRecord } from '@los/agent';
import { ensureRunSpecVerificationPhase, listVerificationRecordsForRunSpec, resolveVerificationCompletionDecision } from '@los/agent';
import { transitionExecutionState } from '@los/agent/execution-store';
import { appendSessionEvent } from '@los/agent/session-events';

export interface DirectRunCompletionDecision {
  status: Extract<RunSpecStatus, 'succeeded' | 'blocked'>;
  blockedVerificationRecordIds: string[];
}

export interface ApplyDirectRunCompletionStatusInput {
  runSpecId: string;
  sessionId: string;
  tenantId?: string;
  projectId?: string;
  userId?: string;
  nodeId?: string;
  requestId?: string;
  traceId?: string;
  taskRunId: string;
}

export function resolveDirectRunCompletionDecision(
  verificationRecords: readonly Pick<VerificationRecord, 'id' | 'checkName' | 'required' | 'status'>[],
  allowedSkippedChecks: readonly string[] = [],
): DirectRunCompletionDecision {
  const decision = resolveVerificationCompletionDecision(verificationRecords, allowedSkippedChecks);
  return {
    status: decision.status,
    blockedVerificationRecordIds: decision.blockedVerificationRecordIds,
  };
}

export async function applyDirectRunCompletionStatus(
  input: ApplyDirectRunCompletionStatusInput,
): Promise<DirectRunCompletionDecision> {
  const runSpec = await loadRunSpec(input.runSpecId);
  const verificationRecords = await listVerificationRecordsForRunSpec(input.runSpecId, {
    planRevision: runSpec?.runContract?.planRevision ?? 1,
  });
  const decision = resolveDirectRunCompletionDecision(
    verificationRecords,
    runSpec?.runContract?.allowedSkippedChecks,
  );
  if (runSpec?.status === 'created') {
    await transitionExecutionState({
      entityType: 'run_spec',
      entityId: input.runSpecId,
      to: 'running',
      reason: 'direct_run_completion_started',
      commandId: input.requestId,
      correlationId: input.traceId,
      nodeId: input.nodeId,
    });
  }
  await ensureRunSpecVerificationPhase(input.runSpecId, 'direct_run_completion', 'los.gateway');
  await transitionExecutionState({
    entityType: 'run_spec',
    entityId: input.runSpecId,
    to: decision.status,
    reason: decision.status === 'blocked'
      ? 'required verification records are not satisfied'
      : 'direct run completed',
    commandId: input.requestId,
    correlationId: input.traceId,
    nodeId: input.nodeId,
  });
  if (decision.status === 'blocked') {
    await appendSessionEvent({
      sessionId: input.sessionId,
      tenantId: input.tenantId,
      projectId: input.projectId,
      userId: input.userId,
      nodeId: input.nodeId,
      requestId: input.requestId,
      traceId: input.traceId,
      type: 'run.blocked',
      payload: {
        runSpecId: input.runSpecId,
        taskRunId: input.taskRunId,
        reason: 'required verification records are not satisfied',
        blockReason: 'verifier_required',
        blockedVerificationRecordIds: decision.blockedVerificationRecordIds,
      },
    });
  }
  return decision;
}
