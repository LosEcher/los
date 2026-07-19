export type DailyAgentQualityInboxMetrics = {
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
};

export type DailyAgentQualityScheduleMetrics = {
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
};

export type DailyAgentQualityRecoveryMetrics = {
  requiredItems: number;
  recoveryEvents: number;
  retryAttempts: number;
  recoveredSuccesses: number;
  recoverySuccessRate: number;
};

export type DailyAgentQualityVerificationMetrics = {
  workItems: number;
  required: number;
  succeeded: number;
  skipped: number;
  failed: number;
  pending: number;
  missing: number;
  coverage: number;
};

export type DailyAgentQualityProviderMetrics = {
  evalCount: number;
  successCount: number;
  failureCount: number;
  successRate: number;
  averageLatencyMs?: number;
  averageRetryCount: number;
  toolErrorCount: number;
  modelCost: number;
};

export type DailyAgentQualitySnapshot = {
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
};

export type DailyAgentQualityEvidenceWindow = {
  status: 'collecting' | 'complete';
  observedDays: number;
  requiredDays: number;
  expectedFrom: string;
  expectedTo: string;
  oldestEvidenceDate?: string;
  newestEvidenceDate?: string;
  missingDates: string[];
};

export type DailyAgentQualityBaseline = {
  evidenceWindow: DailyAgentQualityEvidenceWindow;
  snapshots: DailyAgentQualitySnapshot[];
};

export type DailyAgentQualityCaptureResponse = {
  snapshot: DailyAgentQualitySnapshot;
  evidenceWindow: DailyAgentQualityEvidenceWindow;
};
