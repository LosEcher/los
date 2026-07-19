import type { InboxEntry, WorkItemVerificationCoverage } from '../work-items/types.js';
import type { ScheduledWorkItemRun } from '../scheduled-work/types.js';

export interface DailyAgentQualityInboxMetrics {
  actionableCount: number;
  approvalRequired: number;
  recoveryRequired: number;
  verificationBlocked: number;
  reviewReady: number;
  running: number;
  unknown: number;
  oldestAgeMs?: number;
  over24h: number;
  over72h: number;
}

export interface DailyAgentQualityScheduleMetrics {
  runCount: number;
  succeeded: number;
  noOp: number;
  failed: number;
  skipped: number;
  awaitingApproval: number;
  other: number;
  noOpRate: number;
  failureRate: number;
  averageLatenessMs?: number;
  maxLatenessMs?: number;
}

export interface DailyAgentQualityRecoveryMetrics {
  requiredItems: number;
  recoveryEvents: number;
  retryAttempts: number;
  recoveredSuccesses: number;
  recoverySuccessRate: number;
}

export interface DailyAgentQualityVerificationMetrics {
  workItems: number;
  required: number;
  succeeded: number;
  skipped: number;
  failed: number;
  pending: number;
  missing: number;
  coverage: number;
}

export interface DailyAgentQualityProviderMetrics {
  evalCount: number;
  successCount: number;
  failureCount: number;
  successRate: number;
  averageLatencyMs?: number;
  averageRetryCount: number;
  toolErrorCount: number;
  modelCost: number;
}

export interface DailyAgentQualitySnapshot {
  id: string;
  tenantId: string;
  projectId: string;
  snapshotDate: string;
  capturedAt: string;
  windowStart: string;
  windowEnd: string;
  inbox: DailyAgentQualityInboxMetrics;
  schedule: DailyAgentQualityScheduleMetrics;
  recovery: DailyAgentQualityRecoveryMetrics;
  verification: DailyAgentQualityVerificationMetrics;
  providerQuality: DailyAgentQualityProviderMetrics;
  createdAt: string;
  updatedAt: string;
}

export interface DailyAgentQualityEvidenceWindow {
  status: 'collecting' | 'complete';
  observedDays: number;
  requiredDays: number;
  expectedFrom: string;
  expectedTo: string;
  oldestEvidenceDate?: string;
  newestEvidenceDate?: string;
  missingDates: string[];
}

export interface DailyAgentQualityBaseline {
  evidenceWindow: DailyAgentQualityEvidenceWindow;
  snapshots: DailyAgentQualitySnapshot[];
}

export interface CaptureDailyAgentQualityInput {
  tenantId?: string;
  projectId: string;
  capturedAt?: Date;
  windowMs?: number;
}

export interface DailyQualityMetricSources {
  inboxEntries: InboxEntry[];
  scheduleRuns: ScheduledWorkItemRun[];
  taskRetries: Array<{ attempt: number; status: string }>;
  recoveryEvents: number;
  verification: WorkItemVerificationCoverage;
  providerEvals: Array<{
    success: boolean;
    latencyMs?: number;
    retryCount: number;
    toolErrorCount: number;
    modelCost?: number;
  }>;
}

export interface DailyAgentQualityScope {
  tenantId: string;
  projectId: string;
}
