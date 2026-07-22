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

import { assertNotAborted } from './utils.js';
import {
  preActionGateConfigFromAgentOptions,
  type PreActionGateConfig,
} from '../pre-action-gate.js';
import { createLosToolBroker } from '../los-tool-broker.js';
import type { PersistedToolResultEvidence } from '../semantic-eviction.js';
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
  preActionGateConfig?: PreActionGateConfig;
}

interface ToolCallResult {
  index: number;
  callId: string;
  toolName: string;
  content: string;
  ok: boolean;
  denied: boolean;
  durationMs: number;
  persistedEvidence?: PersistedToolResultEvidence;
  error?: string;
}

export async function runToolCalls(input: RunToolCallsInput): Promise<{
  toolResults: string[];
  toolMessages: Message[];
  persistedToolResults: Map<string, PersistedToolResultEvidence>;
}> {
  const { toolCalls, turn, tools, config, signal, policy, emitEvent, onSessionError } = input;
  const preActionGateConfig = input.preActionGateConfig
    ?? preActionGateConfigFromAgentOptions(config.preActionGate);
  const broker = createLosToolBroker({
    tools, config, signal, policy, emitEvent, onSessionError, preActionGateConfig,
  });

  // Phase 1: Validate and plan all tool calls (sequential — validation is cheap)
  const plans = toolCalls.map((tc, index) =>
    prepareToolCall({
      index, tc, turn, signal, emitEvent, onSessionError, broker,
    })
  );

  // Phase 2: Execute in parallel batches respecting side-effect boundaries
  const results: ToolCallResult[] = [];
  let batch: Array<() => Promise<ToolCallResult>> = [];

  for (const plan of plans) {
    const isParallelizable = broker.isParallelizable(plan.tc.function.name);

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
  const persistedToolResults = new Map(
    results
      .filter((result): result is ToolCallResult & { persistedEvidence: PersistedToolResultEvidence } => Boolean(result.persistedEvidence))
      .map(result => [result.callId, result.persistedEvidence]),
  );

  return { toolResults, toolMessages, persistedToolResults };
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
  signal: AbortSignal | undefined;
  emitEvent: EmitEvent;
  onSessionError: (err: SessionErrorRecord) => void;
  broker: ReturnType<typeof createLosToolBroker>;
}): PreparedToolCall {
  const {
    index, tc, turn, signal, emitEvent, onSessionError, broker,
  } = input;
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

      const result = await broker.execute({
        callId: tc.id,
        name: fn.name,
        arguments: args,
        turn,
      });

      return {
        index,
        callId: tc.id,
        toolName: fn.name,
        content: result.content,
        ok: !result.error,
        denied: result.denied,
        durationMs: result.durationMs,
        persistedEvidence: result.persistedEvidence,
        error: result.error,
      };
    },
  };
}
