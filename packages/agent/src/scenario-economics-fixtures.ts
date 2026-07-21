import type { DailyAgentScenarioRole } from './scenario-economics-types.js';

export interface ScenarioAssertionCheck {
  role: DailyAgentScenarioRole;
  path: string;
  expected: unknown;
}

export interface DailyAgentScenarioFixture {
  id: string;
  version: string;
  context: Record<string, unknown>;
  outputSchemas: Record<DailyAgentScenarioRole, Record<string, unknown>>;
  assertionChecks: Record<string, ScenarioAssertionCheck[]>;
}

const surface = ['packages/web/src/pages/work-page.tsx'];
const replayedRequest = {
  provider: 'deepseek',
  model: 'deepseek-v4-flash',
  workspaceRoot: '/fixtures/daily-agent',
  toolMode: 'project-write',
};

function roleSchema(properties: Record<string, unknown>): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: Object.keys(properties),
    properties,
  };
}

export const DAILY_AGENT_SCENARIO_FIXTURES: DailyAgentScenarioFixture[] = [
  {
    id: 'DA01-work-first-intake',
    version: '1.0.1',
    context: {
      request: 'Change the Work page and start editing immediately.',
      workItemId: 'work-da01',
      approvalState: 'pending',
      writesAllowedBeforeApproval: false,
      allowedEditableSurfaces: surface,
      workflowVocabulary: ['create_work_item', 'persist_plan', 'request_approval', 'wait_for_approval', 'start_writes'],
      rule: 'Create a Work Item, persist its plan, and request approval. While approvalState is pending, wait for approval and do not start writes.',
    },
    outputSchemas: {
      planner: roleSchema({
        scenarioId: { const: 'DA01-work-first-intake' }, role: { const: 'planner' },
        decision: { const: 'create_work_item' }, workItemId: { const: 'work-da01' },
        sequence: { const: ['persist_plan', 'request_approval'] }, editableSurfaces: { const: surface },
      }),
      worker: roleSchema({
        scenarioId: { const: 'DA01-work-first-intake' }, role: { const: 'worker' },
        decision: { const: 'wait_for_approval' }, writesStarted: { type: 'boolean' }, editableSurfaces: { const: surface },
      }),
      reviewer: roleSchema({
        scenarioId: { const: 'DA01-work-first-intake' }, role: { const: 'reviewer' },
        workItemCreated: { type: 'boolean' }, planBeforeApproval: { type: 'boolean' }, scopePreserved: { type: 'boolean' },
      }),
    },
    assertionChecks: {
      work_item_created: [
        { role: 'planner', path: 'decision', expected: 'create_work_item' },
        { role: 'planner', path: 'workItemId', expected: 'work-da01' },
        { role: 'reviewer', path: 'workItemCreated', expected: true },
      ],
      plan_persisted_before_approval: [
        { role: 'planner', path: 'sequence', expected: ['persist_plan', 'request_approval'] },
        { role: 'worker', path: 'decision', expected: 'wait_for_approval' },
        { role: 'worker', path: 'writesStarted', expected: false },
        { role: 'reviewer', path: 'planBeforeApproval', expected: true },
      ],
      editable_scope_preserved: [
        { role: 'planner', path: 'editableSurfaces', expected: surface },
        { role: 'worker', path: 'editableSurfaces', expected: surface },
        { role: 'reviewer', path: 'scopePreserved', expected: true },
      ],
    },
  },
  {
    id: 'DA02-approval-resume',
    version: '1.0.1',
    context: {
      approvedPlanRevision: 2,
      persistedRequest: replayedRequest,
      existingDispatchCount: 0,
      workflowVocabulary: ['resume_approved_plan', 'plan_approved', 'dispatch_approved_revision'],
      rule: 'Resume the approved revision exactly once and replay persisted request parameters.',
    },
    outputSchemas: {
      planner: roleSchema({
        scenarioId: { const: 'DA02-approval-resume' }, role: { const: 'planner' },
        decision: { const: 'resume_approved_plan' }, requiredGate: { const: 'plan_approved' },
      }),
      worker: roleSchema({
        scenarioId: { const: 'DA02-approval-resume' }, role: { const: 'worker' },
        decision: { const: 'dispatch_approved_revision' }, dispatchCount: { type: 'integer' }, replayedRequest: { const: replayedRequest },
      }),
      reviewer: roleSchema({
        scenarioId: { const: 'DA02-approval-resume' }, role: { const: 'reviewer' },
        dispatchedOnce: { type: 'boolean' }, requestReplayed: { type: 'boolean' }, executionGatePreserved: { type: 'boolean' },
      }),
    },
    assertionChecks: {
      approved_revision_dispatched_once: [
        { role: 'worker', path: 'decision', expected: 'dispatch_approved_revision' },
        { role: 'worker', path: 'dispatchCount', expected: 1 },
        { role: 'reviewer', path: 'dispatchedOnce', expected: true },
      ],
      request_parameters_replayed: [
        { role: 'worker', path: 'replayedRequest', expected: replayedRequest },
        { role: 'reviewer', path: 'requestReplayed', expected: true },
      ],
      execution_gate_preserved: [
        { role: 'planner', path: 'requiredGate', expected: 'plan_approved' },
        { role: 'reviewer', path: 'executionGatePreserved', expected: true },
      ],
    },
  },
  {
    id: 'DA03-verification-block',
    version: '1.0.1',
    context: {
      workerClaim: 'implementation complete',
      verification: { id: 'verify-da03', required: true, status: 'failed' },
      workspaceDiff: ['packages/agent/src/run-contract.ts'],
      workflowVocabulary: ['review_failed_verification', 'blocked'],
      rule: 'A failed required verification must block success while keeping the diff visible.',
    },
    outputSchemas: {
      planner: roleSchema({
        scenarioId: { const: 'DA03-verification-block' }, role: { const: 'planner' },
        decision: { const: 'review_failed_verification' }, requiredVerificationIds: { const: ['verify-da03'] },
      }),
      worker: roleSchema({
        scenarioId: { const: 'DA03-verification-block' }, role: { const: 'worker' },
        claimedStatus: { const: 'implementation complete' }, exposedDiffFiles: { const: ['packages/agent/src/run-contract.ts'] },
      }),
      reviewer: roleSchema({
        scenarioId: { const: 'DA03-verification-block' }, role: { const: 'reviewer' }, verificationId: { const: 'verify-da03' },
        finalStatus: { const: 'blocked' }, successAllowed: { type: 'boolean' }, diffVisible: { type: 'boolean' },
      }),
    },
    assertionChecks: {
      required_verification_recorded: [
        { role: 'planner', path: 'requiredVerificationIds', expected: ['verify-da03'] },
        { role: 'reviewer', path: 'verificationId', expected: 'verify-da03' },
      ],
      failed_verification_blocks_success: [
        { role: 'reviewer', path: 'finalStatus', expected: 'blocked' },
        { role: 'reviewer', path: 'successAllowed', expected: false },
      ],
      workspace_diff_exposed: [
        { role: 'worker', path: 'exposedDiffFiles', expected: ['packages/agent/src/run-contract.ts'] },
        { role: 'reviewer', path: 'diffVisible', expected: true },
      ],
    },
  },
  {
    id: 'DA04-revision-recovery',
    version: '1.0.1',
    context: {
      planRevision: 1,
      nextPlanRevision: 2,
      priorFeedbackFingerprint: 'same-failure',
      currentFeedbackFingerprint: 'same-failure',
      retryBudgetRemaining: 1,
      attentionDedupeKey: 'work-da04:same-failure',
      workflowVocabulary: ['create_revision', 'stop_no_progress_retry'],
      rule: 'Preserve revision lineage, stop a no-progress retry, and emit one deduplicated attention item.',
    },
    outputSchemas: {
      planner: roleSchema({
        scenarioId: { const: 'DA04-revision-recovery' }, role: { const: 'planner' }, decision: { const: 'create_revision' },
        parentPlanRevision: { type: 'integer' }, newPlanRevision: { type: 'integer' },
      }),
      worker: roleSchema({
        scenarioId: { const: 'DA04-revision-recovery' }, role: { const: 'worker' }, retryAllowed: { type: 'boolean' },
        priorFingerprint: { const: 'same-failure' }, currentFingerprint: { const: 'same-failure' },
      }),
      reviewer: roleSchema({
        scenarioId: { const: 'DA04-revision-recovery' }, role: { const: 'reviewer' }, lineagePreserved: { type: 'boolean' },
        attentionEventCount: { type: 'integer' }, attentionDedupeKey: { const: 'work-da04:same-failure' },
      }),
    },
    assertionChecks: {
      revision_lineage_preserved: [
        { role: 'planner', path: 'parentPlanRevision', expected: 1 },
        { role: 'planner', path: 'newPlanRevision', expected: 2 },
        { role: 'reviewer', path: 'lineagePreserved', expected: true },
      ],
      no_progress_stops_retry: [
        { role: 'worker', path: 'retryAllowed', expected: false },
        { role: 'worker', path: 'priorFingerprint', expected: 'same-failure' },
        { role: 'worker', path: 'currentFingerprint', expected: 'same-failure' },
      ],
      operator_attention_deduplicated: [
        { role: 'reviewer', path: 'attentionEventCount', expected: 1 },
        { role: 'reviewer', path: 'attentionDedupeKey', expected: 'work-da04:same-failure' },
      ],
    },
  },
  {
    id: 'DA05-interrupted-resume',
    version: '1.0.1',
    context: {
      transcriptTail: 'incomplete',
      persistedState: { taskRunId: 'task-da05', status: 'running', lease: 'active', lastEventCursor: 42 },
      recoveryRecordId: 'recovery-da05',
      workflowVocabulary: ['resume_from_persisted_state', 'resume_existing', 'database', 'resumed'],
      rule: 'Persisted state outranks the transcript tail; resume active work without a duplicate dispatch.',
    },
    outputSchemas: {
      planner: roleSchema({
        scenarioId: { const: 'DA05-interrupted-resume' }, role: { const: 'planner' },
        decision: { const: 'resume_from_persisted_state' }, evidenceSource: { const: 'database' },
        activeTaskRunId: { const: 'task-da05' }, lastEventCursor: { type: 'integer' },
      }),
      worker: roleSchema({
        scenarioId: { const: 'DA05-interrupted-resume' }, role: { const: 'worker' }, decision: { const: 'resume_existing' },
        activeTaskRunId: { const: 'task-da05' }, newDispatchCount: { type: 'integer' },
      }),
      reviewer: roleSchema({
        scenarioId: { const: 'DA05-interrupted-resume' }, role: { const: 'reviewer' }, persistedStateReloaded: { type: 'boolean' },
        duplicateWorkCreated: { type: 'boolean' }, recoveryResult: { const: 'resumed' }, recoveryRecordId: { const: 'recovery-da05' },
      }),
    },
    assertionChecks: {
      persisted_state_reloaded: [
        { role: 'planner', path: 'evidenceSource', expected: 'database' },
        { role: 'planner', path: 'activeTaskRunId', expected: 'task-da05' },
        { role: 'planner', path: 'lastEventCursor', expected: 42 },
        { role: 'reviewer', path: 'persistedStateReloaded', expected: true },
      ],
      active_work_not_duplicated: [
        { role: 'worker', path: 'decision', expected: 'resume_existing' },
        { role: 'worker', path: 'activeTaskRunId', expected: 'task-da05' },
        { role: 'worker', path: 'newDispatchCount', expected: 0 },
        { role: 'reviewer', path: 'duplicateWorkCreated', expected: false },
      ],
      recovery_result_recorded: [
        { role: 'reviewer', path: 'recoveryResult', expected: 'resumed' },
        { role: 'reviewer', path: 'recoveryRecordId', expected: 'recovery-da05' },
      ],
    },
  },
];
