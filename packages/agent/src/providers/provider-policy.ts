export interface ProviderModelPolicyTarget {
  provider?: string;
  model?: string;
}

export interface ProviderModelPolicyEvidence extends ProviderModelPolicyTarget {
  id: string;
  passed: boolean;
}

export interface ResolveProviderModelPolicyInput<Source extends string> {
  targets?: readonly ProviderModelPolicyTarget[];
  evidence?: readonly ProviderModelPolicyEvidence[];
  requireProviderCompat?: boolean;
  explicit?: ProviderModelPolicyTarget;
  fallback?: ProviderModelPolicyTarget;
  emptyTargetLabel?: string;
  contextLabel?: string;
  sources: {
    evidence: Source;
    target: Source;
    explicit: Source;
    fallback: Source;
  };
}

export interface ProviderModelPolicySelection<Source extends string> extends ProviderModelPolicyTarget {
  source: Source;
  evidenceId?: string;
  targetLabel?: string;
  requireProviderCompat: boolean;
  rejectedTargetLabels?: string[];
}

export function resolveProviderModelPolicy<Source extends string>(
  input: ResolveProviderModelPolicyInput<Source>,
): ProviderModelPolicySelection<Source> {
  const targets = (input.targets ?? [])
    .map(normalizeTarget)
    .filter((target): target is ProviderModelPolicyTarget & { provider: string } => Boolean(target.provider));
  const requireProviderCompat = input.requireProviderCompat === true;
  const formatLabel = (target: ProviderModelPolicyTarget) => formatTargetLabel(target, input.emptyTargetLabel);

  if (targets.length > 0) {
    const selected = selectTargetFromEvidence(targets, input.evidence ?? []);
    if (selected) {
      return {
        provider: selected.target.provider,
        model: selected.target.model ?? normalizeOptionalString(selected.evidence.model),
        source: input.sources.evidence,
        evidenceId: selected.evidence.id,
        targetLabel: formatLabel(selected.target),
        requireProviderCompat,
        rejectedTargetLabels: targets
          .filter(target => formatLabel(target) !== formatLabel(selected.target))
          .map(formatLabel),
      };
    }
    if (requireProviderCompat) {
      const context = normalizeOptionalString(input.contextLabel) ?? 'provider selection';
      throw new Error(`${context} requires passing provider compatibility evidence for targets: ${targets.map(formatLabel).join(', ')}`);
    }
    const fallbackTarget = targets[0];
    return {
      provider: fallbackTarget?.provider,
      model: fallbackTarget?.model,
      source: input.sources.target,
      targetLabel: fallbackTarget ? formatLabel(fallbackTarget) : undefined,
      requireProviderCompat,
      rejectedTargetLabels: targets.slice(1).map(formatLabel),
    };
  }

  const explicit = normalizeTarget(input.explicit);
  if (explicit.provider || explicit.model) {
    return {
      ...explicit,
      source: input.sources.explicit,
      targetLabel: formatLabel(explicit),
      requireProviderCompat,
    };
  }

  const fallback = normalizeTarget(input.fallback);
  return {
    ...fallback,
    source: input.sources.fallback,
    targetLabel: formatLabel(fallback),
    requireProviderCompat,
  };
}

function selectTargetFromEvidence(
  targets: readonly (ProviderModelPolicyTarget & { provider: string })[],
  evidence: readonly ProviderModelPolicyEvidence[],
): { target: ProviderModelPolicyTarget & { provider: string }; evidence: ProviderModelPolicyEvidence } | undefined {
  for (const target of targets) {
    const passed = evidence.find(item => (
      item.passed
      && normalizeOptionalString(item.provider) === target.provider
      && (!target.model || normalizeOptionalString(item.model) === target.model)
    ));
    if (passed) return { target, evidence: passed };
  }
  return undefined;
}

function normalizeTarget(target: ProviderModelPolicyTarget | undefined): ProviderModelPolicyTarget {
  return {
    provider: normalizeOptionalString(target?.provider),
    model: normalizeOptionalString(target?.model),
  };
}

function formatTargetLabel(target: ProviderModelPolicyTarget, emptyTargetLabel = 'configured-default'): string {
  if (!target.provider) return target.model ? `?:${target.model}` : emptyTargetLabel;
  return target.model ? `${target.provider}:${target.model}` : target.provider;
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}
