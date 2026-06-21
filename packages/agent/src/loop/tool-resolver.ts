/**
 * @los/agent/loop/tool-resolver — Tool mode resolution helpers.
 * Pure functions for resolving allowed tools and tool policies.
 */

import { READ_ONLY_BUILTIN_TOOLS } from '../tools/core/registry.js';
import { getAvailableSandbox } from '../tools/external/shell-sandbox.js';
import { platform } from 'node:os';
import { getLogger } from '@los/infra/logger';
import type { AgentConfig } from './types.js';

const log = getLogger('agent');

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

  // sandboxMode 'readonly' overrides toolMode: no writes, no shell, no sandbox
  if (sandboxMode === 'readonly') {
    return {
      maxRiskLevel: 'L0' as const,
      allowWrites: false,
      sandboxAvailable: false,
      retry: normalizedRetry,
    };
  }

  // sandboxMode 'workspace-write': file writes only (L1), no sandboxed shell
  if (sandboxMode === 'workspace-write' || toolMode === 'project-write') {
    return {
      maxRiskLevel: 'L1' as const,
      allowWrites: true,
      sandboxAvailable: false,
      retry: normalizedRetry,
    };
  }

  // sandboxMode 'sandbox' explicitly requested: check OS sandbox availability.
  // If unavailable, L2 tools are denied (sandboxAvailable stays false) and the
  // gate will block sandboxRequired tools like run_shell.
  if (sandboxMode === 'sandbox') {
    const detected = getAvailableSandbox();
    const sandboxAvailable = detected !== 'native';
    if (!sandboxAvailable) {
      log.warn(`sandboxMode=sandbox but no OS sandbox available (platform=${platform()}); ` +
        `L2 shell tools denied. Install sandbox-exec (macOS) or bwrap (Linux) for sandbox mode.`);
    }
    return {
      maxRiskLevel: 'L2' as const,
      allowWrites: true,
      sandboxAvailable,
      retry: normalizedRetry,
    };
  }

  // Legacy: 'all' toolMode without explicit sandbox config
  if (toolMode === 'read-only') {
    return {
      maxRiskLevel: 'L0' as const,
      allowWrites: false,
      sandboxAvailable: false,
      retry: normalizedRetry,
    };
  }

  // Legacy: 'all' toolMode → L2 without sandbox enforcement (backward-compat)
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
