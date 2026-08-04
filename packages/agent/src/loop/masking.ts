/**
 * @los/agent/loop/masking — Deterministic masking cascade (G6).
 *
 * Layer 2 of context compression: instead of truncating or dropping tool
 * results, replace their content with compact "mask cards" that preserve
 * semantic anchors (shape, size, signal lines) while discarding volume.
 * The message structure (assistant text + tool cards) stays intact, so the
 * model still sees what happened — just not the full raw output.
 *
 * Layer 1  = raw messages (recent turns, kept intact)
 * Layer 2  = masked tool results (this module)
 * Layer 3  = summary of masked turns (see compression.ts)
 */

import type { Message } from '../providers/index.js';

export type MaskingOptions = {
  /** Maximum length of a mask card in characters (default 240). */
  maxCardChars?: number;
};

const DEFAULT_MAX_CARD_CHARS = 240;

/**
 * Build a deterministic mask card for a tool result.
 * - Empty content → ''
 * - JSON output → `[mask:json] object keys: …` / `array[N] first: …`
 * - Multi-line text → `[mask:N lines, M bytes] head… | signal… | tail…`
 * - Single line → truncation with '…'
 * - Short content → returned unchanged
 */
function maskToolResultContent(content: string, options: MaskingOptions = {}): string {
  const maxCardChars = options.maxCardChars ?? DEFAULT_MAX_CARD_CHARS;
  const trimmed = String(content ?? '').trim();
  if (!trimmed) return '';
  if (trimmed.length <= maxCardChars) return trimmed;

  const jsonShape = describeJsonOutput(trimmed, maxCardChars);
  if (jsonShape) return `[mask:json] ${jsonShape}`;

  const lines = trimmed.split('\n');
  if (lines.length > 1) {
    const card = `[mask:${lines.length} lines, ${trimmed.length} bytes] ${extractMultiLineSignal(lines, maxCardChars)}`;
    return card.length <= maxCardChars ? card : `${card.slice(0, maxCardChars)}…`;
  }
  return `${trimmed.slice(0, Math.max(1, maxCardChars - 1))}…`;
}

/**
 * Describe a JSON tool output by shape: object keys or array length plus a
 * first-element preview. Returns null when the input is not parseable JSON.
 */
function describeJsonOutput(raw: string, maxChars: number): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (Array.isArray(parsed)) {
    const preview = parsed.length > 0 ? ` first: ${JSON.stringify(parsed[0]).slice(0, Math.max(20, maxChars - 30))}` : '';
    return `array[${parsed.length}]${preview}`;
  }
  if (parsed !== null && typeof parsed === 'object') {
    const keys = Object.keys(parsed);
    const head = keys.slice(0, 12).join(', ');
    const extra = keys.length > 12 ? ` (+${keys.length - 12} more)` : '';
    return `object keys: ${head}${extra}`;
  }
  return JSON.stringify(parsed).slice(0, maxChars);
}

/**
 * Extract semantic anchors from a multi-line text result: an error/failure
 * signal line when present, the first meaningful lines as head, and the last
 * line as tail.
 */
function extractMultiLineSignal(lines: string[], maxChars: number): string {
  const signalPattern = /error|fail(?:ed|ure)?|denied|blocked|exception|✗|timed?\s*out|fatal/i;
  const signal = lines.find(line => signalPattern.test(line) && line.trim())
    ?? lines.find(line => line.trim() && /^\s*(?:ok|success|done|✓|\d+)/i.test(line))
    ?? '';
  const head = lines.slice(0, 2).filter(line => line.trim()).join(' | ') || '(empty)';
  const tail = lines[lines.length - 1]?.trim() || '';
  const parts = [`head: ${head}`];
  if (signal && signal.trim() !== lines[0]?.trim()) parts.push(`signal: ${signal.trim().slice(0, 100)}`);
  if (tail && !head.endsWith(tail)) parts.push(`tail: ${tail.slice(0, 100)}`);
  return parts.join(' | ').slice(0, maxChars);
}

/**
 * Replace tool result content with mask cards in a copied message list.
 * Assistant/user/system messages are untouched. This is the Layer 2 cascade
 * step — call it on the old turns before deciding whether a Layer 3 summary
 * is still needed.
 */
export function maskToolResults(messages: Message[], options: MaskingOptions = {}): Message[] {
  return messages.map(message =>
    message.role === 'tool' && message.content
      ? { ...message, content: maskToolResultContent(message.content, options) }
      : message,
  );
}
