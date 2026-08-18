/**
 * OpenAI-compat provider fallback policy builder.
 *
 * Builds a request-level provider failover policy for the requested provider
 * from the `providerFallbacks` config table (`provider` -> ordered fallback
 * chain in los config). Kept in its own file so openai-compat-route.ts stays
 * under the 500-line structure limit.
 */

import type { ProviderFallbackPolicy } from '@los/agent';

/**
 * The requested provider is prepended as the first (primary) target so the
 * los agent fallback router (createProviderFallbackRouter) can switch to the
 * configured fallbacks when the primary fails (quota/rate-limit/transport/5xx).
 *
 * Constraints honored: `normalizeProviderFallbackPolicy` requires 2-5 targets
 * and `requireCompatibilityEvidence: false` (targets here carry no model, so
 * evidence-pinned targets would be rejected). Returns undefined when the
 * provider has no fallback chain or the chain is empty — fail-hard as today.
 */
export function buildProviderFallbackPolicy(
  model: string | undefined,
  providerFallbacks: Record<string, string[]> | undefined,
): ProviderFallbackPolicy | undefined {
  if (!model || !providerFallbacks) return undefined;
  const chain = providerFallbacks[model];
  if (!Array.isArray(chain) || chain.length === 0) return undefined;
  const seen = new Set<string>([model]);
  const targets: Array<{ provider: string }> = [{ provider: model }];
  for (const provider of chain) {
    const name = typeof provider === 'string' ? provider.trim() : '';
    if (!name || seen.has(name)) continue;
    seen.add(name);
    targets.push({ provider: name });
    if (targets.length >= 5) break; // normalizeProviderFallbackPolicy max
  }
  if (targets.length < 2) return undefined;
  return {
    mode: 'explicit_ordered',
    targets,
    onFailure: ['transport', 'rate_limit', 'provider_unavailable'],
    requireCompatibilityEvidence: false,
    maxSwitches: Math.min(targets.length - 1, 4),
  };
}
