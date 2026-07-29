import type { HealthScore } from './provider-health.js';

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
  /** Optional health scores for candidate providers. When provided, targets
   * with passing evidence are ranked by health score instead of list order. */
  healthScores?: readonly HealthScore[];
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
    const selected = selectTargetFromEvidence(targets, input.evidence ?? [], input.healthScores);
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
  healthScores?: readonly HealthScore[],
): { target: ProviderModelPolicyTarget & { provider: string }; evidence: ProviderModelPolicyEvidence } | undefined {
  // Collect all targets with passing evidence
  const passing: Array<{ target: ProviderModelPolicyTarget & { provider: string }; evidence: ProviderModelPolicyEvidence }> = [];
  for (const target of targets) {
    const passed = evidence.find(item => (
      item.passed
      && normalizeOptionalString(item.provider) === target.provider
      && (!target.model || normalizeOptionalString(item.model) === target.model)
    ));
    if (passed) passing.push({ target, evidence: passed });
  }

  if (passing.length === 0) return undefined;
  if (passing.length === 1) return passing[0];

  // When health scores are available, rank by health (healthiest first)
  if (healthScores && healthScores.length > 0) {
    const scoreMap = new Map(healthScores.map(s => [s.provider, s]));
    passing.sort((a, b) => {
      const scoreA = scoreMap.get(a.target.provider);
      const scoreB = scoreMap.get(b.target.provider);
      // Unknown providers go last
      if (!scoreA && !scoreB) return 0;
      if (!scoreA) return 1;
      if (!scoreB) return -1;
      return scoreB.score - scoreA.score;
    });
  }

  return passing[0];
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
