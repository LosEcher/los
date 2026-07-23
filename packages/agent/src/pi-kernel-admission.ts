import type { AgentConfig } from './loop.js';

export type PiKernelAdmissionCode =
  | 'provider_fallback'
  | 'architect_editor'
  | 'context_compression'
  | 'sampling_settings'
  | 'reasoning_disablement'
  | 'non_read_only_shadow'
  | 'remote_executor_shadow';

export interface PiKernelAdmissionIssue {
  code: PiKernelAdmissionCode;
  message: string;
  decision: 'implement_before_default' | 'explicitly_disabled' | 'los_owned';
}

export const _PI_KERNEL_ADMISSION_DECISIONS = Object.freeze({
  providerFallback: 'implement_before_default',
  architectEditor: 'los_owned',
  contextCompression: 'implement_before_default',
  samplingSettings: 'explicitly_disabled',
  reasoningDisablement: 'explicitly_disabled',
  childAgents: 'los_owned',
} as const);

export function _evaluatePiKernelInputAdmission(config: AgentConfig): PiKernelAdmissionIssue[] {
  const issues: PiKernelAdmissionIssue[] = [];
  if (config.providerFallback) {
    issues.push(issue('provider_fallback', 'Pi kernel provider fallback mapping is not implemented', 'implement_before_default'));
  }
  if (config.architectEditor?.enabled) {
    issues.push(issue('architect_editor', 'Pi kernel architect-editor orchestration remains LOS-owned', 'los_owned'));
  }
  if (config.contextCompression?.enabled) {
    issues.push(issue('context_compression', 'Pi kernel context compression mapping is not implemented', 'implement_before_default'));
  }
  const settings = config.modelSettings;
  if (settings?.topP !== undefined || settings?.presencePenalty !== undefined || settings?.frequencyPenalty !== undefined) {
    issues.push(issue('sampling_settings', 'Pi kernel does not yet map LOS topP or penalty model settings', 'explicitly_disabled'));
  }
  if (settings?.thinking === 'disabled' || settings?.reasoningEffort === 'none') {
    issues.push(issue('reasoning_disablement', 'Pi kernel does not yet map explicit reasoning disablement', 'explicitly_disabled'));
  }
  return issues;
}

export function evaluatePiKernelShadowAdmission(input: {
  config: AgentConfig;
  effectiveToolMode: AgentConfig['toolMode'];
  remoteExecutor: boolean;
}): PiKernelAdmissionIssue[] {
  const issues = _evaluatePiKernelInputAdmission(input.config);
  if (input.effectiveToolMode !== 'read-only') {
    issues.push(issue('non_read_only_shadow', 'Pi scheduler shadow requires an effective read-only tool mode', 'explicitly_disabled'));
  }
  if (input.remoteExecutor) {
    issues.push(issue('remote_executor_shadow', 'Pi scheduler shadow does not compare remote executor runs', 'explicitly_disabled'));
  }
  return issues;
}

export function assertPiKernelInputAdmission(config: AgentConfig): void {
  const first = _evaluatePiKernelInputAdmission(config)[0];
  if (first) throw new Error(first.message);
}

function issue(
  code: PiKernelAdmissionCode,
  message: string,
  decision: PiKernelAdmissionIssue['decision'],
): PiKernelAdmissionIssue {
  return { code, message, decision };
}
