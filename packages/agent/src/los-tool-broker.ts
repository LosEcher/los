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
import { evaluateOperatorRuleGate } from './operator-rules-runtime.js';
import type { PersistedToolResultEvidence } from './semantic-eviction.js';
import type { ToolRegistry } from './tools/core/registry.js';
import { evaluateApprovalGate, evaluateScopeGate, type ApprovalEnforcement, type ScopeEnforcement } from './tools/core/registry-policy.js';

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
  /** Approval enforcement for `needsApproval` tools. Defaults to warn. */
  approvalEnforcement?: ApprovalEnforcement;
  /** Scope enforcement. Defaults to warn; set LOS_TOOL_SCOPE_ENFORCEMENT=block to deny. */
  scopeEnforcement?: ScopeEnforcement;
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

  // Scope 读取点。默认 warn（记录事件、照常执行）；设 LOS_TOOL_SCOPE_ENFORCEMENT=block
  // 后与 approval gate 同样的 fail-closed 语义：拒绝、handler 不执行。
  const scopeCheck = evaluateScopeGate(capability ?? undefined, request.arguments, {
    tenantId: config.tenantId,
    projectId: config.projectId,
    runSpecId: config.runSpecId,
    sessionId: config.sessionId,
    taskRunId: config.taskRunId,
  });
  const scopeEnforcement: ScopeEnforcement =
    context.scopeEnforcement
    ?? (process.env.LOS_TOOL_SCOPE_ENFORCEMENT === 'block' ? 'block' : 'warn');
  if (scopeCheck) {
    const isMismatch = 'mismatch' in scopeCheck;
    await emitEvent({
      type: 'tool.scope_mismatch',
      turn: request.turn,
      toolName: request.name,
      parentEventId: planEvent?.id ?? callEvent?.id,
      payload: {
        callId: request.callId,
        mode: scopeEnforcement,
        action: scopeEnforcement,
        scopeId: isMismatch ? scopeCheck.mismatch.scopeId : scopeCheck.contextMissing,
        requested: isMismatch ? scopeCheck.mismatch.requested : scopeCheck.requested,
        ...(isMismatch
          ? { context: scopeCheck.mismatch.context }
          : { contextMissing: true }),
      },
    });
  }

  let decision = applyPhaseGate(
    tools.evaluateTool(request.name), request.name, config.runContractMetadata,
  ) as ReturnType<typeof tools.evaluateTool>;

  if (decision.allowed && preActionGateConfig) {
    // readOnlyOperation comes from the registered capability metadata
    // (sideEffect: false), so fragile-file wording matches the actual
    // operation instead of always claiming the path "is being modified".
    const preCheck = preActionGate(
      request.name,
      request.arguments,
      preActionGateConfig,
      capability?.sideEffect === false,
    );
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

  // Operator rules hard gate (after capability/phase, before execute). Pure — no DB.
  if (decision.allowed) {
    const ruleDecision = evaluateOperatorRuleGate(
      request.name,
      request.arguments,
      config.operatorRulesGate,
    );
    if (ruleDecision.action === 'warn' && ruleDecision.reason) {
      await emitEvent({
        type: 'rule.enforced',
        turn: request.turn,
        toolName: request.name,
        parentEventId: planEvent?.id ?? callEvent?.id,
        payload: {
          callId: request.callId,
          ruleId: ruleDecision.ruleId,
          ruleName: ruleDecision.ruleName,
          severity: ruleDecision.severity,
          enforcementMode: ruleDecision.enforcementMode,
          action: 'warn',
          toolName: request.name,
          reason: ruleDecision.reason,
        },
      });
    }
    if (!ruleDecision.allowed) {
      decision = {
        allowed: false,
        reason: ruleDecision.reason ?? 'blocked by operator rule',
        reasonCode: 'operator_rule_block',
        capability: decision.capability,
        policy: decision.policy,
      };
      await emitEvent({
        type: 'rule.enforced',
        turn: request.turn,
        toolName: request.name,
        parentEventId: planEvent?.id ?? callEvent?.id,
        payload: {
          callId: request.callId,
          ruleId: ruleDecision.ruleId,
          ruleName: ruleDecision.ruleName,
          severity: ruleDecision.severity,
          enforcementMode: ruleDecision.enforcementMode,
          action: 'block',
          toolName: request.name,
          reason: ruleDecision.reason,
        },
      });
    }
  }

  // Approval gate. `needsApproval` is declared by four tools (run_shell,
  // run_remote_command, run_runtime_task, the background shell).
  //
  // A stateless executor has no interactive approval channel, so it must block
  // by construction rather than rely on an env flag: `executionMode=stateless`
  // (set by the executor from EXECUTOR_DB_MODE=none) wins over everything.
  // Interactive/local runs keep warn-by-default until the warn events show
  // nobody relies on the missing channel; LOS_TOOL_APPROVAL_ENFORCEMENT=block
  // opts them in explicitly.
  if (decision.allowed) {
    const enforcement: ApprovalEnforcement =
      context.config.executionMode === 'stateless'
        ? 'block'
        : context.approvalEnforcement
          ?? (process.env.LOS_TOOL_APPROVAL_ENFORCEMENT === 'block' ? 'block' : 'warn');
    const gate = evaluateApprovalGate(decision.capability, enforcement);
    if (gate.action !== 'allow') {
      await emitEvent({
        type: 'tool.approval_required',
        turn: request.turn,
        toolName: request.name,
        parentEventId: planEvent?.id ?? callEvent?.id,
        payload: {
          callId: request.callId,
          action: gate.action,
          enforcementMode: enforcement,
          reason: gate.reason,
        },
      });
      if (gate.action === 'block' && decision.allowed) {
        decision = {
          allowed: false,
          reasonCode: 'tool_approval_required',
          reason: gate.reason ?? 'tool requires approval',
          capability: decision.capability,
          policy: decision.policy,
        };
      }
    }
  }

  // Scope deny（仅 block 档，且前面的 gate 还没拒）。放在这里而不是更早，
  // 是为了让 warn 事件先发出——观察期需要看到"本会拒绝"的调用，而不是被别的 gate 吞掉。
  if (decision.allowed && scopeCheck && scopeEnforcement === 'block') {
    const scopeId = 'mismatch' in scopeCheck ? scopeCheck.mismatch.scopeId : scopeCheck.contextMissing;
    decision = {
      allowed: false,
      reasonCode: 'tool_scope_mismatch',
      reason: `Tool ${request.name} was called with a ${scopeId} outside the current run scope`,
      capability: decision.capability,
      policy: decision.policy,
    };
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
