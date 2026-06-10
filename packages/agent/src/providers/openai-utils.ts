import { getLogger } from '@los/infra/logger';
import type { ToolCall } from './types.js';

const log = getLogger('agent');

// ── URL builder ──────────────────────────────────────────

export function buildOpenAICompatUrl(baseUrl: string, path: string): string {
  const cleanBase = baseUrl.replace(/\/+$/, '');
  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  if (cleanBase.endsWith('/v1')) {
    return `${cleanBase}${cleanPath}`;
  }
  return `${cleanBase}/v1${cleanPath}`;
}

// ── SSE buffer drainer ───────────────────────────────────

export function drainSseBuffer(buffer: string): { payloads: string[]; rest: string } {
  const parts = buffer.split(/\n\n|\r\n\r\n/);
  const rest = parts.pop() ?? '';
  const payloads = parts.flatMap((part) => {
    const lines = part.split(/\r?\n/).filter(line => line.startsWith('data:'));
    const payload = lines.map(line => line.slice(5).trimStart()).join('\n').trim();
    return payload ? [payload] : [];
  });
  return { payloads, rest };
}

// ── JSON repair (DeepSeek) ───────────────────────────────

export interface RepairResult {
  /** The repaired arguments string (JSON), or the original if no repair was needed. */
  arguments: string;
  /** Whether any repair transformations were applied. */
  repaired: boolean;
  /** The original arguments before repair, if repair was applied. */
  originalArguments?: string;
  /** The repair steps that were applied (e.g. 'fences', 'trailing-commas', 'balance-braces', 'unquoted-keys'). */
  repairSteps?: string[];
}

/**
 * Non-destructive JSON repair for DeepSeek's known malformed tool-call arguments.
 * Handles: markdown fences, trailing commas, unbalanced braces, unescaped control chars.
 *
 * From lsclaw's `repairDeepSeekToolCall()` in provider-router-adapters.mjs:946-1033
 */
export function repairJson(content: string): { result: string | null; steps: string[] } {
  let text = content.trim();
  const steps: string[] = [];

  // Strip markdown fences
  const stripped = text.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/, '');
  if (stripped !== text) { steps.push('fences'); text = stripped; }

  if (!text) return { result: null, steps };

  // Try direct parse
  try { JSON.parse(text); return { result: text, steps: steps.length > 0 ? steps : [] }; } catch {}

  // Fix trailing commas: ,} → }  ,] → ]
  const fixedCommas = text.replace(/,(\s*[}\]])/g, '$1');
  if (fixedCommas !== text) { steps.push('trailing-commas'); text = fixedCommas; }

  // Balance braces
  let depth = 0;
  for (const ch of text) {
    if (ch === '{' || ch === '[') depth++;
    if (ch === '}' || ch === ']') depth--;
  }
  if (depth !== 0) {
    steps.push('balance-braces');
    let balanced = text;
    while (depth > 0) { balanced += '}'; depth--; }
    while (depth < 0) { balanced = '{' + balanced; depth++; }
    text = balanced;
  }

  // Fix unquoted property names like {name: "x"} → {"name": "x"}
  const fixedKeys = text.replace(/(\{|\,)\s*([a-zA-Z_$][\w$]*)\s*:/g, '$1"$2":');
  if (fixedKeys !== text) { steps.push('unquoted-keys'); text = fixedKeys; }

  try { JSON.parse(text); return { result: text, steps }; } catch {}

  return { result: null, steps }; // Give up — caller will surface original error
}

// ── Tool call argument repair ────────────────────────────

export function repairToolCallArguments(toolCall: ToolCall, providerName: string): ToolCall {
  try {
    JSON.parse(toolCall.function.arguments);
    return toolCall;
  } catch {
    const { result, steps } = repairJson(toolCall.function.arguments);
    if (result) {
      log.debug(`[${providerName}] Repaired streamed tool call args for ${toolCall.function.name} (steps: ${steps.join(',')})`);
      return {
        ...toolCall,
        function: { ...toolCall.function, arguments: result },
        _repair: { repaired: true, originalArguments: toolCall.function.arguments, repairSteps: steps },
      } as ToolCall & { _repair?: RepairResult };
    }
    log.warn(`[${providerName}] Could not repair streamed tool call args for ${toolCall.function.name}`);
    return toolCall;
  }
}
