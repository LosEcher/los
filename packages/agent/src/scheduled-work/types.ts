import type { WorkItemMode } from '../work-items/types.js';
import type { FeedAnalysisDispatchRequest } from '../integration/feed-analysis-types.js';
import type { ScheduledExecutorConfig } from '../scheduler/types.js';

export type ScheduledTriggerKind = 'cron' | 'interval' | 'once';
export type ScheduledWorkStatus = 'enabled' | 'paused' | 'retired';
export type ScheduledApprovalPolicy = 'read_only_auto' | 'preapproved_scope' | 'each_run';
export type ScheduledConcurrencyPolicy = 'skip' | 'queue_one' | 'parallel';
export type ScheduledCatchUpPolicy = 'skip' | 'run_once';
export type ScheduledCircuitState = 'closed' | 'open' | 'half_open';
/** What the scheduler does with an awaiting_approval run once its approval
 *  timeout elapses. 'deny' is the conservative default; individual schedules
 *  may override to 'approve' when unattended auto-execution is intended. */
export type ScheduledApprovalTimeoutAction = 'deny' | 'approve';
export type ScheduledWorkRunStatus =
  | 'queued'
  | 'claimed'
  | 'running'
  | 'awaiting_approval'
  | 'succeeded'
  | 'no_op'
  | 'skipped'
  | 'failed'
  | 'cancelled';
export type ScheduledWorkTemplateId =
  | 'morning_inbox_digest'
  | 'runtime_readiness'
  | 'scheduled_feed_analysis'
  | 'scheduled_execution'
  | 'daily_execution_digest'
  | 'fleet_host_check';

export interface ScheduledWorkTrigger {
  kind: ScheduledTriggerKind;
  expression: string;
  timezone: string;
}

export interface ScheduledWorkRunTemplate {
  templateId: ScheduledWorkTemplateId;
  mode: Extract<WorkItemMode, 'audit' | 'governance' | 'execution'>;
  goalTemplate: string;
  editableSurfaces: string[];
  requiredChecks: string[];
  toolMode: 'read-only' | 'project-write' | 'all';
  /** Isolation level for scheduled_execution runs. `sandbox` requires an
   *  executor node whose capabilities.sandbox is a real OS backend
   *  (linux-bwrap / macos-sandbox-exec); selection rejects
   *  tool_policy/native nodes. Defaults to workspace-write. */
  sandboxMode?: 'readonly' | 'workspace-write' | 'sandbox';
  feedAnalysisRequest?: Omit<FeedAnalysisDispatchRequest, 'sourceJobId'>;
  /** Optional executor placement for scheduled_execution runs (wires the
   *  otherwise unused remote-executor channel; see executor-client.ts). */
  executor?: ScheduledExecutorConfig;
  /** Override for the agent loop's maxLoops (default 20). */
  maxLoops?: number;
  /** Workspace root override for remote execution: the default is the
   *  gateway's absolute workspace path, which does not exist on remote
   *  executor nodes. Point this at a node-local path (e.g.
   *  /opt/los/los-workspace or /rclone-hub/sub-store) so the remote agent
   *  can read/write real files. */
  workspaceRoot?: string;
}

export interface ScheduledWorkItem {
  id: string;
  tenantId: string;
  projectId: string;
  userId?: string;
  title: string;
  status: ScheduledWorkStatus;
  trigger: ScheduledWorkTrigger;
  runTemplate: ScheduledWorkRunTemplate;
  approvalPolicy: ScheduledApprovalPolicy;
  /** How long an awaiting_approval run waits before the scheduler auto-disposes it. */
  approvalTimeoutMs: number;
  /** Auto-disposition after approvalTimeoutMs: deny (default) or approve. */
  approvalTimeoutAction: ScheduledApprovalTimeoutAction;
  concurrencyPolicy: ScheduledConcurrencyPolicy;
  catchUpPolicy: ScheduledCatchUpPolicy;
  maxConcurrentRuns: number;
  maxLatenessMs: number;
  maxAttempts: number;
  retryBackoffMs: number;
  failureThreshold: number;
  nextRunAt: string;
  circuitState: ScheduledCircuitState;
  circuitOpenedAt?: string;
  consecutiveFailures: number;
  consecutiveNoOps: number;
  recoveryWorkItemId?: string;
  revision: number;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface ScheduledWorkItemRun {
  id: string;
  scheduleId: string;
  scheduledFor: string;
  triggerKind: 'scheduled' | 'manual' | 'retry';
  status: ScheduledWorkRunStatus;
  attemptCount: number;
  maxAttempts: number;
  claimOwner?: string;
  leaseExpiresAt?: string;
  workItemId?: string;
  runSpecId?: string;
  taskRunId?: string;
  resultSummary?: Record<string, unknown>;
  error?: string;
  startedAt?: string;
  completedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateScheduledWorkItemInput {
  tenantId?: string;
  projectId: string;
  userId?: string;
  title: string;
  trigger: ScheduledWorkTrigger;
  runTemplate: ScheduledWorkRunTemplate;
  approvalPolicy?: ScheduledApprovalPolicy;
  approvalTimeoutMs?: number;
  approvalTimeoutAction?: ScheduledApprovalTimeoutAction;
  concurrencyPolicy?: ScheduledConcurrencyPolicy;
  catchUpPolicy?: ScheduledCatchUpPolicy;
  maxConcurrentRuns?: number;
  maxLatenessMs?: number;
  maxAttempts?: number;
  retryBackoffMs?: number;
  failureThreshold?: number;
  metadata?: Record<string, unknown>;
  now?: Date;
}

export interface UpdateScheduledWorkItemInput {
  title?: string;
  status?: ScheduledWorkStatus;
  trigger?: ScheduledWorkTrigger;
  approvalPolicy?: ScheduledApprovalPolicy;
  approvalTimeoutMs?: number;
  approvalTimeoutAction?: ScheduledApprovalTimeoutAction;
  concurrencyPolicy?: ScheduledConcurrencyPolicy;
  catchUpPolicy?: ScheduledCatchUpPolicy;
  maxConcurrentRuns?: number;
  maxLatenessMs?: number;
  failureThreshold?: number;
  metadata?: Record<string, unknown>;
}

export interface ScheduledWorkRunOutcome {
  status: 'succeeded' | 'no_op';
  summary: Record<string, unknown>;
  title?: string;
  workItemId?: string;
  runSpecId?: string;
  taskRunId?: string;
}
