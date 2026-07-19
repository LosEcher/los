import type { RunContractMetadata } from '../run-contract.js';
import type { TodoPriority, TodoRecord, TodoStatus } from '../todo-types.js';
import type { ManagedWorkspaceStatus } from '../managed-workspace-types.js';
import type { VerificationRecordStatus } from '../verification-records.js';
import type { FeedAnalysisWorkItemEvidence } from '../integration/feed-analysis-work-item.js';

export type WorkItemMode =
  | 'audit'
  | 'execution'
  | 'closeout'
  | 'governance'
  | 'feed-analysis-ingress';

export type WorkItemRelationKind =
  | 'discovery'
  | 'planning'
  | 'execution'
  | 'verification'
  | 'recovery'
  | 'closeout';

export type WorkItemAttentionState =
  | 'approval_required'
  | 'recovery_required'
  | 'verification_blocked'
  | 'review_ready'
  | 'running'
  | 'none'
  | 'unknown';

export type WorkItemNextAction =
  | 'review_plan'
  | 'inspect_verification'
  | 'recover'
  | 'inspect_run'
  | 'review_changes'
  | 'start'
  | 'none';

export interface CreateWorkItemInput {
  tenantId?: string;
  projectId: string;
  userId?: string;
  title?: string;
  goal: string;
  description?: string;
  mode: WorkItemMode;
  editableSurfaces: string[];
  nonGoals?: string[];
  requiredChecks: string[];
  stopConditions: string[];
  evidenceRequired?: string[];
  toolMode?: 'read-only' | 'project-write';
  priority?: TodoPriority;
}

export interface WorkItemRunLink {
  id: string;
  workItemId: string;
  runSpecId?: string;
  taskRunId?: string;
  sessionId?: string;
  relationKind: WorkItemRelationKind;
  createdAt: string;
  updatedAt: string;
}

export interface LinkWorkItemRunInput {
  workItemId: string;
  runSpecId?: string;
  taskRunId?: string;
  sessionId?: string;
  relationKind?: WorkItemRelationKind;
}

export interface WorkItemEvidenceSummary {
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
}

export interface WorkItemVerificationEvidence {
  id: string;
  checkName: string;
  kind: 'command' | 'assertion' | 'operator_review';
  status: VerificationRecordStatus;
  required: boolean;
  command?: string;
  assertion?: string;
  reviewer?: string;
  skipReason?: string;
  outputSummary?: string;
  error?: string;
  updatedAt: string;
  completedAt?: string;
}

export interface WorkItemWorkspaceEvidence {
  workspaceId: string;
  status: ManagedWorkspaceStatus;
  baseRevision: string;
  backupArtifactId?: string;
  updatedAt: string;
  releasedAt?: string;
}

export interface WorkItemCloseoutReport {
  dirtyPaths: string[];
  changeId?: string;
  bookmark?: string;
  checks: string[];
  residualRisk?: string;
}

export interface WorkItemResultReview {
  decision: 'accepted' | 'revision_requested';
  actor: string;
  reason: string;
  decidedAt: string;
  closeoutReport: WorkItemCloseoutReport;
}

export interface WorkItemChangeEvidence {
  hasReviewableDiff: boolean;
  workspaces: WorkItemWorkspaceEvidence[];
  resultReview?: WorkItemResultReview;
}

export interface WorkItemProjection {
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
  runContractDraft: RunContractMetadata;
  attentionState: WorkItemAttentionState;
  nextAction: WorkItemNextAction;
  links: WorkItemRunLink[];
  evidence: WorkItemEvidenceSummary;
  verificationRecords: WorkItemVerificationEvidence[];
  changes: WorkItemChangeEvidence;
  scheduledWork?: {
    scheduleId: string;
    runId: string;
    status: 'awaiting_approval' | 'succeeded' | 'failed';
    summary: Record<string, unknown>;
  };
  feedAnalysis?: FeedAnalysisWorkItemEvidence;
  createdAt: string;
  updatedAt: string;
}

export type InboxSourceKind = 'work_item' | 'orphan_run' | 'orphan_task' | 'orphan_event';

export interface InboxEntry {
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
}

export interface ListWorkItemsOptions {
  tenantId?: string;
  projectId?: string;
  status?: TodoStatus;
  limit?: number;
  excludeTerminal?: boolean;
}

export interface OrphanRuntimeEvidence {
  id: string;
  sourceKind: Exclude<InboxSourceKind, 'work_item'>;
  title: string;
  projectId: string;
  sessionId?: string;
  runSpecId?: string;
  taskRunId?: string;
  attentionState: 'recovery_required' | 'unknown';
  updatedAt: string;
}

export interface WorkItemProjectionInput {
  todo: TodoRecord;
  links: WorkItemRunLink[];
  runContract?: RunContractMetadata;
  runSpec?: {
    id: string;
    sessionId: string;
    status: string;
    phase?: string;
    updatedAt: string;
  };
  taskRuns: Array<{ id: string; sessionId: string; status: string; updatedAt: string }>;
  verificationStatuses: WorkItemVerificationEvidence[];
  managedWorkspaces?: WorkItemWorkspaceEvidence[];
  feedAnalysis?: FeedAnalysisWorkItemEvidence;
}

export interface WorkItemVerificationCoverage {
  projectId: string;
  mode: WorkItemMode | 'all';
  workItems: number;
  required: number;
  succeeded: number;
  skipped: number;
  failed: number;
  pending: number;
  missing: number;
  coverage: number;
}

export interface ReviewWorkItemResultInput {
  workItemId: string;
  decision: 'accepted' | 'revision_requested';
  actor: string;
  reason: string;
  closeoutReport?: Partial<WorkItemCloseoutReport>;
}
