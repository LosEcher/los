import { getConfig } from '@los/infra/config';
import {
  applyDirectRunCompletionStatus,
} from './chat-run-completion.js';
import {
  ensureSessionStore,
  loadRunSpec,
  runScheduledAgentTask,
  saveSession,
  type RunSpecRecord,
  type ScheduledAgentTaskResult,
} from '@los/agent';
import { transitionExecutionState } from '@los/agent/execution-store';
import { linkWorkItemRun, listWorkItemRunLinksForRunSpec } from '@los/agent/work-items';
import { updateTodo } from '@los/agent/todos';

export type PersistedRunDispatchMode = 'execution' | 'planning';

export interface PersistedRunDispatchResult {
  runSpecId: string;
  status: ScheduledAgentTaskResult['status'] | 'failed';
  taskRunId?: string;
  workItemId?: string;
  planRevision: number;
  error?: string;
}

export interface PersistedRunDispatchOptions {
  schedule?: typeof runScheduledAgentTask;
}

/**
 * Rehydrate a stored run request and send it through the normal scheduler.
 * The dedupe key is revision-scoped so approval and recovery are idempotent.
 */
export async function dispatchPersistedRunSpec(
  runSpecId: string,
  mode: PersistedRunDispatchMode,
  options: PersistedRunDispatchOptions = {},
): Promise<PersistedRunDispatchResult> {
  const runSpec = await loadRunSpec(runSpecId);
  if (!runSpec) throw new Error(`Run spec not found: ${runSpecId}`);
  const contract = runSpec.runContract;
  const planRevision = contract?.planRevision ?? 1;
  const links = await listWorkItemRunLinksForRunSpec(runSpecId);
  const workItemId = links[0]?.workItemId;
  const config = getConfig();
  const disposition = mode === 'planning' ? 'planning' : 'execution';
  const dedupeKey = `run:${runSpecId}:${mode}:${planRevision}`;

  const onTaskEvent = async (event: { type: string; taskRun: { id: string; runSpecId?: string; sessionId: string; status: string } }) => {
    if (workItemId) {
      await linkWorkItemRun({
        workItemId,
        runSpecId,
        taskRunId: event.taskRun.id,
        sessionId: event.taskRun.sessionId,
        relationKind: mode === 'planning' ? 'planning' : 'execution',
      }).catch(() => undefined);
      if (event.type === 'task.running') {
        await updateTodo(workItemId, { status: 'in_progress', taskRunId: event.taskRun.id, sessionId: event.taskRun.sessionId }).catch(() => undefined);
      }
      if (event.type === 'task.failed' || event.type === 'task.blocked') {
        await updateTodo(workItemId, {
          status: 'blocked', taskRunId: event.taskRun.id, sessionId: event.taskRun.sessionId,
          metadata: { dispatchSource: 'persisted-run-resume', lastDispatchEvent: event.type },
        }).catch(() => undefined);
      }
    }
  };

  let scheduled: ScheduledAgentTaskResult;
  try {
    if (mode === 'execution' && (runSpec.status === 'created' || runSpec.status === 'blocked')) {
      await transitionExecutionState({
        entityType: 'run_spec',
        entityId: runSpec.id,
        to: 'running',
        sessionId: runSpec.sessionId,
        commandId: runSpec.requestId,
        correlationId: runSpec.traceId,
        reason: 'persisted_run_resume_started',
      });
    }
    const schedule = options.schedule ?? runScheduledAgentTask;
    scheduled = await schedule({
      prompt: runSpec.prompt,
      sessionId: runSpec.sessionId,
      runSpecId: runSpec.id,
      provider: runSpec.provider,
      model: runSpec.model,
      modelSettings: runSpec.modelSettings,
      systemPrompt: runSpec.systemPrompt,
      workspaceRoot: runSpec.workspaceRoot,
      toolMode: runSpec.toolMode as 'all' | 'project-write' | 'read-only',
      sandboxMode: (config as any).agent?.sandboxMode as 'readonly' | 'workspace-write' | 'sandbox' | undefined,
      allowedTools: runSpec.allowedTools,
      maxLoops: runSpec.maxLoops,
      timeoutMs: runSpec.timeoutMs,
      toolRetry: runSpec.toolRetry,
      mcpServers: runSpec.mcpServers,
      traceId: runSpec.traceId,
      requestId: runSpec.requestId,
      tenantId: runSpec.tenantId,
      projectId: runSpec.projectId,
      userId: runSpec.userId,
      runContract: runSpec.runContract,
      disposition,
      dedupeKey,
      metadata: { dispatchSource: 'persisted-run-resume', mode, planRevision },
      executor: {
        enabled: config.executor.enabled,
        nodeUrls: config.executor.meshNodes,
        agentKey: config.executor.agentKey,
        nodeId: config.executor.nodeId,
      },
      onTaskEvent,
    });
  } catch (error) {
    await markRunSpecFailed(runSpec, error instanceof Error ? error.message : String(error));
    return { runSpecId, status: 'failed', workItemId, planRevision, error: error instanceof Error ? error.message : String(error) };
  }

  if ('taskRun' in scheduled && scheduled.taskRun) {
    if (scheduled.status === 'completed' || scheduled.status === 'blocked') {
      await applyDirectRunCompletionStatus({
        runSpecId,
        sessionId: runSpec.sessionId,
        tenantId: runSpec.tenantId,
        projectId: runSpec.projectId,
        userId: runSpec.userId,
        nodeId: scheduled.taskRun.nodeId,
        requestId: runSpec.requestId,
        traceId: runSpec.traceId,
        taskRunId: scheduled.taskRun.id,
      });
      if (scheduled.status === 'completed' && 'result' in scheduled) {
        await ensureSessionStore().then(() => saveSession({
          id: runSpec.sessionId,
          tenantId: runSpec.tenantId,
          projectId: runSpec.projectId,
          userId: runSpec.userId,
          requestId: runSpec.requestId,
          traceId: runSpec.traceId,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          messages: scheduled.result.messages,
          turns: scheduled.result.turns,
          metadata: { runSpecId, taskRunId: scheduled.taskRun.id, resumed: true, mode },
        }));
      }
    } else if (scheduled.status === 'cancelled') {
      await transitionExecutionState({ entityType: 'run_spec', entityId: runSpecId, to: 'cancelled', sessionId: runSpec.sessionId, reason: 'persisted_run_resume_cancelled' }).catch(() => undefined);
    }
    return { runSpecId, status: scheduled.status, taskRunId: scheduled.taskRun.id, workItemId, planRevision };
  }
  return { runSpecId, status: scheduled.status, workItemId, planRevision };
}

async function markRunSpecFailed(runSpec: RunSpecRecord, reason: string): Promise<void> {
  if (runSpec.status === 'created' || runSpec.status === 'blocked' || runSpec.status === 'running') {
    if (runSpec.status === 'created' || runSpec.status === 'blocked') {
      await transitionExecutionState({ entityType: 'run_spec', entityId: runSpec.id, to: 'running', sessionId: runSpec.sessionId, reason: 'persisted_run_resume_started' }).catch(() => undefined);
    }
    await transitionExecutionState({ entityType: 'run_spec', entityId: runSpec.id, to: 'failed', sessionId: runSpec.sessionId, reason }).catch(() => undefined);
  }
}
