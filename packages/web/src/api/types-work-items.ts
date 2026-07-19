export type TodoStatus = 'backlog' | 'ready' | 'in_progress' | 'blocked' | 'done' | 'cancelled';
export type TodoPriority = 'P0' | 'P1' | 'P2' | 'P3';
export type WorkItemMode = 'audit' | 'execution' | 'closeout' | 'governance' | 'feed-analysis-ingress';
export type WorkItemAttentionState = 'approval_required' | 'recovery_required' | 'verification_blocked' | 'review_ready' | 'running' | 'none' | 'unknown';
export type WorkItemNextAction = 'review_plan' | 'inspect_verification' | 'recover' | 'inspect_run' | 'review_changes' | 'start' | 'none';
export type InboxSourceKind = 'work_item' | 'orphan_run' | 'orphan_task' | 'orphan_event';

export type RunContractDraft = Record<string, unknown> & {
  mode?: WorkItemMode;
  phase?: string;
  goal?: string;
  editableSurfaces: string[];
  requiredChecks: string[];
  allowedSkippedChecks: string[];
  stopConditions: string[];
  evidenceRequired: string[];
  externalEvidenceAllowed: string[];
  rawEvidenceProhibited: string[];
  toolMode?: string;
  plan?: Array<{ id?: string; title?: string; description?: string; status?: string }>;
};

export type WorkItemRunLink = {
  id: string;
  workItemId: string;
  runSpecId?: string;
  taskRunId?: string;
  sessionId?: string;
  relationKind: string;
  createdAt: string;
  updatedAt: string;
};

export type WorkItemProjection = {
  id: string;
  title: string;
  description: string;
  goal: string;
  tenantId: string;
  projectId: string;
  userId?: string;
  status: TodoStatus;
  priority: TodoPriority;
  source: string;
  runContractDraft: RunContractDraft;
  attentionState: WorkItemAttentionState;
  nextAction: WorkItemNextAction;
  links: WorkItemRunLink[];
  evidence: {
    latestRunSpecId?: string;
    latestTaskRunId?: string;
    latestSessionId?: string;
    runSpecStatus?: string;
    taskRunStatus?: string;
    verificationRequired: number;
    verificationSucceeded: number;
    verificationSkipped: number;
    verificationFailed: number;
    verificationPending: number;
  };
  verificationRecords: Array<{
    id: string;
    checkName: string;
    kind: 'command' | 'assertion' | 'operator_review';
    status: 'required' | 'running' | 'succeeded' | 'failed' | 'skipped';
    required: boolean;
    command?: string;
    assertion?: string;
    reviewer?: string;
    skipReason?: string;
    outputSummary?: string;
    error?: string;
    updatedAt: string;
    completedAt?: string;
  }>;
  changes: {
    hasReviewableDiff: boolean;
    workspaces: Array<{
      workspaceId: string;
      status: 'creating' | 'active' | 'backup_ready' | 'released' | 'failed';
      baseRevision: string;
      backupArtifactId?: string;
      updatedAt: string;
      releasedAt?: string;
    }>;
    resultReview?: {
      decision: 'accepted' | 'revision_requested';
      actor: string;
      reason: string;
      decidedAt: string;
      closeoutReport: {
        dirtyPaths: string[];
        changeId?: string;
        bookmark?: string;
        checks: string[];
        residualRisk?: string;
      };
    };
  };
  feedAnalysis?: {
    dispatchId: string;
    sourceSystem: string;
    sourceJobId: string;
    sourceSessionId?: string;
    deliveryMode: 'delivery_only' | 'result_returning';
    dispatchStatus: string;
    resultAvailable: boolean;
    errorCode?: string;
    errorMessage?: string;
    updatedAt: string;
    callback: {
      configured: boolean;
      latestStatus: 'not_configured' | 'pending' | 'delivering' | 'delivered' | 'dead_letter';
      latestEventStatus?: string;
      latestSequence?: number;
      eventCount: number;
      pendingCount: number;
      deliveringCount: number;
      deliveredCount: number;
      deadLetterCount: number;
      latestLatencyMs?: number;
      deliveredAt?: string;
      deadLetteredAt?: string;
    };
  };
  createdAt: string;
  updatedAt: string;
};

export type InboxEntry = {
  id: string;
  sourceKind: InboxSourceKind;
  workItemId?: string;
  title: string;
  projectId: string;
  sessionId?: string;
  runSpecId?: string;
  taskRunId?: string;
  source?: string;
  connector?: {
    kind: 'feed_analysis';
    dispatchStatus: string;
    resultAvailable: boolean;
    callbackStatus: string;
  };
  attentionState: WorkItemAttentionState;
  nextAction: WorkItemNextAction;
  updatedAt: string;
};

export type InboxResponse = { count: number; results: InboxEntry[] };
export type WorkItemListResponse = { count: number; results: WorkItemProjection[] };

export type CreateWorkItemPayload = {
  projectId: string;
  title?: string;
  goal: string;
  description?: string;
  mode: WorkItemMode;
  editableSurfaces: string[];
  nonGoals: string[];
  requiredChecks: string[];
  stopConditions: string[];
  evidenceRequired: string[];
  toolMode: 'read-only' | 'project-write';
  priority: TodoPriority;
};
