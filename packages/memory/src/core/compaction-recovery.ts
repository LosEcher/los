export interface RecoveryCheckpointInput {
  toolState: {
    pendingCalls: Array<{
      callId: string;
      toolName: string;
      args: Record<string, unknown>;
      status: 'requested' | 'running' | 'succeeded' | 'failed';
    }>;
    lastResult: Array<{
      callId: string;
      toolName: string;
      outcome: 'success' | 'error' | 'cancelled';
      resultSummary: string;
    }>;
  };
  fileReferences: Array<{
    path: string;
    contentHash: string;
    lastOperation: 'read' | 'write' | 'edit';
  }>;
  messageCursor: {
    lastEventId: string;
    lastEventIndex: number;
    turnCount: number;
  };
}

export function recoveryCheckpointSummary(
  checkpoint: RecoveryCheckpointInput | undefined,
): Record<string, unknown> {
  if (!checkpoint) return {};

  return {
    toolState: {
      pendingCalls: checkpoint.toolState.pendingCalls.map(call => ({ ...call, args: { ...call.args } })),
      lastResult: checkpoint.toolState.lastResult.map(result => ({ ...result })),
    },
    fileReferences: checkpoint.fileReferences.slice(-10).map(reference => ({ ...reference })),
    messageCursor: { ...checkpoint.messageCursor },
  };
}
