/**
 * Storm breaker — suppress repeated identical tool calls (ADR 0024, step 2).
 *
 * When the model gets stuck calling the same tool with the same arguments
 * (a common failure mode when a tool errors or the model misreads its
 * results), this drops the repeat instead of executing it again. Window +
 * threshold semantics borrowed from Reasonix `src/repair/storm.ts`.
 *
 * Mutating-call rule: a call with `sideEffect: true` clears prior read-only
 * entries from the window — after state changes, a follow-up read of the same
 * resource is meaningful, not a storm. The mutating call itself is still
 * counted, so three identical edits in a row still counts as a storm.
 *
 * Universal (all profiles). Window/threshold tunable via
 * `LOS_STORM_WINDOW` / `LOS_STORM_THRESHOLD` because suppression is a
 * behavior change.
 */

import type { ToolCall } from '../types.js';

export interface StormBreakerOptions {
  windowSize?: number;
  threshold?: number;
  /** True if the tool mutates state. Maps to `ToolCapability.sideEffect`. */
  isMutating?: (name: string) => boolean;
  /** True if the tool is exempt from storm detection (e.g. always-meaningful). */
  isExempt?: (name: string) => boolean;
}

interface RecentEntry {
  name: string;
  args: string;
  readOnly: boolean;
}

const DEFAULT_WINDOW = 6;
const DEFAULT_THRESHOLD = 3;

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export class StormBreaker {
  private recent: RecentEntry[] = [];
  private readonly windowSize: number;
  private readonly threshold: number;
  private readonly isMutating: (name: string) => boolean;
  private readonly isExempt: (name: string) => boolean;
  /** Total calls suppressed by this breaker. */
  stormsBroken = 0;

  constructor(opts: StormBreakerOptions = {}) {
    this.windowSize = opts.windowSize ?? envInt('LOS_STORM_WINDOW', DEFAULT_WINDOW);
    this.threshold = opts.threshold ?? envInt('LOS_STORM_THRESHOLD', DEFAULT_THRESHOLD);
    this.isMutating = opts.isMutating ?? (() => false);
    this.isExempt = opts.isExempt ?? (() => false);
  }

  /** Clear the window — call at a new user turn. */
  reset(): void {
    this.recent = [];
  }

  /**
   * Inspect a single tool call. Returns `{ suppress: true }` when the call is
   * a repeat storm and should be dropped before dispatch. Otherwise records
   * the call in the window and returns `{ suppress: false }`.
   */
  inspect(call: ToolCall): { suppress: boolean; reason?: string } {
    const name = call.function.name;
    if (this.isExempt(name)) return { suppress: false };

    const mutating = this.isMutating(name);
    if (mutating) {
      // State changed — discard prior read-only entries; re-reads are meaningful now.
      this.recent = this.recent.filter(e => !e.readOnly);
    }

    const sig = `${name}::${call.function.arguments}`;
    const count = this.recent.filter(e => `${e.name}::${e.args}` === sig).length;
    // threshold=3 → suppress on the 3rd occurrence (count reaches 2).
    if (count >= this.threshold - 1) {
      this.stormsBroken++;
      return {
        suppress: true,
        reason: `repeated ${name} ${count + 1}× within window ${this.windowSize}`,
      };
    }

    this.recent.push({ name, args: call.function.arguments, readOnly: !mutating });
    if (this.recent.length > this.windowSize) this.recent.shift();
    return { suppress: false };
  }
}
