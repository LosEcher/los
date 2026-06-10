import type { ToolRegistry } from '../tools/registry.js';
import type { SessionEventUsage } from '../session-events.js';

export function inferToolSource(capability: ReturnType<ToolRegistry['getCapability']>): string {
  if (capability?.tags?.includes('mcp')) return 'mcp';
  if (capability?.tags?.includes('agent')) return 'spawn_agent';
  return 'builtin';
}

export function normalizeUsage(usage: {
  promptTokens: number;
  completionTokens: number;
  cacheHitTokens?: number;
  cacheMissTokens?: number;
  totalTokens?: number;
}): SessionEventUsage {
  return {
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    cacheHitTokens: usage.cacheHitTokens ?? 0,
    cacheMissTokens: usage.cacheMissTokens ?? 0,
    totalTokens: usage.totalTokens ?? usage.promptTokens + usage.completionTokens,
  };
}

export function inferCacheHit(usage: { cacheHitTokens?: number; cacheMissTokens?: number }): boolean | undefined {
  const hit = usage.cacheHitTokens ?? 0;
  const miss = usage.cacheMissTokens ?? 0;
  if (hit === 0 && miss === 0) return undefined;
  return hit > 0;
}

export function summarizeToolCalls(toolCalls: Array<{ id: string; function: { name: string; arguments: string } }>): Array<Record<string, unknown>> {
  return toolCalls.map(tc => ({
    id: tc.id,
    name: tc.function.name,
    argsPreview: previewText(tc.function.arguments, 1000),
    argsLength: tc.function.arguments.length,
  }));
}

export function previewText(text: string, max = 8000): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}... [truncated ${text.length - max} chars]`;
}

export function summarizeCapability(capability: ReturnType<ToolRegistry['getCapability']> | undefined): Record<string, unknown> | null {
  if (!capability) return null;
  return {
    name: capability.name,
    riskLevel: capability.riskLevel,
    permissions: capability.permissions,
    timeoutMs: capability.timeoutMs,
    retryable: capability.retryable,
    idempotent: capability.idempotent,
    costLevel: capability.costLevel,
    sideEffect: capability.sideEffect,
    sandboxRequired: capability.sandboxRequired,
    needsApproval: capability.needsApproval,
    tags: capability.tags,
  };
}

export function assertNotAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw abortErrorFromSignal(signal);
}

export function withAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortErrorFromSignal(signal));

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortErrorFromSignal(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      value => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      err => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}

export function abortErrorFromSignal(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const message = typeof signal.reason === 'string' ? signal.reason : 'Operation aborted';
  const err = new Error(message);
  err.name = 'AbortError';
  return err;
}

export interface SessionErrorEntry {
  turn: number;
  type: string;
  toolName?: string;
  message: string;
}

export interface SessionErrorSummary {
  totalErrors: number;
  byType: Record<string, number>;
  byTool: Record<string, number>;
  firstError: { turn: number; type: string; message: string };
  lastError: { turn: number; type: string; message: string };
}

export function summarizeSessionErrors(errors: SessionErrorEntry[]): SessionErrorSummary {
  const byType: Record<string, number> = {};
  const byTool: Record<string, number> = {};
  for (const e of errors) {
    byType[e.type] = (byType[e.type] ?? 0) + 1;
    if (e.toolName) byTool[e.toolName] = (byTool[e.toolName] ?? 0) + 1;
  }
  const first = errors[0];
  const last = errors[errors.length - 1];
  return {
    totalErrors: errors.length,
    byType,
    byTool,
    firstError: { turn: first.turn, type: first.type, message: first.message },
    lastError: { turn: last.turn, type: last.type, message: last.message },
  };
}
