import type { ScheduledExecutionKernel } from '../execution-kernel-registry.js';
import type { KernelEvent } from '../execution-kernel.js';
import type { AgentConfig, AgentResult } from '../loop.js';
import type { ProviderFallbackEvent } from '../providers/provider-fallback.js';
import type { SessionEventRecord } from '../session-events.js';
import { runAgentOnExecutor, type ResolvedExecutor } from './executor-client.js';
import { normalizeOptionalString } from './helpers.js';
import { persistScheduledToolCallState } from './tool-call-state-persistence.js';
import type { ScheduledAgentTaskInput } from './types.js';

export interface ScheduledTaskExecutionContext {
  input: ScheduledAgentTaskInput;
  executionKernel: ScheduledExecutionKernel;
  executor: ResolvedExecutor | null;
  taskRunId: string;
  leaseVersion: number;
  leaseMs: number;
  runtimePrompt: string;
  sessionId: string;
  initialProvider?: string;
  initialModel?: string;
  providerFallback: AgentConfig['providerFallback'];
  workspaceRoot: string;
  nodeId: string;
  traceId: string;
  toolMode: AgentConfig['toolMode'];
  sandboxMode: AgentConfig['sandboxMode'];
  disposition: 'planning' | 'execution';
  architectEditor?: AgentConfig['architectEditor'];
  runContractMetadata: Record<string, unknown>;
  signal: AbortSignal;
  onSessionEvent: (event: SessionEventRecord) => void | Promise<void>;
  onKernelEvent: (event: KernelEvent) => void | Promise<void>;
  onProviderFallback: (event: ProviderFallbackEvent) => void | Promise<void>;
}

export async function runScheduledTaskExecution(context: ScheduledTaskExecutionContext): Promise<AgentResult> {
  const {
    input,
    executionKernel,
    executor,
    taskRunId,
    leaseVersion,
    leaseMs,
    runtimePrompt,
    sessionId,
    initialProvider,
    initialModel,
    providerFallback,
    workspaceRoot,
    nodeId,
    traceId,
    toolMode,
    sandboxMode,
    disposition,
    architectEditor,
    runContractMetadata,
    signal,
    onSessionEvent,
    onKernelEvent,
    onProviderFallback,
  } = context;
  const onToolCallState: NonNullable<AgentConfig['onToolCallState']> = async transition => {
    await persistScheduledToolCallState({
      transition,
      sessionId,
      runSpecId: input.runSpecId,
      taskRunId,
    });
    await input.onToolCallState?.(transition);
  };

  if (executor) {
    return await runAgentOnExecutor(executor, {
      taskRunId,
      executionKernelKind: executionKernel.identity.kind,
      leaseVersion,
      agentTaskLease: input.agentTaskLease,
      leaseMs,
      prompt: runtimePrompt,
      config: {
        sessionId,
        runSpecId: input.runSpecId,
        provider: initialProvider,
        model: initialModel,
        providerFallback,
        modelSettings: input.modelSettings,
        maxLoops: input.maxLoops,
        systemPrompt: input.systemPrompt,
        identity: input.identity,
        workspaceRoot,
        tenantId: input.tenantId,
        projectId: input.projectId,
        userId: input.userId,
        nodeId,
        requestId: input.requestId,
        traceId,
        toolMode,
        sandboxMode,
        skipPreExecutionPhases: disposition === 'planning',
        architectEditor,
        taskRunId,
        dispatchId: normalizeOptionalString(input.metadata?.agentTaskAttemptId),
        initialMessages: input.initialMessages,
        allowedTools: input.allowedTools,
        toolRetry: input.toolRetry,
        mcpServers: input.mcpServers,
        runContractMetadata,
      },
      signal,
      onSessionEvent,
      onKernelEvent,
      onModelDelta: input.onModelDelta,
      onToolCallState,
      onCheckpoint: input.onCheckpoint,
    });
  }

  return await executionKernel.run(runtimePrompt, {
    sessionId,
    runSpecId: input.runSpecId,
    provider: initialProvider,
    model: initialModel,
    providerFallback,
    modelSettings: input.modelSettings,
    maxLoops: input.maxLoops,
    systemPrompt: input.systemPrompt,
    identity: input.identity,
    workspaceRoot,
    tenantId: input.tenantId,
    projectId: input.projectId,
    userId: input.userId,
    nodeId,
    requestId: input.requestId,
    traceId,
    log: input.log,
    toolMode,
    sandboxMode,
    skipPreExecutionPhases: disposition === 'planning',
    architectEditor,
    taskRunId,
    dispatchId: normalizeOptionalString(input.metadata?.agentTaskAttemptId),
    initialMessages: input.initialMessages,
    allowedTools: input.allowedTools,
    toolRetry: input.toolRetry,
    mcpServers: input.mcpServers,
    runContractMetadata,
    signal,
    onSessionEvent,
    onProviderFallback,
    onTurn: input.onTurn,
    onToolCall: input.onToolCall,
    onToolCallState,
    onModelDelta: input.onModelDelta,
    onCheckpoint: input.onCheckpoint,
    contextMonitor: input.contextMonitor,
  }, onKernelEvent);
}
