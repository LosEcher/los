/**
 * @los/agent/loop/tool-resolver — Tool mode resolution helpers.
 * Pure functions for resolving allowed tools and tool policies.
 */

import { READ_ONLY_BUILTIN_TOOLS } from '../tools/registry.js';
import type { AgentConfig } from '../loop.js';

/**
 * Resolve the set of allowed tools based on explicit list and tool mode.
 * In read-only mode, tools are filtered to READ_ONLY_BUILTIN_TOOLS.
 */
export function resolveAllowedTools(
  explicitAllowedTools: readonly string[] | undefined,
  toolMode: 'all' | 'project-write' | 'read-only',
): readonly string[] | undefined {
  const selected = explicitAllowedTools ? [...new Set(explicitAllowedTools)] : undefined;
  if (toolMode !== 'read-only') {
    return selected;
  }

  const readOnly = new Set<string>(READ_ONLY_BUILTIN_TOOLS);
  if (!selected) {
    return [...readOnly];
  }

  return selected.filter(tool => readOnly.has(tool));
}

/**
 * Resolve the tool execution policy based on tool mode and retry config.
 */
export function resolveToolPolicy(
  toolMode: 'all' | 'project-write' | 'read-only',
  retry: AgentConfig['toolRetry'] | undefined,
) {
  const normalizedRetry = normalizeToolRetry(retry);
  if (toolMode === 'read-only') {
    return {
      maxRiskLevel: 'L0' as const,
      allowWrites: false,
      sandboxAvailable: false,
      retry: normalizedRetry,
    };
  }
  if (toolMode === 'project-write') {
    return {
      maxRiskLevel: 'L1' as const,
      allowWrites: true,
      sandboxAvailable: false,
      retry: normalizedRetry,
    };
  }
  return {
    maxRiskLevel: 'L2' as const,
    allowWrites: true,
    sandboxAvailable: true,
    retry: normalizedRetry,
  };
}

/**
 * Normalize tool retry configuration into a standard shape.
 */
export function normalizeToolRetry(retry: AgentConfig['toolRetry'] | undefined) {
  if (!retry) return undefined;
  return {
    maxAttempts: retry.maxAttempts,
    baseDelayMs: retry.baseDelayMs,
    maxDelayMs: retry.maxDelayMs,
  };
}
