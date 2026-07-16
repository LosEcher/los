/**
 * @los/agent/pre-action-gate — Pre-execution guard checking known failure patterns.
 *
 * Before a tool call executes, checks whether the current operation matches
 * a known failure pattern from the same or previous sessions. Reference:
 *   - arXiv:2606.12329 projectmem — Memory-as-Governance
 *   - Claude Code PreToolUse hooks
 *
 * The gate is advisory by default — it warns but does not block.
 * Operator attestation (ADR 0020) is never bypassed.
 */

import type { ToolCall } from './providers/index.js';

export interface PreActionCheck {
  /** Whether the tool call is safe to proceed */
  safe: boolean;
  /** Warning messages for potentially risky operations */
  warnings: string[];
  /** Whether the operation matches a known failure pattern */
  knownFailure: boolean;
  /** Matching failure pattern descriptions */
  failurePatterns: string[];
  /** Whether the target file is known to be fragile */
  fragileFile: boolean;
  /** Flagged file paths */
  flaggedFiles: string[];
}

export interface PreActionGateConfig {
  /** Known fragile files (from session history or operator config) */
  fragileFiles?: Set<string>;
  /** Known failure fingerprints: "toolName::argKey::argValuePattern" */
  failureFingerprints?: Set<string>;
  /** Max number of attempts before auto-escalating */
  maxAttemptsBeforeWarn?: number;
}

export interface AgentPreActionGateConfig {
  /** Disable the advisory gate entirely. Defaults to enabled. */
  enabled?: boolean;
  /** Load persisted evidence for the current session/project. Defaults to true. */
  loadPersistedEvidence?: boolean;
  /** Serializable evidence supplied by an executor or focused harness. */
  evidence?: {
    fragileFiles?: readonly string[];
    failureFingerprints?: readonly string[];
  };
  maxAttemptsBeforeWarn?: number;
}

const DEFAULTS = {
  maxAttemptsBeforeWarn: 2,
} as const;

/**
 * Build a fingerprint string for a tool call to match against known failures.
 * Format: "toolName::argFileOrKey::argValueHash"
 */
export function filePathFromToolArgs(args: Record<string, unknown>): string | undefined {
  return typeof args.file_path === 'string' ? args.file_path
    : typeof args.path === 'string' ? args.path
    : typeof args.file === 'string' ? args.file
    : typeof args.target === 'string' ? args.target
    : undefined;
}

export function failureFingerprintForToolCall(toolName: string, args: Record<string, unknown>): string {
  const file = filePathFromToolArgs(args);

  if (file) {
    return `${toolName}::${file}`;
  }

  // For non-file tools, use tool name + first meaningful arg value
  const firstArgVal = Object.entries(args).find(([, v]) =>
    typeof v === 'string' && v.length > 0 && v.length < 200
  );
  if (firstArgVal) {
    return `${toolName}::${firstArgVal[0]}::${firstArgVal[1] as string}`;
  }

  return toolName;
}

export function preActionGateConfigFromAgentOptions(
  options: AgentPreActionGateConfig | undefined,
): PreActionGateConfig | undefined {
  if (options?.enabled === false) return undefined;
  return {
    fragileFiles: new Set(options?.evidence?.fragileFiles ?? []),
    failureFingerprints: new Set(options?.evidence?.failureFingerprints ?? []),
    maxAttemptsBeforeWarn: options?.maxAttemptsBeforeWarn ?? DEFAULTS.maxAttemptsBeforeWarn,
  };
}

/**
 * Check whether a tool call should be warned about before execution.
 * This is a pre-action gate that runs AFTER phase policy but BEFORE tool execution.
 *
 * Usage in tool-runner.ts:
 *   const preCheck = preActionGate(tc.function.name, args, config);
 *   if (preCheck.warnings.length > 0) {
 *     emitEvent({ type: 'tool.warned', ... });
 *   }
 */
export function preActionGate(
  toolName: string,
  args: Record<string, unknown>,
  config: PreActionGateConfig = {},
): PreActionCheck {
  const warnings: string[] = [];
  const failurePatterns: string[] = [];
  const flaggedFiles: string[] = [];
  let knownFailure = false;
  let fragileFile = false;

  const fingerprint = failureFingerprintForToolCall(toolName, args);
  const maxAttempts = config.maxAttemptsBeforeWarn ?? DEFAULTS.maxAttemptsBeforeWarn;

  // Check known failure fingerprints
  if (config.failureFingerprints?.has(fingerprint)) {
    knownFailure = true;
    failurePatterns.push(`Previous failure: ${fingerprint}`);
    warnings.push(`🛑 This operation previously failed: ${fingerprint}. Review before retrying.`);
  }

  // Check for fragile files
  const filePaths = [args.file_path, args.path, args.file, args.target]
    .filter((v): v is string => typeof v === 'string');
  for (const fp of filePaths) {
    if (config.fragileFiles?.has(fp)) {
      fragileFile = true;
      flaggedFiles.push(fp);
      warnings.push(`⚠ Fragile file '${fp}' is being modified. Known to have caused regressions.`);
    }
  }

  // Check for high-risk write operations on files not yet reviewed
  if (!knownFailure && !fragileFile && (toolName === 'write' || toolName === 'write_edit' || toolName === 'replace')) {
    const path = filePaths[0];
    if (path && config.fragileFiles?.size) {
      // Check if the directory containing this file has other fragile files
      const dir = path.split('/').slice(0, -1).join('/');
      const hasFragileSibling = Array.from(config.fragileFiles).some(f => f.startsWith(dir));
      if (hasFragileSibling) {
        warnings.push(`ℹ Writing to '${path}' in a directory with previously fragile files. Proceed with care.`);
      }
    }
  }

  return {
    safe: !knownFailure,
    warnings,
    knownFailure,
    failurePatterns,
    fragileFile,
    flaggedFiles,
  };
}

/**
 * Extract a failure fingerprint from a tool result error for future checks.
 */
export function failureFingerprintFromError(
  toolName: string,
  args: Record<string, unknown>,
  error: string,
): string {
  return failureFingerprintForToolCall(toolName, args);
}

/**
 * Extract fragility signal from a session: files that were modified and later
 * caused regressions (reverted or had follow-up fixes within N turns).
 */
export function extractFragilitySignal(
  toolEvents: Array<{ toolName: string; args: Record<string, unknown>; ok: boolean; denied: boolean; error?: string }>,
): { fragileFiles: Set<string>; failureFingerprints: Set<string> } {
  const fragileFiles = new Set<string>();
  const failureFingerprints = new Set<string>();

  for (const event of toolEvents) {
    if (!event.ok || event.error) {
      const fp = failureFingerprintForToolCall(event.toolName, event.args);
      failureFingerprints.add(fp);

      const path = [event.args.file_path, event.args.path, event.args.file, event.args.target]
        .find((v): v is string => typeof v === 'string');
      if (path) fragileFiles.add(path);
    }
  }

  return { fragileFiles, failureFingerprints };
}
