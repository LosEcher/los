/**
 * Repair pipeline orchestration — ADR 0024.
 *
 * Organizes los's protocol-layer repair into two hooks wired into the agent
 * loop:
 *
 *   healBeforeSend(messages, ctx)   — pre-send, fixes message history (400 risks)
 *   repairToolCalls(calls, ctx)     — post-response, before dispatch (storm/scavenge/truncation)
 *
 * Why an orchestration layer: los already had repair logic, but it was scattered
 * across `delta-repair.ts`, `openai-utils.ts`, and the provider stream-end
 * (`index.ts`). The streaming delta-merge and JSON repair stay in the provider
 * (they run mid-stream). This module owns the *pre-send* and *post-response*
 * stages that need the full message history or the model profile — the gaps
 * Reasonix closes with its `healActiveLogBeforeSend` / `repair.process` pipeline.
 *
 * All stages MUST be gated by `ModelProfile` (ADR 0007) — no hardcoded model
 * names. The pairing fix is universal; storm is universal; scavenge /
 * reasoning retention / flatten (later steps) read profile fields.
 *
 * Reference: `/Users/echerlos/syncthing/project/DeepSeek-Reasonix` `src/repair/index.ts`
 * and `src/loop/healing.ts`.
 */

import { getLogger } from '@los/infra/logger';
import type { Message, ToolCall } from './types.js';
import type { ModelProfile } from '../model-profiles.js';
import { fixToolCallPairing, type HealingResult } from './repair/healing.js';
import { StormBreaker } from './repair/storm.js';
import { incrementRepairCounter } from './repair-telemetry.js';

const log = getLogger('agent');

export interface RepairContext {
  providerName: string;
  profile: ModelProfile;
  traceId?: string;
  /** Optional storm-breaker state (persisted across loop iterations). */
  stormBreaker?: StormBreaker;
}

export type HealResult = HealingResult;

export interface RepairToolCallsResult {
  calls: ToolCall[];
  suppressedCount: number;
  notes: string[];
}

/**
 * Pre-send healing. Mutates `messages` in place when repair is needed.
 * Call immediately before `provider.chat()`.
 *
 * Step 1: fixToolCallPairing (universal). Later steps add reasoning retention
 * and flatten, gated by `ctx.profile`.
 */
export function healBeforeSend(messages: Message[], ctx: RepairContext): HealResult {
  const res = fixToolCallPairing(messages, ctx.providerName);
  // los holds `messages` as a const array reference and mutates in place
  // (see loop.ts compression/eviction). Rebuild in place only when changed.
  if (res.changed) {
    messages.length = 0;
    messages.push(...res.messages);
  }
  return res;
}

/**
 * Post-response repair. Runs on the model's emitted tool calls before dispatch.
 *
 * Step 2: storm breaking (universal). Suppressed calls are dropped from the
 * returned set — the caller MUST use the returned calls for both the assistant
 * message's `tool_calls` and `runToolCalls` so pairing stays intact. Later
 * steps add scavenge and truncation-philosophy here.
 */
export function repairToolCalls(
  calls: ToolCall[],
  ctx: RepairContext,
): RepairToolCallsResult {
  const notes: string[] = [];

  // Storm breaking (step 2). Universal — runs whenever a storm breaker is
  // present in the context.
  let kept = calls;
  let suppressedCount = 0;
  if (ctx.stormBreaker) {
    const afterStorm: ToolCall[] = [];
    for (const call of calls) {
      const verdict = ctx.stormBreaker.inspect(call);
      if (verdict.suppress) {
        suppressedCount++;
        notes.push(`storm: ${verdict.reason}`);
      } else {
        afterStorm.push(call);
      }
    }
    kept = afterStorm;
    if (suppressedCount > 0) {
      incrementRepairCounter(ctx.providerName, 'storm_suppressed');
      log.warn(
        `[${ctx.providerName}] storm breaker suppressed ${suppressedCount}/${calls.length} ` +
          `tool call(s) — ${notes.join('; ')}`,
      );
    }
  }

  // Scavenge / truncation-philosophy land here in steps 4-5.

  return { calls: kept, suppressedCount, notes };
}

export { StormBreaker };
