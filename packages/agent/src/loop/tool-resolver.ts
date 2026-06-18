/**
 * @los/agent/loop/tool-resolver — Tool mode resolution helpers.
 * Pure functions for resolving allowed tools and tool policies.
 */

import { READ_ONLY_BUILTIN_TOOLS } from '../tools/registry.js';
import { getAvailableSandbox } from '../tools/shell-sandbox.js';
import type { AgentConfig } from './types.js';

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
 * Resolve the tool execution policy based on tool mode, sandbox mode, and retry config.
 *
 * sandboxMode controls the actual isolation level:
 *   'readonly' — force toolMode to 'read-only' regardless of user selection
 *   'workspace-write' — allow up to L1 (file writes), no sandbox shell
 *   'sandbox' — allow L2 shell execution with actual sandbox availability check
 *
 * If sandboxMode is 'sandbox' but no OS sandbox is available, L2 tools are
 * still denied (sandboxAvailable stays false) and a warning is logged.
 */
export function resolveToolPolicy(
  toolMode: 'all' | 'project-write' | 'read-only',
  retry: AgentConfig['toolRetry'] | undefined,
  sandboxMode?: 'readonly' | 'workspace-write' | 'sandbox',
) {
  const normalizedRetry = normalizeToolRetry(retry);

  // sandboxMode 'readonly' overrides toolMode to enforce read-only
  const effectiveMode = sandboxMode === 'readonly' ? 'readonly' : toolMode;

  // sandboxMode 'sandbox' enables sandbox availability, but only if an
  // actual OS-level sandbox (macOS sandbox-exec or Linux bwrap) is present
  let sandboxAvailable = false;
  if (effectiveMode === 'all' && sandboxMode === 'sandbox') {
    const detected = getAvailableSandbox();
    sandboxAvailable = detected !== 'native';
  } else if (effectiveMode === 'all') {
    // Legacy: 'all' mode without explicit sandbox config still allows sandbox
    sandboxAvailable = true;
  }

  if (effectiveMode === 'read-only') {
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
