/**
 * @los/agent/runtime-task — Shared bounded external-runtime execution.
 *
 * Used by the agent tool, message router, and gateway HTTP route. Callers own
 * authorization; this module owns adapter execution, canonical lifecycle
 * events, disconnect cancellation, bounded output, and compact evidence.
 */

import { randomUUID } from 'node:crypto';
import { getLogger } from '@los/infra/logger';
import { appendSessionEvent } from './session-events.js';
import {
  claudeCodeAvailable,
  claudeCodeSupportsOtel,
  codexAvailable,
  codexSupportsOtel,
  isOtelBridgeRunning,
  runClaudeCodeWithBridge,
  spawnCodex,
  spawnGrok,
  startOtelBridge,
  type ClaudeCodeRuntimeHandle,
  type CodexRuntimeHandle,
  type GrokRuntimeHandle,
  type RuntimeHandle,
} from './runtime-adapter/index.js';

const log = getLogger('runtime-task');

export type RuntimeTaskKind = 'codex' | 'grok' | 'claude-code';
export type ExternalRuntimeProfileKind = RuntimeTaskKind | 'gemini' | 'reasonix' | 'pi-external';
export type ExternalRuntimeEventType =
  | 'runtime.started'
  | 'runtime.process'
  | 'runtime.output'
  | 'runtime.completed'
  | 'runtime.error'
  | 'runtime.cancelled';

export interface ExternalRuntimeEvent {
  type: ExternalRuntimeEventType;
  sessionId: string;
  traceId: string;
  kind: RuntimeTaskKind;
  occurredAt: string;
  sequence: number;
  [key: string]: unknown;
}

export interface ExternalRuntimeCapability {
  kind: ExternalRuntimeProfileKind;
  displayName: string;
  implementation: 'runnable' | 'planned' | 'unavailable';
  available: boolean;
  unavailableReason?: string;
  invocationModes: Array<'http' | 'agent_tool' | 'message_command'>;
  mechanics: {
    streaming: 'lifecycle' | 'lifecycle_and_output';
    boundedOutput: boolean;
    disconnectCancellation: boolean;
    resume: boolean;
    telemetry: 'none' | 'optional_otel' | 'required_otel';
    telemetryCompatibility: 'compatible' | 'incompatible' | 'not_applicable';
    durableEvidence: 'none' | 'lifecycle' | 'lifecycle_and_output_summary';
  };
  routingHints: {
    advisoryOnly: true;
    specialties: string[];
    notes: string;
  };
}

export interface RunExternalRuntimeInput {
  kind: RuntimeTaskKind;
  prompt: string;
  /** Agent-tool compatibility surface. Seconds, default 300, clamped [30, 1800]. */
  timeoutSec?: number;
  /** HTTP/runtime surface. Milliseconds, validated to [1000, 600000]. */
  timeoutMs?: number;
  workspaceRoot: string;
  sessionId?: string;
  traceId?: string;
  tenantId?: string;
  projectId?: string;
  providerAccountId?: string;
  model?: string;
  outputLimitBytes?: number;
  extraArgs?: string[];
  env?: Record<string, string>;
  signal?: AbortSignal;
  onEvent?: (event: ExternalRuntimeEvent) => void | Promise<void>;
}

export interface RunExternalRuntimeResult {
  content: string;
  error?: string;
  exitCode: number | null;
  spawnFailed: boolean;
  truncated: boolean;
  runtime: RuntimeTaskKind;
  cancelled?: boolean;
}

export interface ExternalRuntimeExecutionDependencies {
  spawnCodex: typeof spawnCodex;
  spawnGrok: typeof spawnGrok;
  runClaudeCodeWithBridge: typeof runClaudeCodeWithBridge;
  isOtelBridgeRunning: typeof isOtelBridgeRunning;
  startOtelBridge: typeof startOtelBridge;
  persistEvent: (event: ExternalRuntimeEvent) => Promise<void>;
  now: () => Date;
}

const DEFAULT_DEPENDENCIES: ExternalRuntimeExecutionDependencies = {
  spawnCodex,
  spawnGrok,
  runClaudeCodeWithBridge,
  isOtelBridgeRunning,
  startOtelBridge,
  persistEvent: persistExternalRuntimeEvent,
  now: () => new Date(),
};

export function getExternalRuntimeCapabilities(input: {
  codex?: { available: boolean; reason?: string };
  grok?: { available: boolean; reason?: string };
  claudeCode?: { available: boolean; reason?: string };
} = {}): ExternalRuntimeCapability[] {
  const availability = {
    codex: input.codex ?? { available: codexAvailable(), reason: 'codex_cli_not_available' },
    grok: input.grok ?? { available: false, reason: 'grok_account_state_not_checked' },
    claudeCode: input.claudeCode ?? { available: claudeCodeAvailable(), reason: 'claude_code_cli_not_available' },
  };
  return [
    capability('codex', 'Codex', availability.codex, ['http', 'agent_tool', 'message_command'], 'optional_otel', codexSupportsOtel(), ['coding', 'review'], 'Bounded CLI worker; OTel is supplementary.'),
    capability('grok', 'Grok', availability.grok, ['http', 'agent_tool'], 'none', false, ['research', 'review'], 'Requires an adopted active Grok CLI account.'),
    capability('claude-code', 'Claude Code', availability.claudeCode, ['http', 'agent_tool', 'message_command'], 'optional_otel', claudeCodeSupportsOtel(), ['coding', 'review', 'planning'], 'Bounded CLI worker; OTel is supplementary.'),
    plannedCapability('gemini', 'Gemini CLI', ['coding', 'research'], 'Adapter is not implemented.'),
    plannedCapability('reasonix', 'Reasonix', ['planning', 'research', 'review'], 'Implement the external-runtime worker protocol before enabling.'),
    plannedCapability('pi-external', 'Pi External Orchestrator', ['planning', 'coding'], 'External callers may use this protocol; in-process Pi remains an ExecutionKernel.'),
  ];
}

export async function runExternalRuntime(
  input: RunExternalRuntimeInput,
  dependencyOverrides: Partial<ExternalRuntimeExecutionDependencies> = {},
): Promise<RunExternalRuntimeResult> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencyOverrides };
  const prompt = input.prompt.trim();
  if (!prompt) return failureResult(input.kind, 'prompt is required');
  if (!isRunnableKind(input.kind)) {
    return failureResult(input.kind, `unsupported runtime kind: ${input.kind} (supported: codex, grok, claude-code)`);
  }

  const timeoutMs = normalizeTimeout(input);
  if (typeof timeoutMs === 'string') return failureResult(input.kind, timeoutMs);
  const outputLimitBytes = Math.max(4_096, Math.min(512_000, input.outputLimitBytes ?? 128_000));
  const sessionId = input.sessionId ?? `runtime-${input.kind}-${randomUUID()}`;
  const traceId = input.traceId ?? randomUUID();
  let sequence = 0;
  let handle: RuntimeHandle | undefined;
  let bridgeStop: () => Promise<void> = async () => undefined;
  let cancelled = input.signal?.aborted ?? false;

  const emit = async (type: ExternalRuntimeEventType, payload: Record<string, unknown> = {}) => {
    const event: ExternalRuntimeEvent = {
      type,
      sessionId,
      traceId,
      kind: input.kind,
      occurredAt: dependencies.now().toISOString(),
      sequence: ++sequence,
      ...(input.providerAccountId ? { providerAccountId: input.providerAccountId } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...payload,
    };
    await dependencies.persistEvent(event);
    try {
      await input.onEvent?.(event);
    } catch (error) {
      if (!input.signal?.aborted) throw error;
    }
  };

  const abort = () => {
    cancelled = true;
    handle?.kill('SIGTERM');
  };
  input.signal?.addEventListener('abort', abort, { once: true });

  try {
    await emit('runtime.started', { workspaceRoot: input.workspaceRoot });
    if (cancelled) {
      await emit('runtime.cancelled', { status: 'cancelled', exitCode: null, signal: null });
      return cancelledResult(input.kind);
    }

    let outputPromise: Promise<NormalizedRuntimeOutput>;
    if (input.kind === 'codex') {
      const bridge = await ensureCodexBridge(dependencies);
      bridgeStop = bridge.stop;
      const codexHandle = dependencies.spawnCodex({
        sessionId,
        workspaceRoot: input.workspaceRoot,
        prompt,
        otelEndpoint: bridge.endpoint,
        tenantId: input.tenantId,
        projectId: input.projectId,
        traceId,
        timeoutMs,
        outputLimitBytes,
        extraArgs: input.extraArgs ?? [],
        env: input.env,
      });
      handle = codexHandle;
      outputPromise = normalizeCodexOutput(codexHandle);
    } else if (input.kind === 'claude-code') {
      const claude = await dependencies.runClaudeCodeWithBridge({
        kind: 'claude-code',
        sessionId,
        workspaceRoot: input.workspaceRoot,
        prompt,
        tenantId: input.tenantId,
        projectId: input.projectId,
        traceId,
        timeoutMs,
        outputLimitBytes,
        extraArgs: input.extraArgs ?? [],
        env: input.env,
      });
      handle = claude.handle;
      bridgeStop = claude.bridgeStop;
      outputPromise = normalizeClaudeOutput(claude.handle);
    } else {
      const grokHandle = dependencies.spawnGrok({
        sessionId,
        workspaceRoot: input.workspaceRoot,
        prompt,
        timeoutMs,
        outputLimitBytes: Math.min(outputLimitBytes, 65_536),
      });
      handle = grokHandle;
      outputPromise = normalizeGrokOutput(grokHandle);
    }

    if (cancelled) handle.kill('SIGTERM');
    await emit('runtime.process', { pid: handle.pid });
    const [exit, output] = await Promise.all([handle.exited, outputPromise]);

    if (cancelled) {
      await emit('runtime.cancelled', { status: 'cancelled', exitCode: exit.exitCode, signal: exit.signal });
      return { ...cancelledResult(input.kind), exitCode: exit.exitCode };
    }
    if (output.spawnFailed) {
      await emit('runtime.error', { error: `${input.kind}_spawn_failed` });
      return failureResult(input.kind, `${input.kind} spawn failed`, exit.exitCode, true);
    }

    await emit('runtime.output', {
      text: output.text,
      capturedBytes: output.capturedBytes,
      totalBytes: output.totalBytes,
      truncated: output.truncated,
    });
    await emit('runtime.completed', {
      exitCode: exit.exitCode,
      signal: exit.signal,
      status: exit.exitCode === 0 ? 'success' : 'failed',
    });
    return {
      content: output.text || (exit.exitCode === 0 ? '(no stdout)' : '(no output)'),
      ...(exit.exitCode === 0 ? {} : { error: `${input.kind} exited with code ${exit.exitCode}` }),
      exitCode: exit.exitCode,
      spawnFailed: false,
      truncated: output.truncated,
      runtime: input.kind,
    };
  } catch {
    handle?.kill('SIGTERM');
    if (cancelled) {
      await emit('runtime.cancelled', { status: 'cancelled', exitCode: null, signal: null }).catch(() => undefined);
      return cancelledResult(input.kind);
    }
    await emit('runtime.error', { error: `${input.kind}_runtime_failed` }).catch(() => undefined);
    return failureResult(input.kind, `${input.kind} runtime failed`);
  } finally {
    input.signal?.removeEventListener('abort', abort);
    await bridgeStop().catch(() => undefined);
  }
}

async function persistExternalRuntimeEvent(event: ExternalRuntimeEvent): Promise<void> {
  const { type, sessionId, traceId, kind, occurredAt, sequence, ...payload } = event;
  const persistedPayload = type === 'runtime.output'
    ? { ...payload, text: String(payload.text ?? '').slice(0, 2_000) }
    : payload;
  await appendSessionEvent({
    sessionId,
    traceId,
    type,
    source: `external-runtime:${kind}`,
    visibility: 'audit',
    payload: { kind, occurredAt, sequence, ...persistedPayload },
  });
}

interface NormalizedRuntimeOutput {
  text: string;
  capturedBytes: number;
  totalBytes: number;
  truncated: boolean;
  spawnFailed: boolean;
}

function normalizeCodexOutput(handle: CodexRuntimeHandle): Promise<NormalizedRuntimeOutput> {
  return handle.output.then(output => ({
    text: output.output,
    capturedBytes: output.outputBytes,
    totalBytes: output.totalBytes,
    truncated: output.truncated,
    spawnFailed: output.spawnFailed,
  }));
}

function normalizeClaudeOutput(handle: ClaudeCodeRuntimeHandle): Promise<NormalizedRuntimeOutput> {
  return handle.output.then(output => ({
    text: output.text,
    capturedBytes: output.capturedBytes,
    totalBytes: output.totalBytes,
    truncated: output.truncated,
    spawnFailed: output.spawnFailed,
  }));
}

function normalizeGrokOutput(handle: GrokRuntimeHandle): Promise<NormalizedRuntimeOutput> {
  return handle.output.then(output => ({
    text: output.text,
    capturedBytes: output.capturedBytes,
    totalBytes: output.totalBytes,
    truncated: output.truncated,
    spawnFailed: output.errorCode === 'grok_spawn_failed',
  }));
}

async function ensureCodexBridge(dependencies: ExternalRuntimeExecutionDependencies): Promise<{
  endpoint: string;
  stop: () => Promise<void>;
}> {
  if (dependencies.isOtelBridgeRunning()) {
    return { endpoint: 'http://127.0.0.1:4318', stop: async () => undefined };
  }
  try {
    const bridge = await dependencies.startOtelBridge({ source: 'codex' });
    return { endpoint: `http://127.0.0.1:${bridge.port}`, stop: bridge.stop };
  } catch (error) {
    log.warn(`Codex OTel bridge unavailable; continuing without LOS OTel ingest: ${error instanceof Error ? error.message : String(error)}`);
    return { endpoint: 'http://127.0.0.1:4318', stop: async () => undefined };
  }
}

function normalizeTimeout(input: RunExternalRuntimeInput): number | string {
  if (input.timeoutMs !== undefined) {
    if (!Number.isInteger(input.timeoutMs) || input.timeoutMs < 1_000 || input.timeoutMs > 600_000) {
      return 'timeoutMs must be an integer between 1000 and 600000';
    }
    return input.timeoutMs;
  }
  const requested = Number(input.timeoutSec ?? 300);
  const seconds = Number.isFinite(requested) ? requested : 300;
  return Math.max(30, Math.min(seconds, 1_800)) * 1_000;
}

function isRunnableKind(kind: string): kind is RuntimeTaskKind {
  return kind === 'codex' || kind === 'grok' || kind === 'claude-code';
}

function failureResult(
  runtime: RuntimeTaskKind,
  error: string,
  exitCode: number | null = null,
  spawnFailed = false,
): RunExternalRuntimeResult {
  return { content: '', error, exitCode, spawnFailed, truncated: false, runtime };
}

function cancelledResult(runtime: RuntimeTaskKind): RunExternalRuntimeResult {
  return {
    content: '',
    error: `${runtime} runtime cancelled`,
    exitCode: null,
    spawnFailed: false,
    truncated: false,
    runtime,
    cancelled: true,
  };
}

function capability(
  kind: RuntimeTaskKind,
  displayName: string,
  availability: { available: boolean; reason?: string },
  invocationModes: ExternalRuntimeCapability['invocationModes'],
  telemetry: ExternalRuntimeCapability['mechanics']['telemetry'],
  telemetryCompatible: boolean,
  specialties: string[],
  notes: string,
): ExternalRuntimeCapability {
  return {
    kind,
    displayName,
    implementation: availability.available ? 'runnable' : 'unavailable',
    available: availability.available,
    ...(!availability.available ? { unavailableReason: availability.reason ?? `${kind}_not_available` } : {}),
    invocationModes,
    mechanics: {
      streaming: 'lifecycle_and_output',
      boundedOutput: true,
      disconnectCancellation: true,
      resume: false,
      telemetry,
      telemetryCompatibility: telemetry === 'none'
        ? 'not_applicable'
        : telemetryCompatible ? 'compatible' : 'incompatible',
      durableEvidence: 'lifecycle_and_output_summary',
    },
    routingHints: { advisoryOnly: true, specialties, notes },
  };
}

function plannedCapability(
  kind: Exclude<ExternalRuntimeProfileKind, RuntimeTaskKind>,
  displayName: string,
  specialties: string[],
  notes: string,
): ExternalRuntimeCapability {
  return {
    kind,
    displayName,
    implementation: 'planned',
    available: false,
    unavailableReason: `${kind}_adapter_not_implemented`,
    invocationModes: ['http'],
    mechanics: {
      streaming: 'lifecycle',
      boundedOutput: false,
      disconnectCancellation: false,
      resume: false,
      telemetry: 'none',
      telemetryCompatibility: 'not_applicable',
      durableEvidence: 'none',
    },
    routingHints: { advisoryOnly: true, specialties, notes },
  };
}
