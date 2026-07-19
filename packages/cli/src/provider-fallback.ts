export type CliProviderFallbackPolicy = {
  mode: 'explicit_ordered';
  targets: Array<{ provider: string; model?: string }>;
  onFailure?: Array<'transport' | 'rate_limit' | 'provider_unavailable'>;
  requireCompatibilityEvidence: boolean;
  maxSwitches?: number;
};

export function parseProviderFallbackFlags(
  flags: Record<string, string | boolean>,
): CliProviderFallbackPolicy | undefined {
  const rawTargets = stringFlag(flags, 'fallback-target') ?? stringFlag(flags, 'fallback');
  if (!rawTargets) return undefined;
  const targets = rawTargets.split(',').map(parseTarget).filter((target): target is NonNullable<typeof target> => Boolean(target));
  if (targets.length < 2) {
    throw new Error('--fallback-target requires at least two comma-separated provider[:model] targets');
  }
  const rawFailures = stringFlag(flags, 'fallback-on');
  const onFailure = rawFailures ? rawFailures.split(',').map(item => item.trim()).filter(Boolean) : undefined;
  const allowed = new Set(['transport', 'rate_limit', 'provider_unavailable']);
  if (onFailure?.some(item => !allowed.has(item))) {
    throw new Error('--fallback-on supports only transport,rate_limit,provider_unavailable');
  }
  const rawMaxSwitches = stringFlag(flags, 'fallback-max-switches');
  const maxSwitches = rawMaxSwitches ? Number(rawMaxSwitches) : undefined;
  if (maxSwitches !== undefined && (!Number.isInteger(maxSwitches) || maxSwitches < 1 || maxSwitches > 4)) {
    throw new Error('--fallback-max-switches must be an integer from 1 to 4');
  }
  return {
    mode: 'explicit_ordered',
    targets,
    onFailure: onFailure as CliProviderFallbackPolicy['onFailure'],
    requireCompatibilityEvidence: !booleanFlag(flags, 'fallback-without-compat-evidence'),
    maxSwitches,
  };
}

function parseTarget(value: string): { provider: string; model?: string } | undefined {
  const normalized = value.trim();
  if (!normalized) return undefined;
  const separator = normalized.indexOf(':');
  if (separator < 0) return { provider: normalized };
  const provider = normalized.slice(0, separator).trim();
  const model = normalized.slice(separator + 1).trim();
  if (!provider || !model) throw new Error(`Invalid fallback target '${normalized}'`);
  return { provider, model };
}

function stringFlag(flags: Record<string, string | boolean>, key: string): string | undefined {
  const value = flags[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function booleanFlag(flags: Record<string, string | boolean>, key: string): boolean {
  const value = flags[key];
  return value === true || value === 'true' || value === '1';
}
