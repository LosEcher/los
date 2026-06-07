/**
 * @los/agent/loop/token-utils — Token estimation and budget trimming.
 * Pure functions for estimating token counts and trimming messages to fit budgets.
 */

import type { Message, ToolCall } from '../providers/index.js';

/**
 * Rough token estimator — chars/4 heuristic with a penalty for non-ASCII.
 * Accurate enough for context-window budgeting (±15%).
 * A proper tiktoken integration would replace this for exact counts.
 */
export function estimateTokens(text: string): number {
  let tokens = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code <= 0x7f) {
      // ASCII: ~4 chars per token
      tokens += 0.25;
    } else if (code <= 0x7ff) {
      // 2-byte UTF-8: ~2 chars per token
      tokens += 0.5;
    } else if (code <= 0xffff) {
      // 3-byte UTF-8: ~1 char per token
      tokens += 1.0;
    } else {
      // 4-byte UTF-8 (emoji etc.): 1-2 tokens
      tokens += 1.5;
    }
  }
  return Math.ceil(tokens);
}

/**
 * Estimate token count for a single message, including tool calls and role overhead.
 */
export function estimateMessageTokens(msg: Message): number {
  let tokens = estimateTokens(msg.content);
  // Tool calls add overhead
  if (msg.tool_calls) {
    for (const tc of msg.tool_calls) {
      tokens += estimateTokens(tc.function.name) + estimateTokens(tc.function.arguments) + 4;
    }
  }
  // Role overhead (~3 tokens)
  return tokens + 3;
}

/**
 * Trim messages to fit within a token budget.
 * - System message is always preserved (truncated if necessary).
 * - Oldest non-system messages are removed first.
 * - At minimum, system + latest user message are kept.
 */
export function trimMessagesToBudget(messages: Message[], budget: number): Message[] {
  const systemIdx = messages.findIndex(m => m.role === 'system');
  const systemMsg = systemIdx >= 0 ? messages[systemIdx] : null;

  // Build the result: start from the end (most recent), work backwards
  const nonSystem = systemIdx >= 0
    ? [...messages.slice(0, systemIdx), ...messages.slice(systemIdx + 1)]
    : [...messages];

  // Always keep the last message (the current prompt)
  const last = nonSystem[nonSystem.length - 1];
  if (!last) {
    // Only system message exists — truncate it if needed
    if (systemMsg) {
      const sysTokens = estimateMessageTokens(systemMsg);
      if (sysTokens > budget) {
        return [{ ...systemMsg, content: truncateContent(systemMsg.content, budget - 10) }];
      }
      return [systemMsg];
    }
    return [];
  }

  let used = estimateMessageTokens(last);
  if (systemMsg) used += estimateMessageTokens(systemMsg);
  const kept: Message[] = [last];

  // Add older messages while under budget
  for (let i = nonSystem.length - 2; i >= 0; i--) {
    const msgTokens = estimateMessageTokens(nonSystem[i]!);
    if (used + msgTokens <= budget) {
      used += msgTokens;
      kept.unshift(nonSystem[i]!);
    } else {
      break;
    }
  }

  // If even system + last message exceeds budget, truncate the last message
  if (systemMsg) {
    const sysTokens = estimateMessageTokens(systemMsg);
    if (sysTokens + estimateMessageTokens(last) > budget) {
      const available = Math.max(50, budget - sysTokens);
      kept[kept.length - 1] = { ...last, content: truncateContent(last.content, available) };
    }
    kept.unshift(systemMsg);
  }

  return kept;
}

/**
 * Truncate a content string to fit within a token budget.
 * Rough: 4 chars ≈ 1 token, leave some margin.
 */
export function truncateContent(content: string, tokenBudget: number): string {
  const maxChars = Math.max(50, tokenBudget * 3);
  if (content.length <= maxChars) return content;
  return content.slice(0, maxChars) + '\n[...truncated]';
}
