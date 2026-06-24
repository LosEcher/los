/**
 * @los/agent/loop/architect-phase — Architect front-matter for Architect/Editor dual-model mode.
 *
 * When `architectEditor` mode is enabled, the architect phase runs FIRST: a
 * reasoning-first model produces a natural-language plan with NO tools. The
 * plan is then injected into the editor's context, and the main ReAct loop
 * runs as the editor (editing-first model + edit tools) to execute it.
 *
 * The architect loop is intentionally tool-less: the architect must describe
 * the plan, not enact it. It signals completion with a `---plan-end---` marker.
 * If the marker never arrives within `maxArchitectTurns`, the accumulated text
 * is used as a partial plan (`truncated: true`) and the editor proceeds.
 *
 * Inspired by Aider's architect mode. See ADR 0007 (provider loop) and the
 * `todo-los-architect-editor-separation` seed in todo-seeds-context-engineering.ts.
 */

import type { ModelSettings } from '../model-settings.js';
import type { Provider, ProviderDelta, Message } from '../providers/index.js';
import { ARCHITECT_PROMPT } from './message-builder.js';

/** Marker the architect emits to signal the plan is complete. */
export const PLAN_END_MARKER = '---plan-end---';
export const DEFAULT_MAX_ARCHITECT_TURNS = 2;

export interface ArchitectPhaseOptions {
  provider: Provider;
  prompt: string;
  maxArchitectTurns?: number;
  modelSettings?: ModelSettings;
  signal?: AbortSignal;
  traceId?: string;
  sessionId?: string;
  onDelta?: (delta: ProviderDelta) => void | Promise<void>;
  emitEvent: (event: {
    type: string;
    turn?: number;
    model?: string;
    payload?: Record<string, unknown>;
  }) => Promise<unknown> | void;
}

export interface ArchitectPhaseResult {
  /** The architect's plan text (plan-end marker stripped, trimmed). */
  plan: string;
  /** Number of architect turns actually run. */
  turns: number;
  /** True if the architect hit maxTurns without emitting the plan-end marker. */
  truncated: boolean;
}

/**
 * Run the architect phase: a no-tools, reasoning-first loop that produces a
 * natural-language plan. Stops early when the architect emits the
 * `---plan-end---` marker, or on a natural stop (`finish_reason='stop'`).
 * Otherwise runs up to `maxArchitectTurns` and returns the accumulated text.
 */
export async function runArchitectPhase(opts: ArchitectPhaseOptions): Promise<ArchitectPhaseResult> {
  const maxTurns = opts.maxArchitectTurns ?? DEFAULT_MAX_ARCHITECT_TURNS;
  const messages: Message[] = [
    { role: 'system', content: ARCHITECT_PROMPT },
    { role: 'user', content: opts.prompt },
  ];

  let plan = '';
  let turns = 0;
  let truncated = true;

  for (let i = 0; i < maxTurns; i++) {
    turns = i + 1;
    const res = await opts.provider.chat(messages, undefined, {
      signal: opts.signal,
      traceId: opts.traceId,
      sessionId: opts.sessionId,
      modelSettings: opts.modelSettings,
      onDelta: opts.onDelta,
    });

    const text = res.text ?? '';
    plan += text;
    messages.push({ role: 'assistant', content: text });

    await opts.emitEvent({
      type: 'architect.turn',
      turn: turns,
      model: res.model,
      payload: {
        textLength: text.length,
        finishReason: res.finishReason,
        markerFound: text.includes(PLAN_END_MARKER),
      },
    });

    if (text.includes(PLAN_END_MARKER)) {
      truncated = false;
      break;
    }
    // Natural stop without the marker (e.g. finish_reason='stop'), or the
    // architect attempted a tool call / returned nothing — accept what we have.
    if (res.finishReason === 'stop' || res.toolCalls.length > 0 || text.trim().length === 0) {
      truncated = false;
      break;
    }
    // Otherwise let the architect continue for another turn.
  }

  return {
    plan: plan.replace(PLAN_END_MARKER, '').trim(),
    turns,
    truncated,
  };
}
