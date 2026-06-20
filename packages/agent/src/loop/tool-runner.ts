/**
 * @los/agent/loop/tool-runner — Execute tool calls within a turn.
 *
 * Extracted from loop.ts to keep the main loop under the 400-line CI warning
 * threshold. Handles: tool.repair, tool.call → tool.planned → tool.approved|denied
 * → execute → tool.result, plus session error tracking.
 *
 * Parallelization strategy: tool calls are grouped by side-effect boundaries.
 * All parallelizable (read-only, idempotent) tools in a contiguous block run
 * concurrently. When a mutating tool is encountered, the batch flushes before
 * the mutating tool executes, ensuring ordering. This preserves sequential
 * semantics for write-dependent tool chains while gaining parallelism for
 * independent reads.
 */

import { assertNotAborted, withAbort, inferToolSource, summarizeCapability, previewText } from './utils.js';
import { applyPhaseGate } from './phase-tool-gate.js';
import { preActionGate, type PreActionGateConfig } from '../pre-action-gate.js';
import type { ToolRegistry } from '../tools/core/registry.js';
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

interface ToolCallResult {
  index: number;
  callId: string;
  toolName: string;
  content: string;
  ok: boolean;
  denied: boolean;
  durationMs: number;
  error?: string;
}

export async function runToolCalls(input: RunToolCallsInput): Promise<{
  toolResults: string[];
  toolMessages: Message[];
}> {
  const { toolCalls, turn, tools, config, signal, policy, emitEvent, onSessionError } = input;

  // Phase 1: Validate and plan all tool calls (sequential — validation is cheap)
  const plans = toolCalls.map((tc, index) =>
    prepareToolCall({ index, tc, turn, tools, config, signal, policy, emitEvent, onSessionError })
  );

  // Phase 2: Execute in parallel batches respecting side-effect boundaries
  const results: ToolCallResult[] = [];
  let batch: Array<() => Promise<ToolCallResult>> = [];

  for (const plan of plans) {
    const capability = tools.getCapability(plan.tc.function.name);
    const isParallelizable = capability?.parallelizable === true;

    if (isParallelizable) {
      // Defer — will run in parallel with other parallelizable tools
      batch.push(plan.execute);
    } else {
      // Flush pending batch before executing this mutating tool
      if (batch.length > 0) {
        const batchResults = await Promise.all(batch.map(fn => fn()));
        results.push(...batchResults);
        batch = [];
      }
      // Execute the mutating tool sequentially
      const result = await plan.execute();
      results.push(result);
    }
  }

  // Flush any remaining batch
  if (batch.length > 0) {
    const batchResults = await Promise.all(batch.map(fn => fn()));
    results.push(...batchResults);
  }

  // Sort back to original order so model sees results in call order
  results.sort((a, b) => a.index - b.index);

  const toolResults = results.map(r => r.content);
  const toolMessages = results.map(r => ({
    role: 'tool' as const,
    content: r.content.slice(0, 8000),
    tool_call_id: r.callId,
  }));

  return { toolResults, toolMessages };
}

interface PreparedToolCall {
  index: number;
  tc: ToolCall;
  execute: () => Promise<ToolCallResult>;
}

function prepareToolCall(input: {
  index: number;
  tc: ToolCall;
  turn: number;
  tools: ToolRegistry;
  config: AgentConfig;
  signal: AbortSignal | undefined;
  policy: ReturnType<typeof import('./tool-resolver.js').resolveToolPolicy>;
  emitEvent: EmitEvent;
  onSessionError: (err: SessionErrorRecord) => void;
}): PreparedToolCall {
  const { index, tc, turn, tools, config, signal, policy, emitEvent, onSessionError } = input;
  const fn = tc.function;

  return {
    index,
    tc,
    execute: async () => {
      assertNotAborted(signal);

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

      // ── Pre-action gate: check known failure patterns ──
      if (decision.allowed) {
        const gateConfig: PreActionGateConfig = {
          fragileFiles: (config as any).fragileFiles,
          failureFingerprints: (config as any).failureFingerprints,
          maxAttemptsBeforeWarn: (config as any).maxAttemptsBeforeWarn ?? 2,
        };
        const preCheck = preActionGate(fn.name, args, gateConfig);
        if (preCheck.warnings.length > 0) {
          await emitEvent({
            type: 'tool.warned',
            turn,
            toolName: fn.name,
            parentEventId: planEvent?.id ?? callEvent?.id,
            payload: {
              callId: tc.id,
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

      return {
        index,
        callId: tc.id,
        toolName: fn.name,
        content,
        ok: !result.error,
        denied: !decision.allowed,
        durationMs: toolDurationMs,
        error: result.error,
      };
    },
  };
}
