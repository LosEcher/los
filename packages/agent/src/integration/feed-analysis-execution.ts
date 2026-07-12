import { runScheduledAgentTask, type ScheduledTaskEvent } from '../scheduler.js';
import {
  emitFeedAnalysisStatus,
  loadFeedAnalysisDispatch,
  saveFeedAnalysisResult,
  updateFeedAnalysisTaskRun,
} from './feed-analysis-store.js';
import { emitFeedAnalysisProgress } from './feed-analysis-progress.js';
import { FeedAnalysisError, type FeedAnalysisDeliveryMode } from './feed-analysis-types.js';
import { runFeedAnalysisResearchGraph } from './feed-analysis-research-graph.js';
import {
  parseFeedAnalysisWorkflowResult,
  type PreparedFeedAnalysisInput,
} from './feed-analysis-workflow.js';

export interface FeedAnalysisExecutionInput {
  dispatchId: string;
  prompt: string;
  sessionId: string;
  traceId: string;
  workspaceRoot: string;
  tenantId: string;
  projectId: string;
  userId?: string;
  requestId?: string;
  provider?: string;
  model?: string;
  timeoutMs?: number;
  deliveryMode: FeedAnalysisDeliveryMode;
  prepared: PreparedFeedAnalysisInput;
}

export async function _executeFeedAnalysisDispatch(input: FeedAnalysisExecutionInput): Promise<void> {
  const startedAt = Date.now();
  let processingEmitted = false;
  const onTaskEvent = async (event: ScheduledTaskEvent): Promise<void> => {
    await updateFeedAnalysisTaskRun(input.dispatchId, event.taskRun.id);
    if (event.type === 'task.running' && !processingEmitted) {
      processingEmitted = true;
      await emitFeedAnalysisStatus(input.dispatchId, 'processing');
    }
    if (event.type === 'task.running' && input.prepared.workflow.profile === 'research_deep') {
      const metadata = event.taskRun.metadata;
      await emitFeedAnalysisProgress(input.dispatchId, {
        stage: typeof metadata.agentTaskId === 'string' ? metadata.agentTaskId.split(':').at(-1) ?? 'research' : 'research',
        title: typeof metadata.agentTaskTitle === 'string' ? metadata.agentTaskTitle : undefined,
        taskRunId: event.taskRun.id,
      });
    }
  };
  try {
    if (input.prepared.workflow.profile === 'research_deep') {
      const research = await runFeedAnalysisResearchGraph({
        dispatchId: input.dispatchId,
        runSpecId: input.dispatchId,
        sessionId: input.sessionId,
        traceId: input.traceId,
        workspaceRoot: input.workspaceRoot,
        tenantId: input.tenantId,
        projectId: input.projectId,
        userId: input.userId,
        requestId: input.requestId,
        provider: input.provider,
        model: input.model,
        timeoutMs: input.timeoutMs,
        prepared: input.prepared,
        onTaskEvent,
      });
      if (input.deliveryMode === 'delivery_only') {
        await emitFeedAnalysisStatus(input.dispatchId, 'completed');
        return;
      }
      const result = parseFeedAnalysisWorkflowResult(research.text, input.prepared, {
        provider: research.provider,
        model: research.model,
        promptTokens: research.promptTokens,
        completionTokens: research.completionTokens,
        durationMs: Date.now() - startedAt,
      });
      await saveFeedAnalysisResult(input.dispatchId, result);
      return;
    }
    const scheduled = await runScheduledAgentTask({
      prompt: input.prompt,
      promptPreview: `[feed-analysis ${input.dispatchId}]`,
      sessionId: input.sessionId,
      runSpecId: input.dispatchId,
      traceId: input.traceId,
      dedupeKey: `feed-analysis:${input.tenantId}:${input.projectId}:${input.dispatchId}`,
      workspaceRoot: input.workspaceRoot,
      tenantId: input.tenantId,
      projectId: input.projectId,
      userId: input.userId,
      requestId: input.requestId,
      provider: input.provider,
      model: input.model,
      timeoutMs: input.timeoutMs,
      toolMode: 'read-only',
      maxLoops: input.prepared.workflow.maxLoops,
      metadata: {
        feedAnalysisDispatchId: input.dispatchId,
        scenario: input.prepared.workflow.scenario,
        workflowProfile: input.prepared.workflow.profile,
        collectionSnapshotId: input.prepared.collectionSnapshot?.snapshotId,
        topicId: input.prepared.topic?.topicId,
      },
      runContract: {
        mode: 'feed-analysis-ingress',
        executionMode: input.prepared.workflow.executionMode,
      },
      onTaskEvent,
    });
    if (scheduled.status !== 'completed') {
      if (scheduled.status === 'cancelled') await emitFeedAnalysisStatus(input.dispatchId, 'cancelled');
      else await emitFeedAnalysisStatus(input.dispatchId, 'failed', {
        code: 'workflow_incomplete',
        message: scheduled.status === 'blocked' ? scheduled.reason : 'workflow task was deduplicated unexpectedly',
      });
      return;
    }
    if (input.deliveryMode === 'delivery_only') {
      await emitFeedAnalysisStatus(input.dispatchId, 'completed');
      return;
    }
    const result = parseFeedAnalysisWorkflowResult(scheduled.result.text, input.prepared, {
      provider: scheduled.taskRun.provider,
      model: scheduled.taskRun.model,
      promptTokens: scheduled.result.totalTokens.prompt,
      completionTokens: scheduled.result.totalTokens.completion,
      durationMs: Date.now() - startedAt,
    });
    await saveFeedAnalysisResult(input.dispatchId, result);
  } catch (error) {
    const current = await loadFeedAnalysisDispatch(input.dispatchId).catch(() => null);
    if (current?.status === 'cancelled' || current?.status === 'failed') return;
    const code = error instanceof FeedAnalysisError ? error.code : 'workflow_failed';
    const message = error instanceof Error ? error.message : String(error);
    await emitFeedAnalysisStatus(input.dispatchId, 'failed', { code, message }).catch(() => undefined);
  }
}
