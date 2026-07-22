import { resolve } from 'node:path';
import {
  type KernelToolRequest,
  type KernelToolResult,
  type ToolBroker,
} from './execution-kernel.js';
import { applyPhaseGate } from './loop/phase-tool-gate.js';
import { assertNotAborted, inferToolSource, previewText, summarizeCapability, withAbort } from './loop/utils.js';
import type { AgentConfig } from './loop/types.js';
import { createPreActionFailureEvidence } from './pre-action-evidence.js';
import { preActionGate, type PreActionGateConfig } from './pre-action-gate.js';
import type { PersistedToolResultEvidence } from './semantic-eviction.js';
import type { ToolRegistry } from './tools/core/registry.js';

type EmitEvent = (event: Record<string, unknown>) => Promise<{ id?: number } | undefined>;
type SessionErrorRecord = { turn: number; type: string; toolName?: string; message: string };

export interface LosToolBrokerResult extends KernelToolResult {
  denied: boolean;
  durationMs: number;
  persistedEvidence?: PersistedToolResultEvidence;
}

export interface LosToolBroker extends ToolBroker<LosToolBrokerResult> {
  isParallelizable(name: string): boolean;
}

export function createLosToolBroker(input: {
  tools: ToolRegistry;
  config: AgentConfig;
  signal: AbortSignal | undefined;
  policy: ReturnType<typeof import('./loop/tool-resolver.js').resolveToolPolicy>;
  emitEvent: EmitEvent;
  onSessionError: (error: SessionErrorRecord) => void;
  preActionGateConfig?: PreActionGateConfig;
}): LosToolBroker {
  return {
    isParallelizable: name => input.tools.getCapability(name)?.parallelizable === true,
    execute: request => executeBrokeredTool(request, input),
  };
}

async function executeBrokeredTool(
  request: KernelToolRequest,
  context: Parameters<typeof createLosToolBroker>[0],
): Promise<LosToolBrokerResult> {
  const { tools, config, signal, policy, emitEvent, onSessionError, preActionGateConfig } = context;
  const capability = tools.getCapability(request.name);
  const toolSource = inferToolSource(capability);
  const argsLength = JSON.stringify(request.arguments).length;
  assertNotAborted(signal);

  await config.onToolCall?.(request.callId, request.name, request.arguments, request.turn);
  await config.onToolCallState?.({
    callId: request.callId,
    toolName: request.name,
    state: 'requested',
    turn: request.turn,
    input: request.arguments,
    maxAttempts: capability?.retryable ? policy.retry?.maxAttempts : 1,
    idempotent: capability?.idempotent ?? false,
    retryPolicy: policy.retry,
  });

  const callEvent = await emitEvent({
    type: 'tool.call',
    turn: request.turn,
    toolName: request.name,
    payload: {
      callId: request.callId,
      args: request.arguments,
      argsLength,
      source: toolSource,
    },
  });
  const planEvent = await emitEvent({
    type: 'tool.planned',
    turn: request.turn,
    toolName: request.name,
    parentEventId: callEvent?.id,
    payload: {
      callId: request.callId,
      capability: summarizeCapability(capability),
      policy,
      argsLength,
      source: toolSource,
    },
  });

  const decision = applyPhaseGate(
    tools.evaluateTool(request.name), request.name, config.runContractMetadata,
  ) as ReturnType<typeof tools.evaluateTool>;

  if (decision.allowed && preActionGateConfig) {
    const preCheck = preActionGate(request.name, request.arguments, preActionGateConfig);
    if (preCheck.warnings.length > 0) {
      await emitEvent({
        type: 'tool.warned',
        turn: request.turn,
        toolName: request.name,
        parentEventId: planEvent?.id ?? callEvent?.id,
        payload: {
          callId: request.callId,
          warnings: preCheck.warnings,
          knownFailure: preCheck.knownFailure,
          failurePatterns: preCheck.failurePatterns,
          fragileFile: preCheck.fragileFile,
          flaggedFiles: preCheck.flaggedFiles,
        },
      });
    }
  }

  await config.onToolCallState?.({
    callId: request.callId,
    toolName: request.name,
    state: decision.allowed ? 'approved' : 'denied',
    turn: request.turn,
    error: decision.allowed ? undefined : decision.reason,
  });
  const decisionEvent = await emitEvent({
    type: decision.allowed ? 'tool.approved' : 'tool.denied',
    turn: request.turn,
    toolName: request.name,
    parentEventId: planEvent?.id ?? callEvent?.id,
    payload: {
      callId: request.callId,
      allowed: decision.allowed,
      reasonCode: decision.allowed ? undefined : decision.reasonCode,
      reason: decision.allowed ? undefined : decision.reason,
      capability: summarizeCapability(decision.capability),
      policy: decision.policy,
    },
  });

  if (decision.allowed) {
    await config.onToolCallState?.({
      callId: request.callId,
      toolName: request.name,
      state: 'running',
      turn: request.turn,
    });
  }

  const startedAt = Date.now();
  const result = decision.allowed
    ? await withAbort(tools.execute({ name: request.name, arguments: request.arguments }), signal)
    : { content: '', error: decision.reason };
  const durationMs = Date.now() - startedAt;

  await config.onToolCallState?.({
    callId: request.callId,
    toolName: request.name,
    state: result.error ? 'failed' : 'succeeded',
    turn: request.turn,
    outputSummary: result.error ? undefined : previewText(result.content, 200),
    error: result.error,
    durationMs,
    attempt: result.attempts ?? 1,
  });

  if (result.error) {
    onSessionError({
      turn: request.turn,
      type: decision.allowed ? 'tool_execution_error' : 'tool_denied',
      toolName: request.name,
      message: result.error,
    });
  }

  const content = result.error ?? result.content;
  await emitEvent({
    type: 'tool.result',
    turn: request.turn,
    toolName: request.name,
    parentEventId: decisionEvent?.id ?? callEvent?.id,
    payload: {
      callId: request.callId,
      ok: !result.error,
      denied: !decision.allowed,
      reasonCode: decision.allowed ? undefined : decision.reasonCode,
      durationMs,
      attempts: result.attempts ?? 1,
      retried: result.retried ?? false,
      retryErrors: result.retryErrors ?? [],
      contentPreview: previewText(content),
      contentLength: content.length,
      errorPreview: result.error ? previewText(result.error) : undefined,
      source: toolSource,
    },
  });

  if (decision.allowed && result.error && preActionGateConfig) {
    const evidence = createPreActionFailureEvidence(
      request.name,
      request.arguments,
      result.error,
      request.callId,
    );
    preActionGateConfig.failureFingerprints?.add(evidence.fingerprint);
    if (evidence.filePath) preActionGateConfig.fragileFiles?.add(evidence.filePath);
    await emitEvent({
      type: 'tool.pre_action.failure',
      turn: request.turn,
      toolName: request.name,
      parentEventId: decisionEvent?.id ?? callEvent?.id,
      payload: evidence,
    });
  }

  return {
    callId: request.callId,
    content,
    error: result.error,
    denied: !decision.allowed,
    durationMs,
    persistedEvidence: result.error
      ? undefined
      : buildPersistedEvidence(request.name, request.arguments, config.workspaceRoot),
  };
}

function buildPersistedEvidence(
  toolName: string,
  args: Record<string, unknown>,
  workspaceRoot: string | undefined,
): PersistedToolResultEvidence | undefined {
  if (toolName !== 'read_file' && toolName !== 'list_directory' && toolName !== 'directory_tree') {
    return undefined;
  }
  const defaultPath = toolName === 'read_file' ? undefined : '.';
  const requestedPath = typeof args.path === 'string' && args.path.trim() ? args.path.trim() : defaultPath;
  if (!requestedPath) return undefined;
  const absolutePath = resolve(workspaceRoot ?? process.cwd(), requestedPath);
  return {
    toolName,
    locations: [{
      kind: 'workspace_path',
      id: absolutePath,
      label: `${toolName} source ${absolutePath}`,
    }],
  };
}
