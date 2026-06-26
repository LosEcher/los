/**
 * Pre-send healing — fix message-history issues that would cause provider 400s.
 *
 * ADR 0024 (Tool-Call / Protocol Repair Pipeline), step 1+3. This is the first
 * concrete stage of the `healBeforeSend` orchestration. The agent loop only
 * ever appends `assistant(tool_calls)` + matching `tool` messages together, so
 * within a single run the history is always paired. The unpaired case arises
 * when a session is resumed via `config.initialMessages` after an interrupted
 * tool turn — the last assistant emitted `tool_calls` but the tool results
 * were never persisted/sent. Most providers (DeepSeek especially) reject such
 * history with 400 on the next request.
 *
 * Previously los only *detected* orphans at the session-event layer
 * (`session-trace.ts validateTraceCompleteness`). This module upgrades that
 * detection to a pre-send *fix*: drop the unpaired assistant + its orphan tool
 * messages before the request goes out.
 *
 * Universal (all profiles) — not gated by `ModelProfile`. Reasonix reference:
 * `src/loop/healing.ts` `fixToolCallPairing` / `stampMissingIds`.
 */

import { getLogger } from '@los/infra/logger';
import type { Message } from '../types.js';
import { incrementRepairCounter } from '../repair-telemetry.js';

const log = getLogger('agent');

export interface HealingResult {
  messages: Message[];
  /** Assistant messages dropped because at least one tool_call had no matching tool result. */
  droppedUnpairedAssistant: number;
  /** Tool messages dropped because their parent assistant was dropped, or no assistant ever declared them. */
  droppedOrphanTool: number;
  /** True if the message array was modified in any way. */
  changed: boolean;
}

/**
 * Repair tool-call pairing in a message history.
 *
 * Rules:
 *   1. An assistant message with `tool_calls` is kept only if EVERY tool_call
 *      id has a corresponding `tool` result message. If any id is unpaired,
 *      the whole assistant message is dropped (partial tool_calls in one
 *      assistant message is itself invalid for most APIs).
 *   2. A `tool` message is dropped if its parent assistant was dropped, or if
 *      no assistant in the history ever declared its `tool_call_id` (orphan).
 *
 * Pure transformation; does not call the provider. When nothing changed, the
 * input array reference is returned untouched so callers can skip an in-place
 * rebuild.
 *
 * Note: `stampMissingIds` (Reasonix `z-ext-*` synthesis) is deferred — los
 * providers always assign `call_${index}` ids (`delta-repair.ts`), so the
 * missing-id case does not arise in practice. If a future provider emits bare
 * calls, add a pre-pass here that stamps ids before the pairing check.
 */
export function fixToolCallPairing(messages: Message[], providerName: string): HealingResult {
  // tool_call_ids that have a corresponding tool result message.
  const resultIds = new Set<string>();
  for (const m of messages) {
    if (m.role === 'tool' && m.tool_call_id) resultIds.add(m.tool_call_id);
  }

  // tool_call_ids declared by any assistant message (parents).
  const declaredIds = new Set<string>();
  for (const m of messages) {
    if (m.role === 'assistant' && m.tool_calls) {
      for (const tc of m.tool_calls) if (tc.id) declaredIds.add(tc.id);
    }
  }

  // First pass: mark which assistant tool_call_ids belong to unpaired assistants.
  const droppedAssistantCallIds = new Set<string>();
  for (const m of messages) {
    if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
      const ids = m.tool_calls.map(tc => tc.id).filter(Boolean);
      const allPaired = ids.length > 0 && ids.every(id => resultIds.has(id));
      if (!allPaired) {
        for (const tc of m.tool_calls) droppedAssistantCallIds.add(tc.id);
      }
    }
  }

  // Second pass: rebuild, reusing pass 1's droppedAssistantCallIds membership
  // instead of recomputing the allPaired predicate.
  const result: Message[] = [];
  let droppedUnpairedAssistant = 0;
  let droppedOrphanTool = 0;

  for (const m of messages) {
    if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
      // An assistant is unpaired iff any of its tool_call ids was marked in pass 1.
      const isUnpaired = m.tool_calls.some(tc => tc.id && droppedAssistantCallIds.has(tc.id));
      if (isUnpaired) {
        droppedUnpairedAssistant++;
        continue;
      }
      result.push(m);
      continue;
    }

    if (m.role === 'tool') {
      const id = m.tool_call_id;
      // Drop if parent was dropped, or if no assistant ever declared this id.
      if (!id || droppedAssistantCallIds.has(id) || !declaredIds.has(id)) {
        droppedOrphanTool++;
        continue;
      }
      result.push(m);
      continue;
    }

    result.push(m);
  }

  const changed = droppedUnpairedAssistant > 0 || droppedOrphanTool > 0;

  if (changed) {
    incrementRepairCounter(providerName, 'unpaired_tool_call_dropped');
    log.warn(
      `[${providerName}] healBeforeSend: dropped ${droppedUnpairedAssistant} unpaired assistant ` +
        `tool_call message(s), ${droppedOrphanTool} orphan tool message(s).`,
    );
  }

  return {
    messages: changed ? result : messages,
    droppedUnpairedAssistant,
    droppedOrphanTool,
    changed,
  };
}
