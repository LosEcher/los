import type { WorkItemMode } from '../work-items/types.js';
import type { FeedAnalysisDispatchRequest } from '../integration/feed-analysis-types.js';

export type ScheduledTriggerKind = 'cron' | 'interval' | 'once';
export type ScheduledWorkStatus = 'enabled' | 'paused' | 'retired';
export type ScheduledApprovalPolicy = 'read_only_auto' | 'preapproved_scope' | 'each_run';
export type ScheduledConcurrencyPolicy = 'skip' | 'queue_one' | 'parallel';
export type ScheduledCatchUpPolicy = 'skip' | 'run_once';
export type ScheduledCircuitState = 'closed' | 'open' | 'half_open';
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
export type ScheduledWorkTemplateId = 'morning_inbox_digest' | 'runtime_readiness' | 'scheduled_feed_analysis';

export interface ScheduledWorkTrigger {
  kind: ScheduledTriggerKind;
  expression: string;
  timezone: string;
}

export interface ScheduledWorkRunTemplate {
  templateId: ScheduledWorkTemplateId;
  mode: Extract<WorkItemMode, 'audit' | 'governance'>;
  goalTemplate: string;
  editableSurfaces: string[];
  requiredChecks: string[];
  toolMode: 'read-only';
  feedAnalysisRequest?: Omit<FeedAnalysisDispatchRequest, 'sourceJobId'>;
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
