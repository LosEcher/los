/**
 * @los/agent/loop/compression — Context compression helpers.
 * Pure functions for compressing conversation history to fit within token budgets.
 */

import type { Message, ToolCall } from '../providers/index.js';
import { estimateTokens, estimateMessageTokens, trimMessagesToBudget, truncateContent } from './token-utils.js';
import type { ContextCompressionConfig } from './types.js';

/**
 * Three-tier context compression:
 *   warning    (80%): compress old turns into brief summaries
 *   aggressive (88%): compress old turns into terse summaries
 *   emergency  (95%): hard truncation — drop oldest messages
 *
 * Preserves the system message and the most recent turns intact.
 * Compressed turns become a synthetic "user" message summarizing earlier work.
 */
export function compressOrTrimMessages(
  messages: Message[],
  budget: number,
  compression?: ContextCompressionConfig,
): Message[] {
  if (budget <= 0) return messages;

  const enabled = compression?.enabled !== false;
  const warningRatio = compression?.warningRatio ?? 0.80;
  const aggressiveRatio = compression?.aggressiveRatio ?? 0.88;
  const emergencyRatio = compression?.emergencyRatio ?? 0.95;

  const totalTokens = messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
  const ratio = totalTokens / budget;
  if (ratio <= warningRatio) return messages; // Safely under the warning threshold.

  if (!enabled) {
    return totalTokens > budget ? trimMessagesToBudget(messages, budget) : messages;
  }

  const systemIdx = messages.findIndex(m => m.role === 'system');

  // Emergency: once already over budget, hard-trim to preserve the latest turn.
  if (ratio > emergencyRatio && totalTokens > budget) {
    return trimMessagesToBudget(messages, budget);
  }

  // Warning / Aggressive: compress instead of drop
  const summaryBudget = Math.floor(budget * (ratio > aggressiveRatio ? 0.05 : 0.10));

  // Find the split point: which messages to compress?
  // Keep the most recent user message + all after it intact
  // Compress everything before that (except system)
  const nonSystem = systemIdx >= 0
    ? [...messages.slice(0, systemIdx), ...messages.slice(systemIdx + 1)]
    : [...messages];

  // Find the last user message — keep it and everything after
  let keepFrom = nonSystem.length - 1;
  for (let i = nonSystem.length - 1; i >= 0; i--) {
    if (nonSystem[i]!.role === 'user') { keepFrom = i; break; }
  }

  const toKeep = nonSystem.slice(keepFrom);
  const toCompress = nonSystem.slice(0, keepFrom);

  if (toCompress.length === 0) {
    return trimMessagesToBudget(messages, budget);
  }

  // Generate summary from compressed messages
  const summary = generateCompressionSummary(toCompress, summaryBudget, ratio > aggressiveRatio);

  // Build result: system + summary + recent messages
  const result: Message[] = [];
  if (systemIdx >= 0) result.push(messages[systemIdx]!);
  result.push({ role: 'user', content: summary });
  result.push(...toKeep);

  return result;
}

/**
 * Generate a compressed summary of old messages.
 * Extracts: turns with tool calls, key decisions, errors.
 */
export function generateCompressionSummary(
  messages: Message[],
  tokenBudget: number,
  aggressive: boolean,
): string {
  const lines: string[] = ['[Compressed earlier context]'];
  lines.push('');

  let turnIdx = 0;
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    if (msg.role === 'assistant') {
      turnIdx++;
      const text = summarizeText(msg.content, aggressive ? 60 : 120);
      const tools = summarizeToolCallsForCompression(msg.tool_calls);

      if (tools.length > 0) {
        lines.push(`Turn ${turnIdx}: ${text} [Tools: ${tools.join(', ')}]`);
      } else {
        lines.push(`Turn ${turnIdx}: ${text}`);
      }
    } else if (msg.role === 'tool') {
      const result = summarizeText(msg.content, aggressive ? 30 : 60);
      if (result) {
        const last = lines[lines.length - 1] ?? '';
        if (last.startsWith(`Turn ${turnIdx}:`)) {
          lines[lines.length - 1] = last + ` → ${result}`;
        }
      }
    }
  }

  if (turnIdx === 0) {
    lines.push('(no assistant turns to summarize)');
  }

  const full = lines.join('\n');
  if (estimateTokens(full) <= tokenBudget) return full;
  return full.slice(0, tokenBudget * 3) + '\n[...summary truncated]';
}

/**
 * Summarize a single text chunk to a maximum character length.
 */
export function summarizeText(text: string, maxLen: number): string {
  const cleaned = text
    .replace(/\n+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned.length <= maxLen) return cleaned;
  return cleaned.slice(0, maxLen) + '...';
}

/**
 * Summarize tool calls as compact name list for compression summaries.
 */
export function summarizeToolCallsForCompression(toolCalls?: ToolCall[]): string[] {
  if (!toolCalls || toolCalls.length === 0) return [];
  return toolCalls.map(tc => tc.function.name);
}
