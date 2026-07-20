import { appendSessionEvent } from '../session-events.js';
import { createRunSpec, loadRunSpec, reviseRunSpecPlan } from '../run-specs.js';
import { updateTodo } from '../todos.js';
import { linkWorkItemRun, listWorkItemRunLinksForRunSpec } from './store.js';
import { loadWorkItemProjection } from './projection.js';
import type { PlanStep, RunContractMetadata } from '../run-contract.js';

const MAX_AUTOMATIC_REVISIONS = 3;

export interface WorkItemRevisionResult {
  workItemId: string;
  runSpecId: string;
  previousRunSpecId: string;
  planRevision: number;
  exhausted: boolean;
}

/** Persist one bounded recovery iteration and leave it in planning for approval. */
export async function createWorkItemRevision(input: {
  runSpecId: string;
  reason: string;
  actor?: string;
  trigger: 'verification_failed' | 'revision_requested';
}): Promise<WorkItemRevisionResult> {
  const links = await listWorkItemRunLinksForRunSpec(input.runSpecId);
  const workItemId = links[0]?.workItemId;
  if (!workItemId) throw new Error(`Run spec ${input.runSpecId} is not bound to a Work Item`);
  const projection = await loadWorkItemProjection(workItemId);
  if (!projection?.evidence.latestRunSpecId) throw new Error(`Work Item ${workItemId} has no persisted run spec`);
  const current = await loadRunSpec(projection.evidence.latestRunSpecId);
  if (!current?.runContract?.plan?.length) throw new Error(`Run spec ${projection.evidence.latestRunSpecId} has no structured plan`);

  const currentRevision = current.runContract.planRevision ?? 1;
  const nextRevision = currentRevision + 1;
  if (nextRevision > MAX_AUTOMATIC_REVISIONS) {
    await appendSessionEvent({
      sessionId: current.sessionId,
      tenantId: current.tenantId,
      projectId: current.projectId,
      userId: current.userId,
      requestId: current.requestId,
      traceId: current.traceId,
      type: 'run.operator_attention_required',
      source: 'los.revision-loop',
      payload: { runSpecId: current.id, workItemId, trigger: input.trigger, reason: input.reason, planRevision: currentRevision, maxAutomaticRevisions: MAX_AUTOMATIC_REVISIONS },
    });
    return { workItemId, runSpecId: current.id, previousRunSpecId: current.id, planRevision: currentRevision, exhausted: true };
  }

  const plan = appendRecoveryStep(current.runContract.plan, current.runContract, input.reason, nextRevision);
  const revisionBase = { plan, actor: input.actor ?? 'operator', reason: input.reason };
  const canReviseInPlace = current.runContract.phase === 'blocked'
    || current.runContract.phase === 'planning'
    || current.runContract.phase === 'plan_approved';
  const revised = canReviseInPlace
    ? await reviseRunSpecPlan(current.id, revisionBase)
    : await createChildRevision(current, plan, nextRevision, input);
  const revisedId = revised.id;

  await linkWorkItemRun({ workItemId, runSpecId: revisedId, sessionId: revised.sessionId, relationKind: 'recovery' });
  await updateTodo(workItemId, {
    status: 'in_progress',
    sessionId: revised.sessionId,
    metadata: { revisionLoop: { trigger: input.trigger, reason: input.reason, planRevision: nextRevision, previousRunSpecId: current.id, updatedAt: new Date().toISOString() } },
  });
  await appendSessionEvent({
    sessionId: revised.sessionId,
    tenantId: revised.tenantId,
    projectId: revised.projectId,
    userId: revised.userId,
    requestId: revised.requestId,
    traceId: revised.traceId,
    type: 'run.revision_requested',
    source: 'los.revision-loop',
    payload: { runSpecId: revisedId, previousRunSpecId: current.id, workItemId, trigger: input.trigger, reason: input.reason, planRevision: nextRevision },
  });
  return { workItemId, runSpecId: revisedId, previousRunSpecId: current.id, planRevision: nextRevision, exhausted: false };
}

function appendRecoveryStep(plan: PlanStep[], contract: RunContractMetadata, reason: string, revision: number): PlanStep[] {
  const id = `recovery-${revision}`;
  const dependencyIds = plan.map(step => step.id);
  return [
    ...plan,
    {
      id,
      title: 'Address verification feedback',
      description: `Resolve the persisted verification or review feedback: ${reason}`,
      dependsOnIds: dependencyIds,
      editableSurfaces: [...new Set(contract.editableSurfaces)],
      completionCriteria: `The feedback is resolved and the required checks pass for revision ${revision}.`,
    },
  ];
}

async function createChildRevision(
  current: NonNullable<Awaited<ReturnType<typeof loadRunSpec>>>,
  plan: PlanStep[],
  revision: number,
  input: { reason: string; actor?: string },
) {
  if (!current.runContract) throw new Error(`Run spec ${current.id} has no run contract`);
  const id = `${current.id}:revision:${revision}`;
  const contract = {
    ...current.runContract,
    phase: 'planning' as const,
    previousPhase: current.runContract.phase,
    plan,
    planRevision: revision,
    planParentRevision: current.runContract.planRevision ?? 1,
    planParentRunSpecId: current.id,
    planHistory: [
      ...(current.runContract.planHistory ?? []),
      {
        revision: current.runContract.planRevision ?? 1,
        plan: current.runContract.plan,
        requiredChecks: current.runContract.requiredChecks,
        verifications: current.runContract.verifications ?? [],
        supersededAt: new Date().toISOString(),
        actor: input.actor,
        reason: input.reason,
      },
    ],
  };
  return await createRunSpec({
    id,
    sessionId: `${current.sessionId}:revision:${revision}`,
    tenantId: current.tenantId,
    projectId: current.projectId,
    userId: current.userId,
    nodeId: current.nodeId,
    requestId: current.requestId,
    traceId: current.traceId,
    prompt: current.prompt,
    systemPrompt: current.systemPrompt,
    provider: current.provider as any,
    model: current.model as any,
    modelSettings: current.modelSettings,
    workspaceRoot: current.workspaceRoot,
    toolMode: current.toolMode,
    allowedTools: current.allowedTools,
    toolRetry: current.toolRetry,
    maxLoops: current.maxLoops,
    timeoutMs: current.timeoutMs,
    mcpServers: current.mcpServers,
    runContract: contract,
  });
}
