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

export type ScheduledWorkTrigger = {
  kind: ScheduledTriggerKind;
  expression: string;
  timezone: string;
};

export type ScheduledWorkItem = {
  id: string;
  projectId: string;
  title: string;
  status: ScheduledWorkStatus;
  trigger: ScheduledWorkTrigger;
  runTemplate: {
    templateId: ScheduledWorkTemplateId;
    mode: 'audit' | 'governance';
    goalTemplate: string;
    editableSurfaces: string[];
    requiredChecks: string[];
    toolMode: 'read-only';
    feedAnalysisRequest?: Record<string, unknown>;
  };
  approvalPolicy: ScheduledApprovalPolicy;
  concurrencyPolicy: ScheduledConcurrencyPolicy;
  catchUpPolicy: ScheduledCatchUpPolicy;
  maxConcurrentRuns: number;
  maxLatenessMs: number;
  maxAttempts: number;
  failureThreshold: number;
  nextRunAt: string;
  circuitState: ScheduledCircuitState;
  consecutiveFailures: number;
  consecutiveNoOps: number;
  revision: number;
  createdAt: string;
  updatedAt: string;
};

export type ScheduledWorkItemRun = {
  id: string;
  scheduleId: string;
  scheduledFor: string;
  triggerKind: 'scheduled' | 'manual' | 'retry';
  status: ScheduledWorkRunStatus;
  attemptCount: number;
  maxAttempts: number;
  workItemId?: string;
  resultSummary?: Record<string, unknown>;
  error?: string;
  completedAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type ScheduledWorkListResponse = { count: number; results: ScheduledWorkItem[] };
export type ScheduledWorkDetailResponse = { schedule: ScheduledWorkItem; runs: ScheduledWorkItemRun[] };
export type ScheduledWorkPreviewResponse = { trigger: ScheduledWorkTrigger; occurrences: string[] };
export type CreateScheduledWorkResponse = { schedule: ScheduledWorkItem; occurrences: string[] };
