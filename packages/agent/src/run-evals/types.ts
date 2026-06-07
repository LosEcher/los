export type RunEvalVerificationStatus =
  | 'unknown'
  | 'not_required'
  | 'pending'
  | 'succeeded'
  | 'failed'
  | 'skipped';

export type RunEvalFailoverScope = 'service' | 'executor';

export interface RunEvalRecord {
  id: string;
  runSpecId: string;
  sessionId?: string;
  taskRunId?: string;
  provider?: string;
  model?: string;
  success: boolean;
  latencyMs?: number;
  retryCount: number;
  toolErrorCount: number;
  verificationStatus: RunEvalVerificationStatus;
  modelCost?: number;
  userFeedback?: string;
  failureClass?: string;
  failoverScope?: RunEvalFailoverScope;
  summary: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface RecordRunEvalInput {
  id?: string;
  runSpecId: string;
  sessionId?: string;
  taskRunId?: string;
  provider?: string;
  model?: string;
  success: boolean;
  latencyMs?: number;
  retryCount?: number;
  toolErrorCount?: number;
  verificationStatus?: RunEvalVerificationStatus | string;
  modelCost?: number;
  userFeedback?: string;
  failureClass?: string;
  failoverScope?: RunEvalFailoverScope | string;
  summary?: Record<string, unknown>;
}

export interface ListRunEvalsOptions {
  runSpecId?: string;
  sessionId?: string;
  taskRunId?: string;
  provider?: string;
  model?: string;
  success?: boolean;
  verificationStatus?: RunEvalVerificationStatus | string;
  failureClass?: string;
  failoverScope?: RunEvalFailoverScope | string;
  limit?: number;
}

export interface SummarizeRunEvalsOptions extends Omit<ListRunEvalsOptions, 'limit'> {
  createdFrom?: string;
  createdTo?: string;
  limit?: number;
}

export interface RunEvalSummaryGroup {
  key: string;
  count: number;
  successCount: number;
  failureCount: number;
  successRate: number;
  averageLatencyMs?: number;
  averageRetryCount: number;
  toolErrorCount: number;
  modelCost: number;
}

export interface RunEvalSummary {
  filters: {
    runSpecId?: string;
    sessionId?: string;
    taskRunId?: string;
    provider?: string;
    model?: string;
    success?: boolean;
    verificationStatus?: string;
    failureClass?: string;
    failoverScope?: string;
    createdFrom?: string;
    createdTo?: string;
  };
  totals: {
    count: number;
    successCount: number;
    failureCount: number;
    successRate: number;
    averageLatencyMs?: number;
    averageRetryCount: number;
    toolErrorCount: number;
    modelCost: number;
  };
  byFailureClass: RunEvalSummaryGroup[];
  byFailoverScope: RunEvalSummaryGroup[];
  byVerificationStatus: RunEvalSummaryGroup[];
  byProviderModel: RunEvalSummaryGroup[];
}

export interface CompareRunEvalsOptions extends Omit<SummarizeRunEvalsOptions, 'createdFrom' | 'createdTo'> {
  baselineFrom: string;
  baselineTo: string;
  candidateFrom: string;
  candidateTo: string;
}

export interface RunEvalComparison {
  filters: Omit<RunEvalSummary['filters'], 'createdFrom' | 'createdTo'>;
  baseline: RunEvalSummary;
  candidate: RunEvalSummary;
  delta: {
    count: number;
    successCount: number;
    failureCount: number;
    successRate: number;
    averageLatencyMs?: number;
    averageRetryCount: number;
    toolErrorCount: number;
    modelCost: number;
  };
}
