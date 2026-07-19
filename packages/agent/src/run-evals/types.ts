export type RunEvalVerificationStatus =
  | 'unknown'
  | 'not_required'
  | 'pending'
  | 'succeeded'
  | 'failed'
  | 'skipped';

export type RunEvalFailoverScope = 'service' | 'executor';
export type RunEvalPairwiseVerdict = 'baseline' | 'candidate' | 'tie' | 'inconclusive';
export type RunEvalEvidenceSource = 'human' | 'judge' | 'deterministic';

export interface RunEvalCriterionScore {
  criterionId: string;
  score: number;
  note?: string;
}

export interface RunEvalEvidenceChannel {
  source: string;
  verdict?: RunEvalPairwiseVerdict;
  criterionScores?: RunEvalCriterionScore[];
  note?: string;
  confidence?: number;
  verificationStatus?: RunEvalVerificationStatus;
}

export interface RunEvalRubricCriterion {
  id: string;
  label: string;
  description?: string;
  maxScore: number;
}

export interface RunEvalRubricSnapshot {
  id: string;
  revision: string;
  criteria: RunEvalRubricCriterion[];
}

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
  evaluationKind: 'single' | 'pairwise';
  pairId?: string;
  experimentId?: string;
  baselineRunSpecId?: string;
  candidateRunSpecId?: string;
  rubricRevision?: string;
  rubricSnapshot?: RunEvalRubricSnapshot;
  human?: RunEvalEvidenceChannel;
  judge?: RunEvalEvidenceChannel;
  deterministic?: RunEvalEvidenceChannel;
  pairwiseVerdict?: RunEvalPairwiseVerdict;
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

export interface RecordPairwiseRunEvalInput {
  id?: string;
  pairId?: string;
  experimentId: string;
  baselineRunSpecId: string;
  candidateRunSpecId: string;
  rubricRevision: string;
  rubricSnapshot: RunEvalRubricSnapshot;
  verdict: RunEvalPairwiseVerdict;
  human?: RunEvalEvidenceChannel;
  judge?: RunEvalEvidenceChannel;
  deterministic?: RunEvalEvidenceChannel;
  runSpecId?: string;
  sessionId?: string;
  taskRunId?: string;
  provider?: string;
  model?: string;
  success?: boolean;
  latencyMs?: number;
  retryCount?: number;
  toolErrorCount?: number;
  verificationStatus?: RunEvalVerificationStatus | string;
  modelCost?: number;
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
