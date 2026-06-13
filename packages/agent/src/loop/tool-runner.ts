/**
 * @los/agent/loop/tool-runner — Execute tool calls within a turn.
 *
 * Extracted from loop.ts to keep the main loop under the 400-line CI warning
 * threshold. Handles: tool.repair, tool.call → tool.planned → tool.approved|denied
 * → execute → tool.result, plus session error tracking.
 */

import { assertNotAborted, withAbort, inferToolSource, summarizeCapability, previewText } from './utils.js';
import { applyPhaseGate } from './phase-tool-gate.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { AgentConfig } from './types.js';
import type { Message, ToolCall } from '../providers/index.js';

type SessionErrorRecord = { turn: number; type: string; toolName?: string; message: string };
type EmitEvent = (event: any) => Promise<any>;

export interface RunToolCallsInput {
  toolCalls: ToolCall[];
  turn: number;
  tools: ToolRegistry;
  config: AgentConfig;
  signal: AbortSignal | undefined;
  policy: ReturnType<typeof import('./tool-resolver.js').resolveToolPolicy>;
  emitEvent: EmitEvent;
  onSessionError: (err: SessionErrorRecord) => void;
}

export async function runToolCalls(input: RunToolCallsInput): Promise<{
  toolResults: string[];
  toolMessages: Message[];
}> {
  const { toolCalls, turn, tools, config, signal, policy, emitEvent, onSessionError } = input;
  const toolResults: string[] = [];
  const toolMessages: Message[] = [];

  for (const tc of toolCalls) {
    assertNotAborted(signal);
    const fn = tc.function;

    // Emit tool.repair if provider repaired malformed arguments
    if (tc._repair?.repaired) {
      await emitEvent({
        type: 'tool.repair',
        turn,
        toolName: fn.name,
        payload: {
          callId: tc.id,
          repairSteps: tc._repair.repairSteps ?? [],
        },
      });
      onSessionError({
        turn,
        type: 'tool_repair',
        toolName: fn.name,
        message: `Repaired tool call arguments for ${fn.name}: ${(tc._repair.repairSteps ?? []).join(', ')}`,
      });
    }

    let args: Record<string, unknown>;
    try {
      args = fn.arguments ? JSON.parse(fn.arguments) as Record<string, unknown> : {};
    } catch (err: any) {
      onSessionError({
        turn,
        type: 'tool_parse_error',
        toolName: fn.name,
        message: `Failed to parse tool arguments: ${err?.message ?? String(err)}`,
      });
      await emitEvent({
        type: 'tool.result',
        turn,
        toolName: fn.name,
        parentEventId: undefined,
        payload: {
          callId: tc.id,
          ok: false,
          durationMs: 0,
          contentPreview: '',
          contentLength: 0,
          errorPreview: `Invalid tool arguments: ${err?.message ?? String(err)}`,
        },
      });
      throw err;
    }

    const capability = tools.getCapability(fn.name);
    const toolSource = inferToolSource(capability);
    await config.onToolCall?.(tc.id, fn.name, args, turn);

    await config.onToolCallState?.({
      callId: tc.id,
      toolName: fn.name,
      state: 'requested',
      turn,
      input: args,
      maxAttempts: capability?.retryable ? (policy as any).retry?.maxAttempts : 1,
      idempotent: capability?.idempotent ?? false,
      retryPolicy: (policy as any).retry,
    });

    const callEvent = await emitEvent({
      type: 'tool.call',
      turn,
      toolName: fn.name,
      payload: {
        callId: tc.id,
        args,
        argsLength: fn.arguments.length,
        source: toolSource,
      },
    });

    const planEvent = await emitEvent({
      type: 'tool.planned',
      turn,
      toolName: fn.name,
      parentEventId: callEvent?.id,
      payload: {
        callId: tc.id,
        capability: summarizeCapability(capability),
        policy,
        argsLength: fn.arguments.length,
        source: toolSource,
      },
    });

    const decision = applyPhaseGate(
      tools.evaluateTool(fn.name), fn.name, config.runContractMetadata,
    ) as ReturnType<typeof tools.evaluateTool>;

    await config.onToolCallState?.({
      callId: tc.id, toolName: fn.name,
      state: decision.allowed ? 'approved' : 'denied',
      turn,
      error: decision.allowed ? undefined : decision.reason,
    });

    const decisionEvent = await emitEvent({
      type: decision.allowed ? 'tool.approved' : 'tool.denied',
      turn,
      toolName: fn.name,
      parentEventId: planEvent?.id ?? callEvent?.id,
      payload: {
        callId: tc.id,
        allowed: decision.allowed,
        reasonCode: decision.allowed ? undefined : decision.reasonCode,
        reason: decision.allowed ? undefined : decision.reason,
        capability: summarizeCapability(decision.capability),
        policy: decision.policy,
      },
    });

    if (decision.allowed) {
      await config.onToolCallState?.({
        callId: tc.id, toolName: fn.name, state: 'running', turn,
      });
    }

    const toolStartedAt = Date.now();
    const result = decision.allowed
      ? await withAbort(
          tools.execute({ name: fn.name, arguments: args }),
          signal,
        )
      : { content: '', error: decision.reason };
    const toolDurationMs = Date.now() - toolStartedAt;

    await config.onToolCallState?.({
      callId: tc.id, toolName: fn.name,
      state: result.error ? 'failed' : 'succeeded',
      turn,
      outputSummary: result.error ? undefined : previewText(result.content, 200),
      error: result.error,
      durationMs: toolDurationMs,
      attempt: result.attempts ?? 1,
    });

    if (result.error) {
      onSessionError({
        turn,
        type: decision.allowed ? 'tool_execution_error' : 'tool_denied',
        toolName: fn.name,
        message: result.error,
      });
    }

    const content = result.error ?? result.content;
    toolResults.push(content);
    await emitEvent({
      type: 'tool.result',
      turn,
      toolName: fn.name,
      parentEventId: decisionEvent?.id ?? callEvent?.id,
      payload: {
        callId: tc.id,
        ok: !result.error,
        denied: !decision.allowed,
        reasonCode: decision.allowed ? undefined : decision.reasonCode,
        durationMs: toolDurationMs,
        attempts: result.attempts ?? 1,
        retried: result.retried ?? false,
        retryErrors: result.retryErrors ?? [],
        contentPreview: previewText(content),
        contentLength: content.length,
        errorPreview: result.error ? previewText(result.error) : undefined,
        source: toolSource,
      },
    });

    toolMessages.push({
      role: 'tool',
      content: content.slice(0, 8000),
      tool_call_id: tc.id,
    });
  }

  return { toolResults, toolMessages };
}
