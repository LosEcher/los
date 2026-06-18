/**
 * @los/input-preprocessor/token-utils — Token estimation utilities.
 *
 * Reuses the chars/4 heuristic from @los/agent/loop/token-utils.ts
 * with non-ASCII penalty. Accurate to ±15% for context budgeting.
 */

/**
 * Rough token estimator — chars/4 heuristic with a penalty for non-ASCII.
 * Accurate enough for context-window budgeting (±15%).
 */
export function estimateTokens(text: string): number {
  let tokens = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code <= 0x7f) {
      tokens += 0.25;
    } else if (code <= 0x7ff) {
      tokens += 0.5;
    } else if (code <= 0xffff) {
      tokens += 1.0;
    } else {
      tokens += 1.5;
    }
  }
  return Math.ceil(tokens);
}
