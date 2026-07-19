import { readRunContractMetadata, type RunContractMetadata } from '../run-contract.js';
import { listRunSpecsForSession, loadRunSpec } from '../run-specs.js';
import { listTaskRunsForRunSpec, loadTaskRun, type TaskRunRecord } from '../task-runs.js';
import { createTodo, listTodos, loadTodo } from '../todos.js';
import { listVerificationRecordsForRunSpec } from '../verification-records.js';
import { listManagedWorkspacesForRunSpec } from '../managed-workspace-store.js';
import { loadFeedAnalysisEvidenceForWorkItem } from '../integration/feed-analysis-work-item.js';
import {
  listOrphanRuntimeEvidence,
  listWorkItemRunLinks,
} from './store.js';
import { readWorkItemResultReview } from './result-review-metadata.js';
import { readScheduledWorkMetadata } from './scheduled-work-metadata.js';
import { projectInboxEntries } from './inbox.js';
import type {
  CreateWorkItemInput,
  InboxEntry,
  ListWorkItemsOptions,
  WorkItemAttentionState,
  WorkItemMode,
  WorkItemNextAction,
  WorkItemProjection,
  WorkItemProjectionInput,
  WorkItemRunLink,
  WorkItemVerificationCoverage,
  WorkItemVerificationEvidence,
  WorkItemWorkspaceEvidence,
} from './types.js';

export async function createWorkItem(input: CreateWorkItemInput): Promise<WorkItemProjection> {
  const goal = normalizeRequired(input.goal, 'goal');
  const todo = await createTodo({
    tenantId: input.tenantId ?? 'local',
    projectId: normalizeRequired(input.projectId, 'projectId'),
    userId: normalizeOptional(input.userId),
    title: normalizeOptional(input.title) ?? boundedTitle(goal),
    description: normalizeOptional(input.description) ?? goal,
    kind: 'task',
    status: 'backlog',
    priority: input.priority ?? 'P2',
    source: 'web-work-item',
    runContract: {
      mode: input.mode,
      phase: 'created',
      goal,
      editableSurfaces: normalizeArray(input.editableSurfaces),
      requiredChecks: normalizeArray(input.requiredChecks),
      stopConditions: normalizeArray(input.stopConditions),
      evidenceRequired: normalizeArray(input.evidenceRequired ?? []),
      toolMode: input.toolMode ?? 'read-only',
      externalEvidenceAllowed: [],
      rawEvidenceProhibited: [],
    },
    metadata: {
      nonGoals: normalizeArray(input.nonGoals ?? []),
      createdFrom: 'work-items-api',
    },
  });
  return projectPersistedWorkItem(todo);
}

export async function loadWorkItemProjection(id: string): Promise<WorkItemProjection | null> {
  const todo = await loadTodo(id);
  return todo ? projectPersistedWorkItem(todo) : null;
}

export async function listWorkItemProjections(
  options: ListWorkItemsOptions = {},
): Promise<WorkItemProjection[]> {
  const limit = Math.min(1000, Math.max(1, options.limit ?? 50));
  const todos = await listTodos({
    tenantId: options.tenantId,
    projectId: options.projectId,
    status: options.status,
    excludeTerminal: options.excludeTerminal,
    limit,
  });
  return Promise.all(todos.map(projectPersistedWorkItem));
}

export async function listInboxEntries(options: {
  tenantId?: string;
  projectId?: string;
  limit?: number;
} = {}): Promise<InboxEntry[]> {
  const limit = Math.min(1000, Math.max(1, options.limit ?? 50));
  const [workItems, orphans] = await Promise.all([
    listWorkItemProjections({ ...options, limit, excludeTerminal: true }),
    listOrphanRuntimeEvidence({ projectId: options.projectId, limit }),
  ]);
  return projectInboxEntries(workItems, orphans, limit);
}

export async function getWorkItemVerificationCoverage(options: {
  tenantId?: string;
  projectId: string;
  mode?: WorkItemMode;
}): Promise<WorkItemVerificationCoverage> {
  const items = (await listWorkItemProjections({
    tenantId: options.tenantId,
    projectId: options.projectId,
    limit: 1000,
  })).filter(item => !options.mode || item.runContractDraft.mode === options.mode);
  const totals = items.reduce((summary, item) => ({
    required: summary.required + item.evidence.verificationRequired,
    succeeded: summary.succeeded + item.evidence.verificationSucceeded,
    skipped: summary.skipped + item.evidence.verificationSkipped,
    failed: summary.failed + item.evidence.verificationFailed,
    pending: summary.pending + item.evidence.verificationPending,
  }), { required: 0, succeeded: 0, skipped: 0, failed: 0, pending: 0 });
  const recorded = totals.succeeded + totals.skipped + totals.failed + totals.pending;
  const missing = Math.max(0, totals.required - recorded);
  const covered = totals.succeeded + totals.skipped;
  return {
    projectId: options.projectId,
    mode: options.mode ?? 'all',
    workItems: items.length,
    ...totals,
    missing,
    coverage: totals.required === 0 ? 1 : covered / totals.required,
  };
}

export function _projectWorkItem(input: WorkItemProjectionInput): WorkItemProjection {
  const contract = input.runContract ?? readRunContractMetadata(input.todo.metadata) ?? emptyContract();
  const latestTask = [...input.taskRuns].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  const requiredRecords = input.verificationStatuses.filter(record => record.required);
  const expectedVerification = contract.requiredChecks.length;
  const verificationFailed = requiredRecords.filter(record => record.status === 'failed').length;
  const verificationSucceeded = requiredRecords.filter(record => record.status === 'succeeded').length;
  const verificationSkipped = requiredRecords.filter(record => record.status === 'skipped').length;
  const recordedPending = requiredRecords.filter(record => record.status === 'required' || record.status === 'running').length;
  const missing = Math.max(0, expectedVerification - requiredRecords.length);
  const evidence = {
    latestRunSpecId: input.runSpec?.id,
    latestTaskRunId: latestTask?.id,
    latestSessionId: input.runSpec?.sessionId ?? latestTask?.sessionId,
    runSpecStatus: input.runSpec?.status,
    taskRunStatus: latestTask?.status,
    verificationRequired: Math.max(expectedVerification, requiredRecords.length),
    verificationSucceeded,
    verificationSkipped,
    verificationFailed,
    verificationPending: recordedPending + missing,
  };
  const attentionState = _classifyWorkItemAttention({
    todoStatus: input.todo.status,
    phase: input.runSpec?.phase,
    runSpecStatus: input.runSpec?.status,
    taskRunStatus: latestTask?.status,
    hasRunEvidence: Boolean(input.runSpec || latestTask),
    verificationFailed,
    verificationPending: evidence.verificationPending,
    scheduledRunStatus: readScheduledWorkMetadata(input.todo.metadata)?.status,
    feedAnalysis: input.feedAnalysis,
  });
  return {
    id: input.todo.id,
    title: input.todo.title,
    description: input.todo.description,
    goal: contract.goal ?? input.todo.description ?? input.todo.title,
    tenantId: input.todo.tenantId,
    projectId: input.todo.projectId,
    userId: input.todo.userId,
    status: input.todo.status,
    priority: input.todo.priority,
    source: input.todo.source,
    runContractDraft: contract,
    attentionState,
    nextAction: nextActionFor(attentionState, Boolean(input.runSpec || latestTask), input.todo.status),
    links: input.links,
    evidence,
    verificationRecords: input.verificationStatuses,
    changes: {
      hasReviewableDiff: (input.managedWorkspaces ?? []).some(workspace => Boolean(workspace.backupArtifactId)),
      workspaces: input.managedWorkspaces ?? [],
      resultReview: readWorkItemResultReview(input.todo.metadata.resultReview),
    },
    scheduledWork: readScheduledWorkMetadata(input.todo.metadata),
    feedAnalysis: input.feedAnalysis,
    createdAt: input.todo.createdAt,
    updatedAt: latestTimestamp([
      input.todo.updatedAt,
      input.runSpec?.updatedAt,
      latestTask?.updatedAt,
      input.links[0]?.updatedAt,
      input.feedAnalysis?.updatedAt,
    ]),
  };
}

export function _classifyWorkItemAttention(input: {
  todoStatus: string;
  phase?: string;
  runSpecStatus?: string;
  taskRunStatus?: string;
  hasRunEvidence: boolean;
  verificationFailed: number;
  verificationPending: number;
  scheduledRunStatus?: 'awaiting_approval' | 'succeeded' | 'failed';
  feedAnalysis?: WorkItemProjectionInput['feedAnalysis'];
}): WorkItemAttentionState {
  if (input.todoStatus === 'done' || input.todoStatus === 'cancelled') return 'none';
  if (input.scheduledRunStatus === 'awaiting_approval') return 'approval_required';
  if (input.scheduledRunStatus === 'failed') return 'recovery_required';
  if (input.scheduledRunStatus === 'succeeded') return 'review_ready';
  if (input.feedAnalysis?.callback.deadLetterCount) return 'recovery_required';
  if (input.feedAnalysis?.dispatchStatus === 'completed' && !input.feedAnalysis.resultAvailable) {
    return 'verification_blocked';
  }
  if (input.feedAnalysis?.dispatchStatus === 'failed') return 'recovery_required';
  if (input.feedAnalysis?.dispatchStatus === 'cancelled') return 'none';
  if (input.feedAnalysis?.dispatchStatus === 'completed') return 'review_ready';
  if (input.feedAnalysis) return 'running';
  if (input.phase === 'planning' || input.phase === 'discovery_ready') return 'approval_required';
  const verificationPhase = input.phase === 'verifying' || input.phase === 'blocked' || input.phase === 'succeeded';
  if (input.verificationFailed > 0 || (verificationPhase && input.verificationPending > 0)) {
    return 'verification_blocked';
  }
  if (
    input.taskRunStatus === 'failed'
    || input.taskRunStatus === 'blocked'
    || input.runSpecStatus === 'failed'
    || input.runSpecStatus === 'blocked'
  ) return 'recovery_required';
  if (
    input.taskRunStatus === 'queued'
    || input.taskRunStatus === 'running'
    || input.runSpecStatus === 'running'
  ) return 'running';
  if (
    input.taskRunStatus === 'succeeded'
    || input.runSpecStatus === 'succeeded'
    || input.phase === 'succeeded'
  ) return 'review_ready';
  return input.hasRunEvidence ? 'unknown' : 'none';
}

async function projectPersistedWorkItem(todo: Awaited<ReturnType<typeof loadTodo>> extends infer T ? Exclude<T, null> : never): Promise<WorkItemProjection> {
  const storedLinks = await listWorkItemRunLinks(todo.id);
  const links = withLegacyLink(todo, storedLinks);
  const latest = links[0];
  let task = latest?.taskRunId ? await loadTaskRun(latest.taskRunId) : null;
  let runSpecId = latest?.runSpecId ?? task?.runSpecId;
  if (!runSpecId && (latest?.sessionId ?? todo.sessionId)) {
    const [sessionRun] = await listRunSpecsForSession(latest?.sessionId ?? todo.sessionId!, 1);
    runSpecId = sessionRun?.id;
  }
  const runSpec = runSpecId ? await loadRunSpec(runSpecId) : null;
  const taskRuns = runSpec
    ? await listTaskRunsForRunSpec(runSpec.id)
    : task
      ? [task]
      : [];
  task ??= latestTaskRun(taskRuns) ?? null;
  const [verificationRecords, managedWorkspaces, feedAnalysis] = runSpec
    ? await Promise.all([
        listVerificationRecordsForRunSpec(runSpec.id),
        listManagedWorkspacesForRunSpec(runSpec.id),
        loadFeedAnalysisEvidenceForWorkItem(todo.id),
      ])
    : [[], [], await loadFeedAnalysisEvidenceForWorkItem(todo.id)];
  return _projectWorkItem({
    todo,
    links,
    runContract: readRunContractMetadata(todo.metadata),
    runSpec: runSpec ? {
      id: runSpec.id,
      sessionId: runSpec.sessionId,
      status: runSpec.status,
      phase: runSpec.runContract?.phase,
      updatedAt: runSpec.updatedAt,
    } : undefined,
    taskRuns,
    verificationStatuses: verificationRecords.map(toVerificationEvidence),
    managedWorkspaces: managedWorkspaces.map(toWorkspaceEvidence),
    feedAnalysis,
  });
}

function toVerificationEvidence(record: Awaited<ReturnType<typeof listVerificationRecordsForRunSpec>>[number]): WorkItemVerificationEvidence {
  return {
    id: record.id,
    checkName: record.checkName,
    kind: record.kind,
    status: record.status,
    required: record.required,
    command: record.command,
    assertion: record.assertion,
    reviewer: record.reviewer,
    skipReason: record.skipReason,
    outputSummary: record.outputSummary,
    error: record.error,
    updatedAt: record.updatedAt,
    completedAt: record.completedAt,
  };
}

function toWorkspaceEvidence(workspace: Awaited<ReturnType<typeof listManagedWorkspacesForRunSpec>>[number]): WorkItemWorkspaceEvidence {
  return {
    workspaceId: workspace.workspaceId,
    status: workspace.status,
    baseRevision: workspace.baseRevision,
    backupArtifactId: workspace.backupArtifactId,
    updatedAt: workspace.updatedAt,
    releasedAt: workspace.releasedAt,
  };
}

function withLegacyLink(todo: NonNullable<Awaited<ReturnType<typeof loadTodo>>>, links: WorkItemRunLink[]): WorkItemRunLink[] {
  if (!todo.taskRunId && !todo.sessionId) return links;
  if (links.some(link => link.taskRunId === todo.taskRunId || link.sessionId === todo.sessionId)) return links;
  return [{
    id: `legacy-${todo.id}`,
    workItemId: todo.id,
    taskRunId: todo.taskRunId,
    sessionId: todo.sessionId,
    relationKind: 'execution',
    createdAt: todo.createdAt,
    updatedAt: todo.updatedAt,
  }, ...links];
}

function latestTaskRun(tasks: TaskRunRecord[]): TaskRunRecord | undefined {
  return [...tasks].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
}

function nextActionFor(
  attention: WorkItemAttentionState,
  hasRunEvidence: boolean,
  todoStatus: string,
): WorkItemNextAction {
  if (attention === 'approval_required') return 'review_plan';
  if (attention === 'verification_blocked') return 'inspect_verification';
  if (attention === 'recovery_required') return 'recover';
  if (attention === 'running' || attention === 'unknown') return 'inspect_run';
  if (attention === 'review_ready') return 'review_changes';
  if (!hasRunEvidence && todoStatus !== 'done' && todoStatus !== 'cancelled') return 'start';
  return 'none';
}

function emptyContract(): RunContractMetadata {
  return {
    editableSurfaces: [],
    requiredChecks: [],
    allowedSkippedChecks: [],
    stopConditions: [],
    evidenceRequired: [],
    externalEvidenceAllowed: [],
    rawEvidenceProhibited: [],
  };
}

function normalizeRequired(value: string, field: string): string {
  const normalized = normalizeOptional(value);
  if (!normalized) throw new Error(`${field} is required`);
  return normalized;
}

function normalizeOptional(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

function normalizeArray(values: string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))];
}

function boundedTitle(goal: string): string {
  return goal.length <= 120 ? goal : `${goal.slice(0, 117)}...`;
}

function latestTimestamp(values: Array<string | undefined>): string {
  return values.filter((value): value is string => Boolean(value)).sort().at(-1)!;
}
