import type { RunEvalVerificationStatus } from './run-evals.js';

export type DailyAgentScenarioRole = 'planner' | 'worker' | 'reviewer';
export type DailyAgentScenarioLane = 'baseline' | 'candidate';
export type DailyAgentScenarioRouteReason =
  | 'configured_default'
  | 'explicit_provider'
  | 'explicit_model'
  | 'architect_editor_override'
  | 'explicit_fallback_policy';

export interface DailyAgentScenarioDefinition {
  id: string;
  version: string;
  title: string;
  requiredRoles: DailyAgentScenarioRole[];
  acceptanceCriteria: string[];
}

export interface DailyAgentScenarioHardAssertion { id: string; passed: boolean }

export interface RecordDailyAgentScenarioEconomicsInput {
  id?: string;
  runSpecId: string;
  sessionId?: string;
  taskRunId?: string;
  scenarioId: string;
  scenarioVersion: string;
  scenarioRunId: string;
  lane: DailyAgentScenarioLane;
  role: DailyAgentScenarioRole;
  requestedProvider?: string | null;
  requestedModel?: string | null;
  effectiveProvider: string;
  effectiveModel: string;
  routeReason: DailyAgentScenarioRouteReason;
  success: boolean;
  latencyMs?: number;
  retryCount?: number;
  toolErrorCount?: number;
  verificationStatus: RunEvalVerificationStatus;
  modelCost: number;
  promptTokens: number;
  completionTokens: number;
  operatorInterventionCount: number;
  operatorWaitMs?: number;
  planningAttemptCount?: number;
  executionAttemptCount?: number;
  revisionCount?: number;
  diffOutcome?: 'accepted' | 'revision_requested' | 'not_reviewed';
  recoveryResult?: 'not_required' | 'resumed' | 'failed';
  hardAssertions: DailyAgentScenarioHardAssertion[];
}

export interface DailyAgentScenarioEconomicsOptions {
  runSpecId?: string;
  createdFrom?: string;
  createdTo?: string;
}
