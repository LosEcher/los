/**
 * @los/agent — Public API surface.
 *
 * Subpath exports (package.json "exports") are the primary access pattern for
 * modular monolith consumers.  The barrel export here is a convenience subset
 * of high-traffic symbols that gateways, CLIs, and executors use repeatedly.
 *
 * Symbols not exported here are still available via their subpath — e.g.
 * `@los/agent/task-runs`, `@los/agent/governance-jobs`.  This is intentional:
 * the barrel is the "front door", not the only door.
 *
 * When adding a new public symbol, prefer subpath-only until at least two
 * external consumers request it via the barrel.
 */

export { runAgent, type AgentConfig, type AgentModelDelta, type AgentResult, type ToolCallStateTransition, type TurnSummary, type CheckpointState, type ModelDiagnosticConfig, type ModelDiagnosticConcept, type ModelDiagnosticInput, type ModelDiagnosticKind, type ModelDiagnosticMode, type ModelDiagnosticPhase, type ModelDiagnosticProbe, type ModelDiagnosticRecommendation, type ModelDiagnosticRiskLevel, type ModelDiagnosticSnapshot, type ToolPreflightDiagnostic } from './loop.js';
export { getDefaultSystemPrompt } from './loop/message-builder.js';
export { cancelScheduledTask, runAgentTaskGraphSerial, runScheduledAgentTask, type AgentTaskGraphStageOutput, type RunAgentTaskGraphSerialInput, type RunAgentTaskGraphSerialResult, type ScheduledAgentTaskInput, type ScheduledAgentTaskResult, type ScheduledTaskEvent, type ScheduledTaskEventType } from './scheduler.js';
export { resumeAnsweredAsksForRunSpec } from './scheduler/resume-tasks.js';
export { createProvider, createDeepSeekProvider, createOpenAIProvider, type ChatOptions, type Provider, type ProviderDelta, type Message, type ToolCall, type ProviderResponse, type CreateProviderOptions, type ProviderModelInfo } from './providers/index.js';
export { normalizeModelSettings, type ModelSettings } from './model-settings.js';
export { MODEL_PROFILES, calculateCost, estimateCost, resolveModelCapabilityProfile, resolveModelProfile, summarizeModelProfile, type ApiShape, type CachePolicy, type CostEstimate, type ModelCapabilityProfile, type ModelExecutionSummary, type ModelPricing, type ModelProfile, type ProviderProtocol, type ResolveModelProfileOptions, type SessionAffinity, type ToolCallRepairMode, type TransportHint, type VisionCapabilityMode } from './model-profiles.js';
export { ADVISORY_COMPATIBILITY_TARGETS, DEFAULT_COMPATIBILITY_PROBES, DEFAULT_COMPATIBILITY_TARGETS, createCompatibilityRunSpecs, parseCompatibilityTarget, parseCompatibilityTargets, resolveRequiredCompatibilityTargets, resolveRequiredCompatibilityTargetsWithDefaultDb, selectCompatibilityProbes, summarizeCompatibilityEvents, target, type CompatibilityHarnessOptions, type CompatibilityProbe, type CompatibilityRunSpec, type CompatibilityRunSummary, type CompatibilitySseEvent, type CompatibilityToolMode, type ProviderModelTarget } from './compat-harness.js';
export { validateProviderModelRequest, type ProviderRequestConfig, type ProviderRequestValidationFailure, type ProviderRequestValidationInput, type ProviderRequestValidationResult, type ProviderRequestValidationSuccess } from './provider-request-validation.js';
export { createToolRegistry, registerBuiltinTools, READ_ONLY_BUILTIN_TOOLS, setWorkspaceRoot, type ToolRegistry, type ToolRegistryOptions, type BuiltinToolOptions, type ToolCapability, type ToolCostLevel, type ToolExecutionPolicy, type ToolExecutionDecision, type ToolHandler, type ToolInput, type ToolRetryPolicy, type ToolRiskLevel, type ToolResult } from './tools/core/registry.js';
export { MCPToolBridge, MCPClient, type MCPServerConfig, type MCPToolDef, type MCPServerRegistryRecord, registryRecordToConfig } from './tools/external/mcp-client.js';
export { ensureMCPServerStore, upsertMCPServer, loadMCPServer, listMCPServers, deleteMCPServer, updateMCPServerStatus, type MCPServerRecord, type MCPTransport, type MCPServerStatus, type MCPRegisteredTool, type UpsertMCPServerInput, type UpdateMCPServerStatusInput, type ListMCPServersOptions } from './mcp-servers.js';
export { ensureSessionStore, saveSession, loadSession, listSessions, deleteSession, type SessionRecord } from './session.js';
export { recordOperatorFollowup, recordOperatorSteering, recordSessionBranchCreated, type RecordOperatorFollowupInput, type RecordOperatorSteeringInput, type RecordSessionBranchCreatedInput } from './operator-control.js';
export { applyToolCallRecoveryTransitionForRunSpec, evaluateToolCallRecovery, readToolCallRecoveryForRunSpec, readToolCallRecoveryForTaskRun, type ToolCallRecoveryDecision, type ToolCallRecoveryIntent, type ToolCallRecoveryOptions, type ToolCallRecoveryRecommendation, type ToolCallRecoveryTransitionAction, type ToolCallRecoveryTransitionResult } from './tool-call-recovery.js';
export { ExecutionTransitionError, assertExecutionTransition, canTransitionExecutionState, evaluateExecutionTransition, executionTransitionEventType, isTerminalExecutionState, type ExecutionEntityType, type ExecutionState, type ExecutionStateByEntity, type ExecutionTransitionInput, type ExecutionTransitionResult } from './execution-transitions.js';
export { ensureRunSpecStore, claimRunSpec, createRunSpec, approveRunSpecPhase, loadRunSpec, reviseRunSpecPlan, listRunSpecs, listRunSpecsForSession, type RunSpecRecord, type RunSpecStatus, type CreateRunSpecInput } from './run-specs.js';
export { persistRunSpecPlan } from './run-spec-plans.js';
export { buildPlanningPrompt, parsePlanningOutput, type PlanningOutput } from './planning-output.js';
export { canMarkSucceeded, canStartExecution, mergeRunContractMetadata, normalizeRunContractMetadata, readRunContractMetadata, validatePhaseTransition, type PlanRevisionSnapshot, type PlanStep, type RunContractMetadata, type RunContractMetadataInput, type RunContractMode, type RunPhase, type VerificationRequirement } from './run-contract.js';
export { ensureRunSpecVerificationPhase } from './run-phase-transitions.js';
export { loadSpecsForFiles, loadAllSpecs, resolveSpecLayer, trimSpecForReview, type LoadedSpec, type LoadSpecsOptions, type SpecLayer } from './spec-loader.js';
export {
  createProviderFallbackRouter,
  normalizeProviderFallbackPolicy,
  prepareProviderFallbackPolicy,
  resolveProviderFallbackInitialTarget,
  type PreparedProviderFallbackTarget,
  type ProviderFallbackEvidence,
  type ProviderFallbackEvent,
  type ProviderFallbackFailureClass,
  type ProviderFallbackPolicy,
  type ProviderFallbackTarget,
} from './providers/provider-fallback.js';
export { resolveAgentIdentity, resolveEffectiveIdentityLevel, resolveIdentityLevelForExecutionPath, formatIdentityForPrompt, type AgentIdentity, type AgentIdentityExecutionPath, type IdentityLevel, type IdentityResolveSource } from './identity-loader.js';
export { runLifecycleHooks, type RunHookInput, type HookEvent } from './lifecycle-hooks.js';
export { createVerificationRecord, ensureVerificationRecordStore, listVerificationRecordsForRunSpec, listVerificationRecordsForSession, loadVerificationRecord, seedVerificationRequirementsForRunSpec, type CreateVerificationRecordInput, type VerificationRecord, type VerificationRecordStatus } from './verification-records.js';
export { resolveVerificationCompletionDecision, runVerificationRecord, runVerificationRecordsForRunSpec, type RunVerificationRecordOptions, type RunVerificationRecordResult, type RunVerificationRecordsForRunSpecOptions, type RunVerificationRecordsForRunSpecResult, type VerificationCommandResult, type VerificationCompletionDecision } from './verification-runner.js';
export { ensureProviderCompatEvidenceStore, loadProviderCompatEvidence, listProviderCompatEvidence, listLatestProviderCompatEvidence, recordProviderCompatEvidence, recordProviderCompatEvidenceFromSummary, recordProviderCompatEvidenceFromSummaryWithDefaultDb, type ProviderCompatDecision, type ProviderCompatEvidenceRecord, type ListProviderCompatEvidenceOptions, type RecordProviderCompatEvidenceInput } from './provider-compat-evidence.js';
export { enforceProviderPromotionDecision, ensureProviderPromotionDecisionStore, listProviderPromotionDecisions, recordProviderPromotionDecision, type EnforceProviderPromotionDecisionInput, type ListProviderPromotionDecisionsOptions, type ProviderPromotionDecisionRecord, type ProviderPromotionPolicyAction, type ProviderPromotionPolicyStatus, type RecordProviderPromotionDecisionInput } from './provider-promotion-decisions.js';
export { ensureExternalToolSummaryStore, importExternalToolSummary, listExternalToolSummaries, normalizeExternalToolSummary, redactExternalSummaryText, type ExternalAgentTool, type ExternalSummaryEvidenceInput, type ExternalSummarySourceKind, type ExternalToolSummaryRecord, type ExternalToolSummary, type ExternalToolSummaryInput, type ListExternalToolSummariesOptions } from './external-tool-summary.js';
export {
  listFeedAnalysisTargets, dispatchFeedAnalysisJob, getFeedAnalysisDispatch,
  getFeedAnalysisResult, cancelFeedAnalysisDispatch, FeedAnalysisError,
  type FeedAnalysisCapabilityOptions, type FeedAnalysisDispatchOptions,
  type FeedAnalysisTarget, type FeedAnalysisDispatchRequest, type FeedAnalysisDispatchReceipt,
  type FeedAnalysisDispatchState, type FeedAnalysisDispatchResult, type FeedAnalysisResultResponse,
  type FeedAnalysisResultEnvelope, type FeedAnalysisArtifact, type FeedAnalysisScenario,
  type FeedAnalysisWorkflowProfile,
} from './integration/feed-analysis-ingress.js';
export { ensureFeedAnalysisStore, pruneExpiredFeedAnalysisMaterial } from './integration/feed-analysis-store.js';
export {
  processDueFeedAnalysisCallbacks, listFeedAnalysisDeadLetters, replayFeedAnalysisDeadLetter,
  type FeedAnalysisCallbackProfile,
  type FeedAnalysisCallbackDeliveryResult,
  type FeedAnalysisDeadLetterDelivery,
} from './integration/feed-analysis-callback-outbox.js';
export { writeDeadLetterEvent, writeDeadLetterForExpiredTasks, listDeadLetterEvents, acknowledgeDeadLetterEvent, ensureDeadLetterStore, type DeadLetterEventRecord, type DeadLetterResolution, type ResolveDeadLetterInput, type DLQReason, type ListDeadLetterOptions } from './dead-letter.js';
export { summarizeDeadLetterEvents, requeueDeadLetterEvent, type DeadLetterReasonSummary, type DeadLetterSummary, type DeadLetterRequeueResult, type DeadLetterRequeueOptions } from './dead-letter-recovery.js';
export { ensureRunEvalStore, compareRunEvals, listRunEvals, listPairwiseRunEvals, recordFailoverEval, recordPairwiseRunEval, recordRunEval, summarizeRunEvals, type CompareRunEvalsOptions, type ListRunEvalsOptions, type RecordPairwiseRunEvalInput, type RecordRunEvalInput, type RunEvalComparison, type RunEvalFailoverScope, type RunEvalRecord, type RunEvalSummary, type RunEvalSummaryGroup, type RunEvalVerificationStatus, type RunEvalEvidenceChannel, type RunEvalRubricSnapshot, type RunEvalRubricCriterion, type RunEvalCriterionScore, type RunEvalPairwiseVerdict, type SummarizeRunEvalsOptions } from './run-evals.js';
export { getDailyAgentScenarioCorpus, recordDailyAgentScenarioEconomics, summarizeDailyAgentScenarioEconomics, type DailyAgentScenarioDefinition, type DailyAgentScenarioEconomicsOptions, type DailyAgentScenarioHardAssertion, type DailyAgentScenarioLane, type DailyAgentScenarioRole, type DailyAgentScenarioRouteReason, type RecordDailyAgentScenarioEconomicsInput } from './scenario-economics.js';
export { ensureExecutionExperimentStore, createExecutionExperiment, loadExecutionExperiment, setExecutionExperimentCandidate, approveExecutionExperiment, transitionExecutionExperiment, type ExecutionExperimentRecord, type ExecutionExperimentStatus, type ExecutionExperimentSource, type ExecutionExperimentConfigDiff, type CreateExecutionExperimentInput } from './execution-experiments.js';
export { getEvalBacklogCases, recordEvalBacklogSnapshot, type EvalBacklogCase } from './eval-backlog-runner.js';
export { claimBlockedAgentTask, claimReadyAgentTasks, createAgentTask, createAgentTaskAttempt, editableSurfacesForAgentTask, editableSurfacesOverlap, ensureAgentTaskGraphStore, heartbeatAgentTask, linkAgentTaskDependency, listAgentTaskAttempts, listAgentTasksForGraph, listAgentTasksForRunSpec, listBlockedAgentTasks, recoverExpiredAgentTasks, recoverExpiredAgentTasksWithAdvisoryLock, updateAgentTaskStatus, type AgentTaskAttemptRecord, type AgentTaskAttemptStatus, type AgentTaskEdgeRecord, type AgentTaskLeaseFence, type AgentTaskRecord, type AgentTaskRole, type AgentTaskStatus, type ClaimReadyAgentTasksInput, type CreateAgentTaskAttemptInput, type CreateAgentTaskInput, type LinkAgentTaskDependencyInput } from './agent-task-graph.js';
export { backupManagedWorkspace, createManagedWorkspace, ensureManagedWorkspaceStore, listManagedWorkspaces, loadManagedWorkspace, loadManagedWorkspaceDetail, releaseManagedWorkspace, workspaceRootForTask, type CreateManagedWorkspaceInput, type ListManagedWorkspacesOptions, type ManagedWorkspaceDetail, type ManagedWorkspaceEvent, type ManagedWorkspaceRecord, type ManagedWorkspaceRuntimeOptions, type ManagedWorkspaceStatus } from './managed-workspaces.js';
export { getAgentTaskGraphCompletion, readAgentTaskGraph, summarizeAgentTaskGraph, type AgentTaskGraphBlockReason, type AgentTaskGraphCompletion, type AgentTaskGraphCompletionOptions, type AgentTaskGraphCompletionStatus, type AgentTaskGraphReadModel } from './agent-task-graph-read-model.js';
export { cancelGovernedAgentTaskGraph, createGovernedAgentTaskGraph, integrateGovernedAgentTaskGraph, loadGovernedAgentTaskGraph, type CreateGovernedAgentTaskGraphInput, type GovernedAgentTaskGraphEvent, type GovernedAgentTaskGraphIntegrationStatus, type GovernedAgentTaskGraphRecord, type GovernedAgentTaskGraphStatus, type GovernedGraphWorkerInput } from './agent-task-graph/graph-control.js';
export { ensureSchedulerDecisionLedgerStore, listSchedulerDecisions, recordSchedulerDecision, type ListSchedulerDecisionsOptions, type RecordSchedulerDecisionInput, type SchedulerDecisionKind, type SchedulerDecisionRecord } from './scheduler-decision-ledger.js';
export { buildExecutionStaticGraph, type BuildExecutionStaticGraphOptions, type ExecutionStaticEdge, type ExecutionStaticEdgeKind, type ExecutionStaticGraph, type ExecutionStaticNode, type ExecutionStaticNodeKind } from './execution-static-graph.js';
export { readRuntimeEvidenceGraph, type ReadRuntimeEvidenceGraphOptions, type RuntimeEvidenceEdge, type RuntimeEvidenceEdgeKind, type RuntimeEvidenceGraph, type RuntimeEvidenceNode, type RuntimeEvidenceNodeKind, type RuntimeEvidenceRecord } from './runtime-evidence-graph.js';
export { buildRunStateProjection, readRunStateProjection, type BuildRunStateProjectionInput, type RunStateAction, type RunStateBlocker, type RunStateBlockerKind, type RunStateProjection } from './run-state-vocabulary.js';
export { reconcilePlanningTodos, reconcilePlanningTodosFromOpenDb, reconcilePlanningTodosWithDefaultDb, type GovernanceTodoSnapshot, type TodoFieldDrift, type TodoReconciliationItem, type TodoReconciliationOptions, type TodoReconciliationReport, type TodoReportOnlySeedField, type TodoStatusDrift } from './governance-reconciliation.js';
export { detectRuntimeCleanup, detectRuntimeCleanupFromOpenDb, detectRuntimeCleanupWithDefaultDb, type RuntimeCleanupCandidate, type RuntimeCleanupOptions, type RuntimeCleanupReport, type RuntimeCleanupRunSpecSnapshot, type RuntimeCleanupTaskRunSnapshot } from './governance-runtime-cleanup.js';
export { readStatusConstraintReportFromOpenDb, readStatusConstraintReportWithDefaultDb, summarizeStatusConstraintReport, validateStatusConstraintsFromOpenDb, validateStatusConstraintsWithDefaultDb, type StatusConstraintDefinition, type StatusConstraintReport, type StatusConstraintSnapshot, type ValidateStatusConstraintsResult } from './governance-status-constraints.js';
export { ensureGovernanceJobStore, createGovernanceJob, getGovernanceJob, listGovernanceJobs, listDueGovernanceJobs, updateGovernanceJob, updateGovernanceJobState, deleteGovernanceJob, seedGovernanceJobs, claimNextDueJob, runGovernanceSweep, runGovernanceSweepLoop, setupGovernanceWake, type GovernanceJob, type GovernanceJobType, type GovernanceCadence, type GovernanceJobStatus, type GovernanceJobAutoFixConfig, type CreateGovernanceJobInput, type UpdateGovernanceJobInput, type UpdateGovernanceJobStateInput, type ListGovernanceJobsOptions, type GovernanceSweepResult, type GovernanceSweepJobResult, type GaLoopResult, type GaLoopPhase, type CircuitState } from './governance-jobs.js';
export { runGaLoop, type RunGaLoopOptions } from './ga-loop-runner.js';
export { evaluateLoopGate, computeNextState, maybeAutoRecoverPaused, type ThrottleDecision } from './ga-circuit-breaker.js';
export { scanRelatedProjects, formatScanReport, RELATED_PROJECTS, type RelatedProject, type ProjectScanResult } from './ga-related-project-scanner.js';
export { ensureStaticGraphBaselineStore, captureStaticGraphBaseline, getLatestBaseline, getBaseline, deleteBaseline, diffBaselines, summarizeBaselineDiff, type StaticGraphBaseline, type BaselineDiff, type CaptureBaselineInput } from './static-graph-baselines.js';
export { ensureTaskRunStore, createTaskRun, findActiveTaskRunByDedupeKey, updateTaskRunFields, heartbeatTaskRun, recoverExpiredTaskRuns, recoverExpiredTaskRunsWithAdvisoryLock, recoverActiveTaskRunsForGateway, loadTaskRun, listTaskRuns, listTaskRunsByStatus, listTaskRunsForSession, listTaskRunsForRunSpec, claimBlockedTaskRunsWithAnswer, type ClaimedBlockedTaskRun, type CreateTaskRunInput, type TaskRunRecoveryResult, type TaskRunRecord, type TaskRunStatus, type UpdateTaskRunFieldsInput } from './task-runs.js';
export { ensureWorkerMessageStore, sendWorkerMessage, sendHeartbeat, recordWorkerAnswer, listMessagesForDispatch, listMessagesForTask, hasWorkerDone, type WorkerMessage, type WorkerMessageType, type WorkerMessagePayload, type SendWorkerMessageInput } from './worker-messages.js';
export { ensureExecutorNodeStore, loadExecutorNode, listExecutorNodes, recordExecutorNodeProbe, upsertExecutorNode, upsertExecutorNodeHeartbeat, type ExecutorNodeHeartbeatInput, type ExecutorNodeConnectMode, type ExecutorNodeKind, type ExecutorNodeProbeInput, type ExecutorNodeRecord, type ExecutorNodeStatus, type ExecutorNodeUpsertInput } from './executor-nodes.js';
export { clearCancellation, ensureCancellationStore, pollCancellation, requestCancellation, type CancellationRequest } from './cancellation.js';
export { ensureServiceInstanceStore, evaluateServiceInstance, listServiceInstances, loadServiceInstance, upsertServiceInstance, upsertServiceInstanceHeartbeat, type ServiceInstanceHeartbeatInput, type ServiceInstanceKind, type ServiceInstanceReadiness, type ServiceInstanceRecord, type ServiceInstanceRole, type ServiceInstanceRolloutState, type ServiceInstanceStatus, type ServiceInstanceUpsertInput } from './service-instances.js';
export { ensureSessionEventStore, appendSessionEvent, appendSessionEvents, listSessionEvents, listRecentSessionEvents, listSessionEventsSince, getSessionObservability, projectSessionObservability, type SessionEventRecord, type SessionEventUsage, type SessionEventWrite, type SessionObservability } from './session-events.js';
export { projectExecutionObservability, type ExecutionCountEvidence, type ExecutionDurationEvidence, type ExecutionFailureFacet, type ExecutionFailureFacetCategory, type ExecutionFingerprint, type ExecutionFingerprintComponentName, type ExecutionObservabilityProjection, type ExecutionTokenEvidence, type ExecutionTurnWaterfall, type ExecutionVersionEvidence } from './execution-observability.js';
export { ensureStreamCheckpointStore, createStreamCheckpoint, listStreamCheckpointsSince, listStreamCheckpointsForRunSpec, type StreamCheckpointRecord, type CreateStreamCheckpointInput } from './stream-checkpoints.js';
export { ensureStreamLeaseStore, acquireStreamLease, releaseStreamLease, heartbeatStreamLease, getActiveLease, type StreamLeaseRecord, type AcquireLeaseInput, type ReconnectInfo } from './stream-lease.js';
export { ensureTodoStore, archiveTodo, createTodo, updateTodo, loadTodo, listTodos, reopenTodo, seedLosPlanningTodos, unarchiveTodo, type CreateTodoInput, type ListTodosOptions, type TodoKind, type TodoPriority, type TodoRecord, type TodoStatus, type UpdateTodoInput, type SeedLosPlanningTodosOptions } from './todos.js';
export {
  ensureScheduledWorkStore, createScheduledWorkItem, loadScheduledWorkItem, listScheduledWorkItems,
  updateScheduledWorkItem, listScheduledWorkItemRuns, loadScheduledWorkItemRun,
  claimDueScheduledWorkItems, recoverExpiredScheduledWorkRuns, retryScheduledWorkRun,
  previewScheduledOccurrences, runScheduledWorkTick, triggerScheduledWorkItem, setupScheduledWorkWake,
  type ScheduledWorkItem, type ScheduledWorkItemRun, type ScheduledWorkTrigger,
  type ScheduledWorkRunTemplate, type CreateScheduledWorkItemInput, type UpdateScheduledWorkItemInput,
} from './scheduled-work/index.js';
export { deleteArtifact, ensureArtifactStore, listArtifacts, loadArtifact, putArtifact, readArtifactContent, type ArtifactOperation, type ArtifactPathPolicy, type ArtifactRecord, type ListArtifactsOptions, type PutArtifactInput } from './artifacts.js';
export { ensureNodeCommandStore, executeNodeCommand, listNodeCommands, loadNodeCommand, type ExecuteNodeCommandInput, type ListNodeCommandsOptions, type NodeCommandName, type NodeCommandRecord, type NodeCommandRuntime, type NodeCommandRuntimeContext, type NodeCommandRuntimeResult, type NodeCommandStatus } from './node-commands.js';
export { ensureSkillStore, upsertSkill, loadSkill, listSkills, deleteSkill, incrementSkillUsage, skillDirForScope, syncSkillsToDir, loadSkillsFromDir, type SkillRecord, type SkillRunMode, type SkillScope, type SkillLayer, type UpsertSkillInput } from './skills.js';
export { ensureRuleStore, upsertRule, loadRule, listRules, updateRuleStatus, deleteRule, ruleDirForScope, syncRulesToDir, loadRulesFromDir, type RuleRecord, type RuleScope, type RuleSeverity, type RuleEnforcementMode, type RuleStatus, type RuleLayer, type UpsertRuleInput } from './rules.js';
export { runPostExecutionSelfCheck, shouldRunSelfCheck, buildSelfCheckPrompt, parseSelfCheckResponse, summarizeAgentContext, buildReviewPacket, type SelfCheckGap, type SelfCheckInput, type SelfCheckResult, type ReviewPacket } from './self-check.js';
export { reflectOnFailure, formatReflectionSummary, type ReflectionResult } from './reflection.js';
export { scanProject, scanFiles, loadRuleFiles, discoverFiles, languageFromFilePath, buildStaticAnalysisPayload, type StaticAnalysisEventPayload, type StaticAnalysisFinding, type StaticAnalysisRule, type StaticAnalysisScanOptions, type StaticAnalysisScanResult, type StaticAnalysisConstraint, type StaticAnalysisRange, type StaticAnalysisPosition } from './static-analysis/index.js';

// ── OAuth ─────────────────────────────────────────────────
export { resolveXaiOAuthCredential, getXaiOAuthStatus, clearXaiOAuthTokens, loadXaiOAuthState, refreshXaiOAuthToken, XaiOAuthError, type XaiOAuthTokens, type XaiOAuthState, type XaiOAuthCredential, type XaiOAuthStatus, type XaiLoginOptions } from './auth/xai-oauth.js';

// ── Runtime adapter — external agent CLI integration ──────
export { startOtelBridge, isOtelBridgeRunning, spawnClaudeCode, runClaudeCodeWithBridge, claudeCodeSupportsOtel, claudeSpanToEventType, CLAUDE_CODE_SPAN_NAMES, spawnCodex, codexSupportsOtel, type OtelBridgeConfig, type ClaudeCodeSpawnInput, type CodexSpawnInput, type RuntimeKind, type RuntimeAdapterConfig, type RuntimeHandle } from './runtime-adapter/index.js';

// ── Pre-action gate — reusable by tool gate routes ─────
export {
  preActionGate,
  failureFingerprintForToolCall,
  failureFingerprintFromError,
  filePathFromToolArgs,
  preActionGateConfigFromAgentOptions,
  extractFragilitySignal,
  type AgentPreActionGateConfig,
  type PreActionCheck,
  type PreActionGateConfig,
} from './pre-action-gate.js';
export {
  _GLOBAL_PRE_ACTION_SESSION_ID,
  createPreActionFailureEvidence,
  loadPreActionEvidence,
  mergePreActionEvidence,
  _projectPreActionEvidence,
  type PreActionEvidenceScope,
  type PreActionFailureEvidence,
} from './pre-action-evidence.js';

// Re-export ast-grep types for rule authors
export type { Rule as AstGrepRule } from '@ast-grep/napi';

// ── Reserved for internal use only ──────────────────────────
// The following symbols are available via subpath imports but are NOT
// exported from the barrel.  Prefer subpath imports for:
//   @los/agent/tool-call-states      — internal state-machine audit trail
//   @los/agent/execution-store       — transitionExecutionState (low-level)
//   @los/agent/execution-transitions — raw state machine evaluation
//   @los/agent/governance-jobs       — background governance sweeper
//   @los/agent/governance-*          — governance subsystem internals
//   @los/agent/session-trace         — internal trace projection
//   @los/agent/providers/telemetry   — internal provider plumbing
//   @los/agent/providers/repair-telemetry
//   @los/agent/cancellation           — low-level abort primitives
//
// Internal and governance symbols removed from the barrel 2026-06-19:
//   ensureExecutionStore, transitionExecutionState,
//   ensureToolCallStateStore, createToolCallState, loadToolCallState, etc.
//   See package.json "exports" for subpath access.

export { runStorageDoctor, selfHeal, type DoctorReport, type CheckResult } from "./storage-doctor.js";
export {
  captureDailyAgentQuality, ensureDailyAgentQualityStore,
  getDailyAgentQualityBaseline, listDailyAgentQualityScopes,
  type DailyAgentQualityBaseline, type DailyAgentQualityEvidenceWindow,
  type DailyAgentQualitySnapshot,
} from './daily-agent-quality/index.js';
