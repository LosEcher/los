/**
 * Delta repair — provider-specific streaming delta merging quirks.
 *
 * Handles orphan args, split tool calls, phantom call detection, and
 * PackyCode/DeepSeek-specific delta normalization. Extracted from the
 * provider adapter to keep the main file under the 600-line CI limit.
 */

import { getLogger } from '@los/infra/logger';
import type { ToolCall } from './types.js';
import { incrementRepairCounter } from './repair-telemetry.js';

const log = getLogger('agent');

export function mergeToolCallDeltas(toolCalls: Map<number, ToolCall>, deltas: any[]): void {
  for (const delta of deltas) {
    let index: number;
    if (Number.isInteger(delta.index)) {
      // PackyCode quirk: the first delta (with name) uses index=0, but all
      // subsequent argument deltas use index=1. When an index-only delta
      // (no id, no name) points to a non-existent entry, route it to the
      // last existing entry instead of creating a phantom tool call.
      if (!delta.id && !delta.function?.name && !toolCalls.has(delta.index) && toolCalls.size > 0) {
        index = toolCalls.size - 1;
      } else if (!delta.function?.name && delta.function?.arguments && !toolCalls.has(delta.index) && toolCalls.size > 0) {
        // L2: Orphan args delta (has arguments but no name) with an index that
        // doesn't exist — try to find a name-only entry to merge into instead
        // of creating a phantom tool call.
        const target = findNameOnlyEntry(toolCalls);
        index = target >= 0 ? target : delta.index;
      } else {
        index = delta.index;
      }
    } else if (delta.id && typeof delta.id === 'string') {
      // No index — try to match an existing entry by call id.
      let found = -1;
      for (const [k, v] of toolCalls) {
        if (v.id === delta.id) { found = k; break; }
      }
      if (found >= 0) {
        index = found;
      } else if (!delta.function?.name && delta.function?.arguments) {
        // L2: Orphan args with an unknown id (e.g. PackyCode assigns a
        // different call id to follow-up argument deltas). Find a name-only
        // entry to merge into instead of creating a phantom tool call.
        const target = findNameOnlyEntry(toolCalls);
        index = target >= 0 ? target : toolCalls.size;
      } else {
        index = toolCalls.size;
      }
    } else {
      // No index and no id — continuation delta for the most recent tool call
      // (PackyCode and some OpenAI-compatible proxies omit index on follow-up deltas).
      index = toolCalls.size > 0 ? toolCalls.size - 1 : 0;
    }
    const existing = toolCalls.get(index) ?? {
      id: delta.id ?? `call_${index}`,
      type: 'function' as const,
      function: { name: '', arguments: '' },
    };
    // L2: When an orphan args delta (has arguments but no name) merges into an
    // existing entry, preserve the existing entry's id. This prevents a
    // provider-generated fallback id (e.g. "call_1") from overwriting the
    // original meaningful id set by the name delta.
    const isOrphanArgs = !delta.function?.name && delta.function?.arguments;
    toolCalls.set(index, {
      ...existing,
      id: isOrphanArgs ? existing.id : (delta.id || existing.id),
      type: 'function',
      function: {
        name: existing.function.name + (delta.function?.name ?? ''),
        arguments: existing.function.arguments + (delta.function?.arguments ?? ''),
      },
    });
  }
}

/** L2 helper: find the index of the first entry with a name but no arguments. */
function findNameOnlyEntry(toolCalls: Map<number, ToolCall>): number {
  for (const [k, v] of toolCalls) {
    if (v.function.name && !v.function.arguments) {
      return k;
    }
  }
  return -1;
}

/**
 * Post-processing repair for split tool calls (方案 B).
 *
 * When a provider/streaming quirk separates the function name and arguments
 * into two adjacent entries (one has name but no args, the other has args
 * but no name), this function merges them back together.
 *
 * Pairs are matched by index proximity. Unmatched name-only entries are kept
 * (the tool name is at least known); unmatched args-only entries are assigned
 * a synthetic name with a repair marker so that no tool call is silently lost.
 */
export function mergeSplitToolCalls(toolCalls: ToolCall[], providerName: string): ToolCall[] {
  const nameOnly: number[] = [];
  const argsOnly: number[] = [];
  const result: ToolCall[] = [];

  for (let i = 0; i < toolCalls.length; i++) {
    const tc = toolCalls[i];
    const hasName = Boolean(tc.function.name);
    const hasArgs = Boolean(tc.function.arguments);

    if (hasName && hasArgs) {
      result.push(tc);
    } else if (hasName && !hasArgs) {
      nameOnly.push(i);
    } else if (!hasName && hasArgs) {
      argsOnly.push(i);
    }
    // Both empty: fully phantom, silently dropped
  }

  // Pair name-only with args-only by index proximity
  const usedArgs = new Set<number>();
  for (const ni of nameOnly) {
    let bestAi = -1;
    let bestDist = Infinity;
    for (const ai of argsOnly) {
      if (usedArgs.has(ai)) continue;
      const dist = Math.abs(ai - ni);
      if (dist < bestDist) {
        bestDist = dist;
        bestAi = ai;
      }
    }
    if (bestAi >= 0) {
      usedArgs.add(bestAi);
      incrementRepairCounter(providerName, 'split_tool_call_merged');
      const nameTc = toolCalls[ni];
      const argsTc = toolCalls[bestAi];
      result.push({
        ...nameTc,
        function: {
          name: nameTc.function.name,
          arguments: argsTc.function.arguments,
        },
        _repair: {
          repaired: true,
          originalArguments: nameTc.function.arguments,
          repairSteps: ['split-tool-call-merge'],
        },
      } as ToolCall);
    } else {
      incrementRepairCounter(providerName, 'name_only_unmatched');
      log.warn(`[${providerName}] Tool call "${toolCalls[ni].function.name}" has no arguments (no matching orphan found)`);
      result.push(toolCalls[ni]);
    }
  }

  // Emit synthetic tool calls for unmatched args-only orphans instead of
  // silently dropping them, so that:
  // (a) the loop can surface an error the user/operator can act on, and
  // (b) telemetry counters quantify the drop rate per provider.
  for (const ai of argsOnly) {
    if (!usedArgs.has(ai)) {
      const orphan = toolCalls[ai];
      incrementRepairCounter(providerName, 'orphan_args_unmatched');
      const syntheticName = `_orphan_args_${orphan.id || ai}`;
      log.warn(
        `[${providerName}] Unmatched orphan tool call arguments (id=${orphan.id}, ` +
        `argsLen=${orphan.function.arguments.length}). ` +
        `Synthetic name assigned: ${syntheticName}`,
      );
      result.push({
        ...orphan,
        function: {
          name: syntheticName,
          arguments: orphan.function.arguments,
        },
        _repair: {
          repaired: true,
          originalArguments: orphan.function.arguments,
          repairSteps: ['orphan-args-synthetic'],
        },
      } as ToolCall);
    }
  }

  return result;
}
