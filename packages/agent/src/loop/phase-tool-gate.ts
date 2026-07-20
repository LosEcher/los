/**
 * Phase-aware tool policy — restricts tool availability based on the current
 * RunPhase. Enforced dynamically at tool call time.
 *
 * Pattern inspired by Trellis's phase-aware routing:
 *   - discovering: read-only tools only
 *   - planning: read-only tools only
 *   - executing: all tools
 *   - verifying: read-only + bash for lint/test/check
 */

import type { RunPhase } from '../run-contract.js';
import { readRunContractMetadata } from '../run-contract.js';
import { READ_ONLY_BUILTIN_TOOLS } from '../tools/core/registry-policy.js';

/** Determine whether a tool is allowed in a given run phase. */
export function isToolAllowedInPhase(
  toolName: string,
  phase: RunPhase | undefined,
): { allowed: boolean; reason?: string } {
  if (!phase) return { allowed: true };

  switch (phase) {
    case 'discovering':
    case 'discovery_ready':
    case 'planning':
      return checkReadPhase(toolName, phase);
    case 'plan_approved':
    case 'executing':
      return { allowed: true };
    case 'verifying':
      return checkVerifyPhase(toolName);
    case 'blocked':
    case 'succeeded':
    case 'failed':
      return checkTerminalPhase(toolName, phase);
    default:
      return { allowed: true };
  }
}

/**
 * Apply the phase gate to a registry tool decision.
 * If the registry allows the tool but the current phase blocks it,
 * returns a blocked decision with reasonCode 'phase_blocked'.
 */
export function applyPhaseGate(
  registryDecision: { allowed: boolean; reasonCode?: string; reason?: string; capability?: unknown; policy?: unknown },
  toolName: string,
  runContractMetadata?: Record<string, unknown>,
): { allowed: boolean; reasonCode?: string; reason?: string; capability?: unknown; policy?: unknown } {
  if (!registryDecision.allowed) return registryDecision;
  const check = isToolAllowedInPhase(
    toolName,
    readRunContractMetadata(runContractMetadata ?? {})?.phase,
  );
  if (check.allowed) return registryDecision;
  return { allowed: false, reasonCode: 'phase_blocked', reason: check.reason ?? 'phase_blocked' };
}

const READ_ONLY = new Set<string>(READ_ONLY_BUILTIN_TOOLS);
const VERIFY = new Set(['run_shell']);

function checkReadPhase(name: string, phase: string): { allowed: boolean; reason?: string } {
  if (READ_ONLY.has(name)) return { allowed: true };
  return { allowed: false, reason: `Tool '${name}' blocked in ${phase} phase (read-only)` };
}

function checkVerifyPhase(name: string): { allowed: boolean; reason?: string } {
  if (READ_ONLY.has(name) || VERIFY.has(name)) return { allowed: true };
  return { allowed: false, reason: `Tool '${name}' blocked in verifying phase (read + verify only)` };
}

function checkTerminalPhase(name: string, phase: string): { allowed: boolean; reason?: string } {
  if (READ_ONLY.has(name)) return { allowed: true };
  return { allowed: false, reason: `Tool '${name}' blocked in terminal phase '${phase}'` };
}
