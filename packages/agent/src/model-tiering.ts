/**
 * @los/agent/model-tiering — conditional model routing based on task complexity.
 *
 * Inspired by Superpowers 6 conditional implementer tiering: simple tasks run
 * on cheaper/faster models (Haiku, Flash), complex tasks use the full model
 * (Sonnet, Opus). This saves ~$0.5–1/run without quality loss because simple
 * tasks rarely benefit from a reasoning-heavy model.
 *
 * The tier is resolved during setup and becomes the effective provider for
 * the run. If no tiers are configured, the default provider is used as-is.
 */

import type { ModelProfile } from './model-profiles.js';

// ── Complexity Scorer ───────────────────────────────────────

export interface ComplexityInput {
  /** User prompt text. */
  prompt: string;
  /** Number of source files touched. */
  fileCount: number;
  /** Spec layers involved (loaded from .los/spec/). */
  specLayerCount: number;
  /** Number of tools available to the agent. */
  toolCount: number;
}

export interface ComplexityScore {
  /** Raw score (0–100). Higher = more complex. */
  score: number;
  /** Human-readable tier label. */
  label: 'simple' | 'moderate' | 'complex';
  /** Factors contributing to the score. */
  factors: string[];
}

/**
 * Score task complexity on a 0–100 scale.
 *
 * Heuristics:
 *   - Prompt length (> 500 chars → +15, > 2000 → +30)
 *   - File count (> 5 → +15, > 15 → +25)
 *   - Spec layers (> 2 → +10, > 4 → +20)
 *   - Tool count (> 10 → +10, > 20 → +20)
 *
 * Tiers:
 *   0–25:  simple   → cheap model (Haiku, Flash)
 *   26–55: moderate → mid model (Sonnet)
 *   56+:   complex  → full model (Opus, Pro)
 */
export function scoreComplexity(input: ComplexityInput): ComplexityScore {
  const factors: string[] = [];
  let score = 0;

  // Prompt complexity
  if (input.prompt.length > 2000) {
    score += 30;
    factors.push(`prompt length ${input.prompt.length} (>2000) → +30`);
  } else if (input.prompt.length > 500) {
    score += 15;
    factors.push(`prompt length ${input.prompt.length} (>500) → +15`);
  }

  // File surface complexity
  if (input.fileCount > 15) {
    score += 25;
    factors.push(`file count ${input.fileCount} (>15) → +25`);
  } else if (input.fileCount > 5) {
    score += 15;
    factors.push(`file count ${input.fileCount} (>5) → +15`);
  }

  // Cross-package spec breadth
  if (input.specLayerCount > 4) {
    score += 20;
    factors.push(`spec layers ${input.specLayerCount} (>4) → +20`);
  } else if (input.specLayerCount > 2) {
    score += 10;
    factors.push(`spec layers ${input.specLayerCount} (>2) → +10`);
  }

  // Tool breadth
  if (input.toolCount > 20) {
    score += 20;
    factors.push(`tool count ${input.toolCount} (>20) → +20`);
  } else if (input.toolCount > 10) {
    score += 10;
    factors.push(`tool count ${input.toolCount} (>10) → +10`);
  }

  // Clamp at theorhetical max: 30+25+20+20 = 95
  score = Math.min(95, Math.max(0, score));

  let label: ComplexityScore['label'];
  if (score <= 25) label = 'simple';
  else if (score <= 55) label = 'moderate';
  else label = 'complex';

  return { score, label, factors };
}

// ── Tier Configuration ──────────────────────────────────────

export interface ModelTier {
  /** Tier label: 'simple', 'moderate', 'complex', or 'default'. */
  label: ComplexityScore['label'] | 'default';
  /** Provider name to use for this tier. */
  provider: string;
  /** Model to use (overrides the provider's default model). */
  model: string;
}

export interface TieringConfig {
  /** Whether tiering is active. When false, the default provider is used. */
  enabled: boolean;
  /** Tiered model assignments. 'default' is used when no tier matches. */
  tiers: ModelTier[];
  /** Logger for tier resolution (optional). */
  log?: (msg: string) => void;
}

/** Sensible defaults: simple → Flash, moderate → Sonnet, complex → Opus/Pro. */
export const DEFAULT_TIERING_CONFIG: TieringConfig = {
  enabled: false, // opt-in: enabled via config.review.tiering in production
  tiers: [],
};

/**
 * Resolve which provider + model to use based on task complexity.
 * Returns the tier's provider and model, or null if tiering is disabled.
 */
export function resolveModelTier(
  complexity: ComplexityScore,
  config: TieringConfig,
): { provider: string; model: string } | null {
  if (!config.enabled || config.tiers.length === 0) return null;

  // Exact label match first, then 'default' fallback
  const tier = config.tiers.find(t => t.label === complexity.label)
    ?? config.tiers.find(t => t.label === 'default');

  if (!tier) return null;

  config.log?.(
    `[tiering] task complexity=${complexity.label} (${complexity.score}) → ${tier.provider}:${tier.model}`,
  );

  return { provider: tier.provider, model: tier.model };
}
