import { createHash } from 'node:crypto';
import { appendSessionEvent } from './session-events.js';
import { _createKernelEventProjector } from './kernel-event-projection.js';
import { _consumeExecutionKernel, type KernelEvent, type KernelIdentity } from './execution-kernel.js';
import { _createPiExecutionKernel, _getPiExecutionKernelIdentity } from './pi-execution-kernel.js';
import { _preparePiKernelRun } from './pi-kernel-input.js';
import { evaluatePiKernelShadowAdmission, type PiKernelAdmissionIssue } from './pi-kernel-admission.js';
import { estimateCost, resolveModelProfile } from './model-profiles.js';
import {
  evaluatePiKernelShadowScenario,
  type PiKernelShadowEvidenceClass,
  type PiKernelShadowScenarioEvidence,
  type PiKernelShadowScenarioId,
} from './pi-kernel-shadow-scenarios.js';
import type { AgentConfig, AgentResult } from './loop.js';

export interface PiKernelShadowConfig {
  kind: 'pi';
  maxTurns?: number;
  timeoutMs?: number;
  scenario?: {
    id: PiKernelShadowScenarioId;
  };
}

export interface PiKernelShadowOutcome {
  status: 'completed' | 'failed' | 'interrupted' | 'skipped';
  candidate: KernelIdentity;
  sessionId: string;
  taskRunId: string;
  traceId: string;
  latencyMs: number;
  eventCounts: Record<string, number>;
  toolCallCount: number;
  toolNames: string[];
  toolCompletionStates: string[];
  totalTokens: { prompt: number; completion: number };
  route?: { provider: string; model: string; api: string };
  estimatedCostUsd?: number;
  outputHash?: string;
  admissionIssues?: PiKernelAdmissionIssue[];
  error?: string;
  scenarioEvidence?: PiKernelShadowScenarioEvidence;
  scenarioEvidenceError?: string;
  candidateEventLineageMatches: boolean;
}

export interface PiKernelShadowHandle {
  settle(productionResult: AgentResult): Promise<PiKernelShadowOutcome>;
  cancel(reason: string): Promise<PiKernelShadowOutcome>;
}

interface PiKernelShadowInput {
  shadow: PiKernelShadowConfig;
  prompt: string;
  productionKernel: KernelIdentity;
  productionSessionId: string;
  productionTaskRunId: string;
  productionTraceId: string;
  effectiveToolMode: AgentConfig['toolMode'];
  remoteExecutor: boolean;
  config: AgentConfig;
}

interface PiKernelShadowDependencies {
  runCandidate?: (input: CandidateRunInput) => Promise<CandidateRunResult>;
  appendEvent?: typeof appendSessionEvent;
  now?: () => number;
}

interface CandidateRunInput {
  prompt: string;
  config: AgentConfig;
}

interface CandidateRunResult {
  result?: AgentResult;
  events: KernelEvent[];
  route?: { provider: string; model: string; api: string };
  error?: unknown;
}

export function startPiKernelShadow(
  input: PiKernelShadowInput,
  dependencies: PiKernelShadowDependencies = {},
): PiKernelShadowHandle {
  const candidate = _getPiExecutionKernelIdentity();
  const lineage = derivedLineage(input);
  const now = dependencies.now ?? Date.now;
  const startedAt = now();
  const controller = new AbortController();
  const unlink = linkAbortSignal(input.config.signal, controller);
  const timeoutMs = normalizeTimeout(input.shadow.timeoutMs);
  const timeout = setTimeout(() => controller.abort(`Pi shadow timeout after ${timeoutMs}ms`), timeoutMs);
  const admissionIssues = evaluatePiKernelShadowAdmission({
    config: input.config,
    effectiveToolMode: input.effectiveToolMode,
    remoteExecutor: input.remoteExecutor,
  });
  const candidatePromise = admissionIssues.length > 0
    ? Promise.resolve<CandidateRunResult>({ events: [] })
    : (dependencies.runCandidate ?? runCandidate)({
        prompt: input.prompt,
        config: shadowConfig(input, lineage, controller.signal),
      }).catch(error => ({ events: [], error }));
  let settlement: Promise<PiKernelShadowOutcome> | undefined;

  const finish = (productionResult?: AgentResult, productionStatus: 'completed' | 'failed' = 'completed') => {
    settlement ??= (async () => {
      const candidateRun = await candidatePromise;
      clearTimeout(timeout);
      unlink();
      const outcome = summarizeOutcome({
        candidate, lineage, candidateRun, admissionIssues,
        latencyMs: Math.max(0, now() - startedAt),
      });
      if (input.shadow.scenario) {
        try {
          outcome.scenarioEvidence = evaluatePiKernelShadowScenario({
            scenarioId: input.shadow.scenario.id,
            evidenceClass: inferEvidenceClass(input.config.provider, outcome.route),
            productionStatus,
            productionResult,
            prompt: input.prompt,
            allowedTools: input.config.allowedTools,
            productionSessionId: input.productionSessionId,
            productionTaskRunId: input.productionTaskRunId,
            productionTraceId: input.productionTraceId,
            candidateStatus: outcome.status,
            candidateSessionId: outcome.sessionId,
            candidateTaskRunId: outcome.taskRunId,
            candidateTraceId: outcome.traceId,
            candidateEventLineageMatches: outcome.candidateEventLineageMatches,
            candidateEventCounts: outcome.eventCounts,
            candidateToolNames: outcome.toolNames,
            candidateToolCompletionStates: outcome.toolCompletionStates,
            candidateOutputHash: outcome.outputHash,
            productionOutputHash: productionResult ? outputHash(productionResult.text) : undefined,
          });
        } catch (error) {
          outcome.scenarioEvidenceError = truncate(error instanceof Error ? error.message : String(error));
        }
      }
      await persistComparison(input, outcome, productionResult, productionStatus, dependencies.appendEvent)
        .catch(() => undefined);
      return outcome;
    })();
    return settlement;
  };

  return {
    settle: productionResult => finish(productionResult),
    cancel: reason => {
      controller.abort(reason);
      return finish(undefined, 'failed');
    },
  };
}

async function persistComparison(
  input: PiKernelShadowInput,
  outcome: PiKernelShadowOutcome,
  productionResult: AgentResult | undefined,
  productionStatus: 'completed' | 'failed',
  append: PiKernelShadowDependencies['appendEvent'],
): Promise<void> {
  await (append ?? appendSessionEvent)({
    sessionId: input.productionSessionId, traceId: input.productionTraceId,
    tenantId: input.config.tenantId, projectId: input.config.projectId,
    userId: input.config.userId, nodeId: input.config.nodeId, requestId: input.config.requestId,
    type: 'kernel.shadow.compared', source: 'los.scheduler.shadow', visibility: 'audit',
    payload: {
      productionTaskRunId: input.productionTaskRunId, productionKernel: input.productionKernel,
      productionStatus,
      productionOutputHash: productionResult ? outputHash(productionResult.text) : null,
      productionTotalTokens: productionResult?.totalTokens ?? null,
      candidate: outcome.candidate, candidateSessionId: outcome.sessionId,
      candidateTaskRunId: outcome.taskRunId, candidateTraceId: outcome.traceId,
      status: outcome.status, latencyMs: outcome.latencyMs, eventCounts: outcome.eventCounts,
      toolCallCount: outcome.toolCallCount, toolNames: outcome.toolNames,
      toolCompletionStates: outcome.toolCompletionStates, totalTokens: outcome.totalTokens,
      route: outcome.route ?? null, estimatedCostUsd: outcome.estimatedCostUsd ?? null,
      outputHash: outcome.outputHash ?? null, admissionIssues: outcome.admissionIssues ?? [],
      error: outcome.error ?? null,
      scenarioEvidence: outcome.scenarioEvidence ?? null,
      scenarioEvidenceError: outcome.scenarioEvidenceError ?? null,
      candidateEventLineageMatches: outcome.candidateEventLineageMatches,
    },
  });
}

async function runCandidate(input: CandidateRunInput): Promise<CandidateRunResult> {
  const prepared = await _preparePiKernelRun(input.prompt, input.config);
  const events: KernelEvent[] = [];
  const project = _createKernelEventProjector({
    ...input.config,
    sessionId: required(input.config.sessionId, 'sessionId'),
    taskRunId: required(input.config.taskRunId, 'taskRunId'),
    traceId: required(input.config.traceId, 'traceId'),
  });
  try {
    const consumed = await _consumeExecutionKernel<typeof prepared.input, AgentResult>(
      _createPiExecutionKernel(),
      prepared.input,
      async event => {
        events.push(event);
        await project(event);
      },
    );
    return { result: consumed.result, events, route: prepared.route };
  } catch (error) {
    return { events, error };
  } finally {
    await prepared.cleanup();
  }
}

function shadowConfig(
  input: PiKernelShadowInput,
  lineage: ReturnType<typeof derivedLineage>,
  signal: AbortSignal,
): AgentConfig {
  const config = input.config;
  return {
    sessionId: lineage.sessionId,
    taskRunId: lineage.taskRunId,
    traceId: lineage.traceId,
    runSpecId: config.runSpecId,
    provider: config.provider,
    model: config.model,
    modelSettings: config.modelSettings,
    initialMessages: config.initialMessages,
    maxLoops: normalizeMaxTurns(input.shadow.maxTurns ?? config.maxLoops),
    systemPrompt: config.systemPrompt,
    workspaceRoot: config.workspaceRoot,
    tenantId: config.tenantId,
    projectId: config.projectId,
    userId: config.userId,
    nodeId: config.nodeId,
    requestId: config.requestId,
    toolMode: 'read-only',
    sandboxMode: 'readonly',
    allowedTools: config.allowedTools,
    toolRetry: config.toolRetry,
    preActionGate: config.preActionGate,
    signal,
    runContractMetadata: config.runContractMetadata,
    skipPreExecutionPhases: true,
    identity: config.identity,
  };
}

function summarizeOutcome(input: {
  candidate: KernelIdentity;
  lineage: ReturnType<typeof derivedLineage>;
  candidateRun: CandidateRunResult;
  admissionIssues: PiKernelAdmissionIssue[];
  latencyMs: number;
}): PiKernelShadowOutcome {
  const { result, events, error } = input.candidateRun;
  const interrupted = events.some(event => event.type === 'kernel.interrupted');
  const totalTokens = result?.totalTokens ?? usageFromEvents(events);
  const toolNames = events.flatMap(event => event.type === 'tool.requested'
    && typeof event.payload.tool === 'string' ? [event.payload.tool] : []);
  const toolCompletionStates = events.flatMap(event => {
    if (event.type !== 'tool.completed') return [];
    const transition = event.payload.transition;
    if (!transition || typeof transition !== 'object' || Array.isArray(transition)) return [];
    const state = (transition as Record<string, unknown>).state;
    return typeof state === 'string' ? [state] : [];
  });
  const estimatedCostUsd = input.candidateRun.route
    ? estimateCandidateCost(input.candidateRun.route, totalTokens)
    : undefined;
  const status = input.admissionIssues.length > 0
    ? 'skipped'
    : interrupted
      ? 'interrupted'
      : error || !result
        ? 'failed'
        : 'completed';
  return {
    status,
    candidate: input.candidate,
    ...input.lineage,
    latencyMs: input.latencyMs,
    eventCounts: countEvents(events),
    toolCallCount: events.filter(event => event.type === 'tool.requested').length,
    toolNames: toolNames.slice(0, 20),
    toolCompletionStates: toolCompletionStates.slice(0, 20),
    totalTokens,
    candidateEventLineageMatches: startedLineageMatches(events, input.lineage),
    ...(input.candidateRun.route ? { route: input.candidateRun.route } : {}),
    ...(estimatedCostUsd === undefined ? {} : { estimatedCostUsd }),
    ...(result ? { outputHash: outputHash(result.text) } : {}),
    ...(input.admissionIssues.length ? { admissionIssues: input.admissionIssues } : {}),
    ...(error ? { error: truncate(error instanceof Error ? error.message : String(error)) } : {}),
  };
}

function startedLineageMatches(
  events: KernelEvent[],
  lineage: ReturnType<typeof derivedLineage>,
): boolean {
  const started = events.filter(event => event.type === 'kernel.started');
  if (started.length !== 1) return false;
  const payload = started[0]!.payload;
  return payload.sessionId === lineage.sessionId
    && payload.taskRunId === lineage.taskRunId
    && payload.traceId === lineage.traceId;
}

function derivedLineage(input: PiKernelShadowInput) {
  return {
    sessionId: `${input.productionSessionId}:shadow:pi`,
    taskRunId: `${input.productionTaskRunId}:shadow:pi`,
    traceId: `${input.productionTraceId}:shadow:pi`,
  };
}

function countEvents(events: KernelEvent[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const event of events) counts[event.type] = (counts[event.type] ?? 0) + 1;
  return counts;
}

function usageFromEvents(events: KernelEvent[]): { prompt: number; completion: number } {
  let prompt = 0;
  let completion = 0;
  for (const event of events) {
    if (event.type !== 'usage.recorded') continue;
    const usage = event.payload.totalTokens as Partial<{ prompt: number; completion: number }> | undefined;
    prompt += typeof usage?.prompt === 'number' ? usage.prompt : 0;
    completion += typeof usage?.completion === 'number' ? usage.completion : 0;
  }
  return { prompt, completion };
}

function outputHash(text: string): string {
  return `sha256:${createHash('sha256').update(text).digest('hex')}`;
}

function estimateCandidateCost(
  route: { provider: string; model: string },
  usage: { prompt: number; completion: number },
): number | undefined {
  try {
    return estimateCost(
      { promptTokens: usage.prompt, completionTokens: usage.completion },
      resolveModelProfile(route.provider, { model: route.model }),
    )?.totalCostUsd;
  } catch {
    return undefined;
  }
}

function inferEvidenceClass(
  configuredProvider: string | undefined,
  route: { provider: string } | undefined,
): PiKernelShadowEvidenceClass {
  const provider = route?.provider ?? configuredProvider ?? '';
  return provider === 'fixture' ? 'deterministic' : 'live-provider';
}

function normalizeMaxTurns(value: number | undefined): number {
  if (!Number.isFinite(value)) return 6;
  return Math.max(1, Math.min(6, Math.floor(value!)));
}

function normalizeTimeout(value: number | undefined): number {
  if (!Number.isFinite(value)) return 60_000;
  return Math.max(1_000, Math.min(120_000, Math.floor(value!)));
}

function truncate(value: string): string {
  return value.length <= 500 ? value : `${value.slice(0, 500)}...[truncated]`;
}

function required(value: string | undefined, field: string): string {
  if (!value) throw new Error(`Pi shadow requires ${field}`);
  return value;
}

function linkAbortSignal(source: AbortSignal | undefined, target: AbortController): () => void {
  if (!source) return () => {};
  const abort = () => target.abort(source.reason);
  if (source.aborted) abort();
  else source.addEventListener('abort', abort, { once: true });
  return () => source.removeEventListener('abort', abort);
}
