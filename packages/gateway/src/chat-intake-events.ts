import { appendSessionEvent, type SessionEventRecord } from '@los/agent/session-events';
import type { ProjectOwnerResolution } from '@los/agent/task-intake';

export interface ChatIntakeEventInput {
  sessionId: string;
  tenantId: string;
  userId: string;
  requestId: string;
  traceId: string;
  requestedProjectId?: string;
  requestedWorkspaceRoot?: string;
  resolution: ProjectOwnerResolution;
  runSpecId?: string;
}

export async function persistChatIntakeEvent(
  input: ChatIntakeEventInput,
): Promise<SessionEventRecord> {
  const resolved = input.resolution.status === 'resolved';
  if (resolved && (!input.resolution.ownerRepo || !input.resolution.workspaceRoot || !input.runSpecId)) {
    throw new Error('Resolved chat intake requires ownerRepo, workspaceRoot, and runSpecId');
  }

  return appendSessionEvent({
    sessionId: input.sessionId,
    tenantId: input.tenantId,
    projectId: resolved ? input.resolution.ownerRepo : undefined,
    userId: input.userId,
    requestId: input.requestId,
    traceId: input.traceId,
    type: resolved ? 'coordinator.intake_resolved' : 'coordinator.intake_blocked',
    source: 'coordinator',
    payload: {
      requestedProjectId: input.requestedProjectId ?? null,
      requestedWorkspaceRoot: input.requestedWorkspaceRoot ?? null,
      ownerRepo: input.resolution.ownerRepo ?? null,
      workspaceRoot: input.resolution.workspaceRoot ?? null,
      reason: input.resolution.reason,
      blocker: input.resolution.blocker ?? null,
      runSpecId: input.runSpecId ?? null,
    },
  });
}
