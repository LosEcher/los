export type AgentTaskRole = 'planner' | 'executor' | 'verifier';
export type AgentTaskStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'blocked';
export type AgentTaskAttemptStatus = 'running' | 'succeeded' | 'failed' | 'cancelled';

export type AgentTaskGraphTask = {
  id: string;
  graphId: string;
  runSpecId?: string;
  sessionId?: string;
  role: AgentTaskRole;
  title: string;
  prompt?: string;
  status: AgentTaskStatus;
  priority: number;
  confidence?: number;
  costEstimate?: number;
  deadlineAt?: string;
  maxAttempts: number;
  metadata: Record<string, unknown>;
  claimedByNodeId?: string;
  leaseExpiresAt?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
};

export type AgentTaskGraphEdge = {
  graphId: string;
  taskId: string;
  dependsOnTaskId: string;
  kind: 'blocks';
  metadata: Record<string, unknown>;
  createdAt: string;
};

export type AgentTaskGraphAttempt = {
  id: string;
  graphId: string;
  taskId: string;
  attempt: number;
  status: AgentTaskAttemptStatus;
  provider?: string;
  model?: string;
  nodeId?: string;
  taskRunId?: string;
  verificationRecordId?: string;
  toolCallStateIds: string[];
  outputSummary?: string;
  error?: string;
  startedAt: string;
  completedAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type AgentTaskGraphCompletion = {
  graphId: string;
  status: string;
  canComplete: boolean;
  reason: string;
  blockReason?: string;
  counts: {
    total: number;
    queued: number;
    running: number;
    succeeded: number;
    failed: number;
    cancelled: number;
    verifier: number;
    succeededVerifier: number;
  };
  readyTaskIds: string[];
  waitingTaskIds: string[];
  blockedTaskIds: string[];
  runningTaskIds: string[];
  failedTaskIds: string[];
  failedVerifierTaskIds: string[];
  cancelledTaskIds: string[];
  verifierTaskIds: string[];
  succeededVerifierTaskIds: string[];
};

export type AgentTaskGraph = {
  graphId: string;
  tasks: AgentTaskGraphTask[];
  edges: AgentTaskGraphEdge[];
  attemptsByTaskId: Record<string, AgentTaskGraphAttempt[]>;
  completion: AgentTaskGraphCompletion;
  control?: GovernedAgentTaskGraphControl | null;
};

export type GovernedAgentTaskGraphControl = {
  graphId: string;
  integrationOwner: string;
  status: 'active' | 'cancelled' | 'integrated';
  integrationStatus: 'pending_verification' | 'ready' | 'integrated' | 'cancelled';
  metadata: Record<string, unknown>;
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
  integratedAt?: string;
  events: Array<{
    eventId: string;
    graphId: string;
    eventType: string;
    actor: string;
    payload: Record<string, unknown>;
    createdAt: string;
  }>;
};

export type GovernedAgentTaskGraphResponse = {
  graph: AgentTaskGraph;
  control: GovernedAgentTaskGraphControl;
};

export type RunSpec = {
  id: string;
  sessionId: string;
  taskRunId?: string;
  status: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};
