import { randomUUID } from 'node:crypto';
import { ensureSessionEventStore } from '../session-events.js';
import { resolveExecutionKernelForRun } from '../execution-kernel-registry.js';
import { assertPersistedRunSpecKernelSelection } from '../run-spec-kernel-selection.js';
import { _createKernelEventProjector } from '../kernel-event-projection.js';
import { startScheduledKernelShadow } from './kernel-shadow.js';
import {
  ensureTaskRunStore,
  findActiveTaskRunByDedupeKey,
  loadTaskRun,
  updateTaskRunFields,
} from '../task-runs.js';
import { createTaskRunOrFindActive } from '../task-runs/create-or-find.js';
import { transitionExecutionState } from '../execution-store.js';
import { runLifecycleHooks } from '../lifecycle-hooks.js';
import {
  cancelScheduledTask,
  linkAbortSignal,
  registerScheduledTaskController,
} from './abort-registry.js';
import { clearCancellation } from '../cancellation.js';
import { canStartExecution, type RunContractMetadata } from '../run-contract.js';
import { recordSchedulerDecision } from '../scheduler-decision-ledger.js';
import {
  _ExecutorSelectionError,
  resolveExecutor,
  type ResolvedExecutor,
} from './executor-client.js';
import { normalizeOptionalString, normalizePositiveInteger, readObject } from './helpers.js';
import { emitTaskEvent } from './task-events.js';
import { reportTaskDeduplicated } from './task-deduplication.js';
import { startTaskHeartbeat } from './task-heartbeat.js';
import { readCurrentRunContract } from './contract-reader.js';
import {
  promptForDisposition,
  resolveTaskDisposition,
  validatePlanningDisposition,
} from './planning-disposition.js';
import {
  normalizeProviderFallbackPolicy,
  resolveProviderFallbackInitialTarget,
  type ProviderFallbackEvent,
} from '../providers/provider-fallback.js';
import type { SessionEventRecord } from '../session-events.js';
import type { ScheduledAgentTaskInput, ScheduledAgentTaskResult } from './types.js';
import { runScheduledTaskExecution } from './scheduled-task-execution.js';
import { completeScheduledTask, handleScheduledTaskError } from './scheduled-task-terminal.js';
import { markProviderProbeActivity } from '../providers/provider-probe.js';
import {
  selectSkillsForRun,
  recordSkillUsage,
  mergeSkillAllowedTools,
  skillSelectedEventPayload,
} from '../skill-runtime.js';
import { appendSessionEvent } from '../session-events.js';
import { getConfig } from '@los/infra/config';

export async function runScheduledAgentTask(input: ScheduledAgentTaskInput): Promise<ScheduledAgentTaskResult> {
  // Keep provider probe cadence in the active (60s) band while tasks run.
  markProviderProbeActivity();
  await ensureTaskRunStore();
  await ensureSessionEventStore();
  const taskRunId = input.taskRunId ?? `task-${randomUUID()}`;
  const sessionId = input.sessionId ?? `session-${Date.now()}`;
  const traceId = input.traceId ?? taskRunId;
  const dedupeKey = normalizeOptionalString(input.dedupeKey);
  const contractMetadata = {
    ...(input.metadata ?? {}),
    ...(input.runContract ? { runContract: input.runContract } : {}),
  };
  const runContract = await readCurrentRunContract(input.runSpecId, contractMetadata);
  const disposition = resolveTaskDisposition(input, runContract);
  const planningTransport = input.planningTransport ?? 'typed_tool';
  const toolMode = disposition === 'planning' ? 'read-only' : (input.toolMode ?? 'project-write');
  const sandboxMode = disposition === 'planning' ? 'readonly' : input.sandboxMode;
  if (runContract?.executionKernel) {
    await assertPersistedRunSpecKernelSelection({
      runSpecId: input.runSpecId ?? '',
      selection: runContract.executionKernel,
      tenantId: input.tenantId,
      projectId: input.projectId,
    });
  }
  const executionKernel = resolveExecutionKernelForRun({
    requestedKind: input.executionKernelKind,
    runSpecId: input.runSpecId,
    runContract,
    toolMode,
    executorEnabled: input.executor?.enabled === true,
  });
  let runtimePrompt = promptForDisposition(input.prompt, disposition, planningTransport, runContract);
  const workspaceRoot = input.workspaceRoot ?? process.cwd();
  // Skill runtime: user-turn attachment (AP11-safe). Shared for chat + scheduler/work.
  let effectiveAllowedTools = input.allowedTools ? [...input.allowedTools] : undefined;
  try {
    const skillsCfg = (getConfig().agent as { skills?: {
      runtimeEnabled?: boolean;
      autoInject?: boolean;
      maxAutoSkills?: number;
      maxSkillTokens?: number;
    } }).skills ?? {};
    const manualFromMeta = Array.isArray(input.metadata?.manualSkillIds)
      ? (input.metadata!.manualSkillIds as unknown[]).map(String)
      : undefined;
    const skillSelection = await selectSkillsForRun({
      prompt: runtimePrompt,
      workspaceRoot,
      projectId: input.projectId,
      tenantId: input.tenantId,
      manualSkillIds: manualFromMeta,
      runtimeEnabled: skillsCfg.runtimeEnabled !== false,
      autoEnabled: skillsCfg.autoInject === true,
      maxAutoSkills: skillsCfg.maxAutoSkills,
      maxSkillTokens: skillsCfg.maxSkillTokens,
    });
    if (skillSelection.selected.length > 0) {
      runtimePrompt = skillSelection.effectivePrompt;
      effectiveAllowedTools = mergeSkillAllowedTools(
        input.allowedTools,
        skillSelection.selected.map(s => s.allowedTools),
      );
      await recordSkillUsage(skillSelection.selected);
      await appendSessionEvent({
        sessionId,
        tenantId: input.tenantId,
        projectId: input.projectId,
        userId: input.userId,
        requestId: input.requestId,
        traceId,
        type: 'skill.selected',
        payload: skillSelectedEventPayload(skillSelection),
      }).catch(() => undefined);
    } else if (skillSelection.cleanedPrompt !== runtimePrompt) {
      // Strip /skill directives even when no skill was found
      runtimePrompt = skillSelection.cleanedPrompt || runtimePrompt;
    }
  } catch {
    // Fail open for skill selection — do not block the run
  }
  // Operator rules: inject prompt (non-chat paths) + preload hard gate (no per-tool DB).
  try {
    if (!input.operatorRulesGate) {
      const rulesCfg = (getConfig().agent as { rules?: {
        operatorInject?: boolean;
        enforcementEnabled?: boolean;
        maxPromptRules?: number;
      } }).rules ?? {};
      const {
        listActiveOperatorRules,
        selectOperatorRulesForRun,
        injectOperatorRulesIntoSystemPrompt,
        buildOperatorRulesGateConfig,
      } = await import('../operator-rules-runtime.js');
      const gateRules = (rulesCfg.operatorInject !== false || rulesCfg.enforcementEnabled !== false)
        ? await listActiveOperatorRules({ maxRules: rulesCfg.maxPromptRules ?? 20 })
        : [];
      if (rulesCfg.operatorInject !== false && gateRules.length > 0) {
        const block = selectOperatorRulesForRun(gateRules).promptBlock;
        const basePrompt = input.systemPrompt ?? '';
        input = {
          ...input,
          systemPrompt: injectOperatorRulesIntoSystemPrompt(basePrompt, block),
        };
      }
      input = {
        ...input,
        operatorRulesGate: buildOperatorRulesGateConfig(
          gateRules,
          rulesCfg.enforcementEnabled !== false,
        ),
      };
    }
  } catch {
    // Fail open for operator rules load — do not block the run
  }
  // Thread allowlist into execution input without mutating caller's object identity beyond clone
  if (effectiveAllowedTools) {
    input = { ...input, allowedTools: effectiveAllowedTools };
  }
  const timeoutMs = normalizePositiveInteger(input.timeoutMs);
  const leaseMs = normalizePositiveInteger(input.executor?.leaseMs) ?? 30_000;
  const heartbeatMs = normalizePositiveInteger(input.executor?.heartbeatMs) ?? Math.max(1_000, Math.floor(leaseMs / 3));
  const leaseVersion = normalizePositiveInteger(input.leaseVersion) ?? 1;
  const providerFallback = normalizeProviderFallbackPolicy(input.providerFallback);
  const initialFallbackTarget = resolveProviderFallbackInitialTarget(providerFallback, {
    provider: input.provider,
    model: input.model,
  });
  const initialProvider = initialFallbackTarget?.provider ?? input.provider;
  const initialModel = initialFallbackTarget?.model ?? input.model;
  if (dedupeKey) {
    const existing = await findActiveTaskRunByDedupeKey(dedupeKey);
    if (existing) return reportTaskDeduplicated(input, existing, taskRunId);
  }

  let executor: ResolvedExecutor | null;
  try {
    executor = await resolveExecutor(input.executor, {
      toolMode,
      sandboxMode,
    });
  } catch (error) {
    if (error instanceof _ExecutorSelectionError) {
      const metadata = readObject(input.metadata);
      await recordSchedulerDecision({
        graphId: normalizeOptionalString(metadata.graphId) ?? input.runSpecId ?? taskRunId,
        taskId: normalizeOptionalString(metadata.agentTaskId),
        taskRunId,
        runSpecId: input.runSpecId,
        sessionId,
        kind: 'executor_selection',
        selectedIds: [],
        skipped: error.decision.skipped,
        reason: 'no_executor_match',
        metadata: {
          candidateNodeIds: error.decision.candidateIds,
          requiredCapabilities: error.decision.requiredCapabilities,
        },
      });
    }
    throw error;
  }
  const nodeId = executor?.nodeId ?? 'gateway-local';
  const creation = await createTaskRunOrFindActive({
    id: taskRunId,
    sessionId,
    runSpecId: input.runSpecId,
    traceId,
    dedupeKey,
    workspaceRoot,
    toolMode,
    provider: initialProvider,
    model: initialModel,
    tenantId: normalizeOptionalString(input.tenantId),
    projectId: normalizeOptionalString(input.projectId),
    userId: normalizeOptionalString(input.userId),
    nodeId,
    requestId: normalizeOptionalString(input.requestId),
    promptPreview: input.promptPreview ?? input.prompt.slice(0, 200),
    metadata: input.metadata ?? {},
    runContract,
    status: 'queued',
    attempt: input.attempt,
    leaseVersion,
    leaseExpiresAt: new Date(Date.now() + leaseMs),
  });
  if (!creation.created) return reportTaskDeduplicated(input, creation.taskRun, taskRunId);
  const created = creation.taskRun;
  if (executor) {
    const metadata = readObject(input.metadata);
    await recordSchedulerDecision({
      graphId: normalizeOptionalString(metadata.graphId) ?? input.runSpecId ?? taskRunId,
      taskId: normalizeOptionalString(metadata.agentTaskId),
      taskRunId,
      runSpecId: input.runSpecId,
      sessionId,
      nodeId,
      kind: 'executor_selection',
      selectedIds: [executor.nodeId],
      skipped: executor.decision.skipped,
      reason: executor.decision.source,
      metadata: {
        candidateNodeIds: executor.decision.candidateIds,
        executorUrl: executor.url,
        placementTier: executor.decision.placementTier,
        requiredCapabilities: executor.decision.requiredCapabilities,
      },
    });
  }
  await emitTaskEvent(sessionId, 'task.created', created);
  await input.onTaskEvent?.({ type: 'task.created', taskRun: created });

  await transitionExecutionState({
    entityType: 'task_run',
    entityId: taskRunId,
    to: 'running',
    sessionId,
    reason: 'task_started',
    nodeId,
    leaseVersion,
  });
  let running = await updateTaskRunFields(taskRunId, {
    nodeId,
    heartbeatAt: new Date(),
    leaseExpiresAt: new Date(Date.now() + leaseMs),
    metadata: {
      ...created.metadata,
      requestedRoute: { provider: input.provider ?? null, model: input.model ?? null },
      effectiveRoute: { provider: initialProvider ?? null, model: initialModel ?? null },
      providerFallback: providerFallback ?? null,
      providerSwitchHistory: [],
      model: initialModel,
      maxLoops: input.maxLoops,
      modelSettings: input.modelSettings,
      allowedTools: input.allowedTools,
      toolRetry: input.toolRetry,
      timeoutMs,
      disposition,
      planningTransport: disposition === 'planning' ? planningTransport : null,
      requestedExecutionKernel: input.executionKernelKind ?? runContract?.executionKernel?.selected.kind ?? 'los',
      executionKernel: executionKernel.identity,
    },
    runContract,
  });
  running ??= await loadTaskRun(taskRunId);
  if (!running) throw new Error(`Task run disappeared after create: ${taskRunId}`);
  const persistProviderFallbackSelection = async (event: ProviderFallbackEvent): Promise<void> => {
    if (event.type !== 'selected' || !event.toProvider || !event.toModel) return;
    const current = running;
    if (!current) throw new Error(`Task run disappeared during provider fallback: ${taskRunId}`);
    const existingHistory = Array.isArray(current.metadata.providerSwitchHistory)
      ? current.metadata.providerSwitchHistory
      : [];
    const updated = await updateTaskRunFields(taskRunId, {
      provider: event.toProvider,
      model: event.toModel,
      metadata: {
        ...current.metadata,
        effectiveRoute: { provider: event.toProvider, model: event.toModel },
        providerSwitchHistory: [...existingHistory, {
          callIndex: event.callIndex,
          switchIndex: event.switchIndex,
          failureClass: event.failureClass,
          errorCode: event.errorCode ?? null,
          fromProvider: event.fromProvider,
          fromModel: event.fromModel,
          toProvider: event.toProvider,
          toModel: event.toModel,
          compatibilityEvidenceId: event.compatibilityEvidenceId ?? null,
        }],
      },
    });
    if (!updated) throw new Error(`Task run disappeared during provider fallback: ${taskRunId}`);
    running = updated;
  };
  const handleSessionEvent = async (event: SessionEventRecord): Promise<void> => {
    if (executor && event.type === 'provider.fallback.selected') {
      await persistProviderFallbackSelection({
        type: 'selected',
        ...event.payload,
      } as unknown as ProviderFallbackEvent);
    }
    await input.onSessionEvent?.(event);
  };
  const projectKernelEvent = _createKernelEventProjector({ sessionId, taskRunId, traceId,
    runSpecId: input.runSpecId, nodeId, onSessionEvent: handleSessionEvent });
  await emitTaskEvent(sessionId, 'task.running', running);
  await input.onTaskEvent?.({ type: 'task.running', taskRun: running });
  if (input.runContract?.hooks) {
    runLifecycleHooks('afterStart', {
      hooks: input.runContract.hooks as import('../run-contract.js').TaskLifecycleHooks,
      sessionId,
      runSpecId: input.runSpecId,
      taskRunId,
    }).catch(() => undefined);
  }
  const architectEditor = runContract?.mode === 'architect-editor'
    ? { enabled: true as const }
    : undefined;
  const execCheck = disposition === 'planning'
    ? { allowed: validatePlanningDisposition(runContract) === null, reason: validatePlanningDisposition(runContract) ?? undefined }
    : canStartExecution(runContract);
  if (!execCheck.allowed) {
    await transitionExecutionState({
      entityType: 'task_run',
      entityId: taskRunId,
      to: 'blocked',
      sessionId,
      reason: execCheck.reason ?? 'b0_phase_gate',
      nodeId,
      leaseVersion,
    });
    await updateTaskRunFields(taskRunId, {
      metadata: { ...running.metadata, blockReason: execCheck.reason },
    });
    await emitTaskEvent(sessionId, 'task.blocked', { ...running, status: 'blocked' });
    throw new Error(`Execution blocked: ${execCheck.reason}`);
  }

  const controller = new AbortController();
  const linkedAbortCleanup = linkAbortSignal(input.signal, controller);
  let timeout: NodeJS.Timeout | undefined;
  const unregisterTaskController = registerScheduledTaskController(taskRunId, controller, 'cancelled');
  const stopHeartbeat = startTaskHeartbeat(taskRunId, nodeId, leaseVersion, leaseMs, heartbeatMs, {
    dispatchId: normalizeOptionalString(input.metadata?.agentTaskAttemptId),
    taskId: input.agentTaskLease?.taskId,
    agentTaskLease: input.agentTaskLease,
  });
  if (timeoutMs) {
    timeout = setTimeout(() => {
      cancelScheduledTask(taskRunId, `timeout:${timeoutMs}ms`);
    }, timeoutMs);
  }
  let kernelShadow: ReturnType<typeof startScheduledKernelShadow>;
  try {
    kernelShadow = startScheduledKernelShadow({ task: input, prompt: runtimePrompt, productionKernel: executionKernel.identity, sessionId, taskRunId, traceId, toolMode, remoteExecutor: Boolean(executor), config: { ...input, sessionId, taskRunId, traceId, provider: initialProvider, model: initialModel, toolMode, sandboxMode, architectEditor, signal: controller.signal, runContractMetadata: { ...running.metadata, ...(runContract ? { runContract } : {}) } } });
    const result = await runScheduledTaskExecution({
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
      runContractMetadata: {
        ...running.metadata,
        ...(runContract ? { runContract } : {}),
      },
      signal: controller.signal,
      onSessionEvent: handleSessionEvent,
      onKernelEvent: projectKernelEvent,
      onProviderFallback: persistProviderFallbackSelection,
    });
    await kernelShadow?.settle(result);
    return await completeScheduledTask(result, {
      input,
      running,
      taskRunId,
      sessionId,
      nodeId,
      leaseVersion,
      disposition,
      initialProvider,
      initialModel,
      executor,
    });
  } catch (err) {
    await kernelShadow?.cancel(err instanceof Error ? err.message : String(err));
    return await handleScheduledTaskError(err, {
      input,
      running,
      taskRunId,
      sessionId,
      nodeId,
      leaseVersion,
      disposition,
      initialProvider,
      initialModel,
      executor,
    });
  } finally {
    if (timeout) clearTimeout(timeout);
    stopHeartbeat();
    linkedAbortCleanup();
    unregisterTaskController();
    clearCancellation(taskRunId).catch(() => undefined);
  }
}
