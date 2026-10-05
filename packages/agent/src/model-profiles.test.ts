import test from 'node:test';
import assert from 'node:assert/strict';
import { requireProviderDefaults } from '@los/infra/provider-defaults';

import {
  billingPeriodAt,
  calculateCost,
  DEFAULT_CNY_PER_USD,
  estimateCost,
  MODEL_PROFILES,
  resolveModelCapabilityProfile,
  resolveModelProfile,
  summarizeModelProfile,
} from './model-profiles.js';

test('resolveModelProfile keeps deepseek defaults and overrides', () => {
  const profile = resolveModelProfile('deepseek');
  assert.equal(profile.protocol, 'openai');
  assert.equal(profile.baseUrl, 'https://api.deepseek.com/v1');
  assert.equal(profile.model, 'deepseek-v4-flash');
  assert.equal(profile.toolCallRepair, 'json-loose');
  assert.equal(profile.cachePolicy, 'prompt-cache-read');

  const override = resolveModelProfile('deepseek', {
    baseUrl: 'https://example.invalid',
    model: 'deepseek-v4-pro',
  });
  assert.equal(override.baseUrl, 'https://example.invalid');
  assert.equal(override.model, 'deepseek-v4-pro');
});

test('resolveModelProfile knows codex-compatible and anthropic routing shapes', () => {
  const codex = resolveModelProfile('codex');
  assert.equal(codex.protocol, 'openai');
  assert.equal(codex.baseUrl, 'https://api.openai.com/v1');
  assert.equal(codex.model, 'gpt-5.5');

  const anthropic = resolveModelProfile('claude');
  assert.equal(anthropic.protocol, 'anthropic');
  assert.equal(anthropic.apiShape, 'anthropic-messages');
  assert.equal(anthropic.supportsReasoning, true);

  const deepseekAnthropic = resolveModelProfile('deepseek-anthropic');
  assert.equal(deepseekAnthropic.protocol, 'anthropic');
  assert.equal(deepseekAnthropic.baseUrl, 'https://api.deepseek.com/anthropic');

  const minimax = resolveModelProfile('minimax');
  assert.equal(minimax.protocol, 'anthropic');
  assert.equal(minimax.model, 'MiniMax-M3');
});

test('model profile registry includes the expected core providers', () => {
  assert.ok(MODEL_PROFILES.deepseek);
  assert.ok(MODEL_PROFILES.openai);
  assert.ok(MODEL_PROFILES.codex);
  assert.ok(MODEL_PROFILES.packycode);
  assert.ok(MODEL_PROFILES['deepseek-anthropic']);
  assert.ok(MODEL_PROFILES.minimax);
});

test('known model profiles use the canonical provider URL and model defaults', () => {
  for (const provider of Object.keys(MODEL_PROFILES)) {
    const defaults = requireProviderDefaults(provider);
    const profile = resolveModelProfile(provider);
    assert.equal(profile.baseUrl, defaults.baseUrl, `${provider} baseUrl drifted from catalog`);
    assert.equal(profile.model, defaults.defaultModel, `${provider} model drifted from catalog`);
  }
});

test('unknown providers require explicit executable routing defaults', () => {
  assert.throws(
    () => resolveModelProfile('custom-provider'),
    /requires explicit baseUrl and model configuration/,
  );
  assert.throws(
    () => resolveModelProfile('custom-provider', { baseUrl: 'https://custom.invalid/v1' }),
    /requires explicit baseUrl and model configuration/,
  );

  const custom = resolveModelProfile('custom-provider', {
    baseUrl: 'https://custom.invalid/v1',
    model: 'custom-model',
  });
  assert.equal(custom.baseUrl, 'https://custom.invalid/v1');
  assert.equal(custom.model, 'custom-model');
  assert.notEqual(custom.model, 'gpt-4o');
});

test('summarizeModelProfile exposes runtime-relevant model capabilities', () => {
  const summary = summarizeModelProfile(resolveModelProfile('deepseek', {
    model: 'deepseek-v4-pro',
  }));

  assert.equal(summary.provider, 'deepseek');
  assert.equal(summary.model, 'deepseek-v4-pro');
  assert.equal(summary.supportsReasoning, true);
  assert.equal(summary.cachePolicy, 'prompt-cache-read');
  assert.equal(summary.toolCallRepair, 'json-loose');
  assert.equal(summary.capabilities.reasoning.supported, true);
  assert.equal(summary.capabilities.reasoning.parameter, 'reasoning_effort');
  assert.equal(summary.capabilities.cache.promptCacheRead, true);
  assert.equal(summary.capabilities.session.affinity, 'provider');
  assert.equal(summary.capabilities.session.sticky, true);
  assert.equal(summary.capabilities.tools.streaming, true);
  assert.deepEqual(summary.capabilities.routing.transportHints, ['sse']);
  assert.ok(summary.capabilities.modelAliases.includes('deepseek-v4-pro'));
});

test('resolveModelCapabilityProfile normalizes model aliases and scheduling-relevant capability flags', () => {
  const deepseek = resolveModelCapabilityProfile(resolveModelProfile('deepseek'));
  assert.deepEqual(deepseek.modelAliases, ['deepseek-v4-flash', 'deepseek-v4-pro']);
  assert.ok(!deepseek.modelAliases.includes('deepseek-chat'));
  assert.ok(!deepseek.modelAliases.includes('deepseek-reasoner'));
  assert.equal(deepseek.tools.parallelCalls, false);
  assert.equal(deepseek.tools.repair, 'json-loose');
  assert.equal(deepseek.vision.supported, false);
  assert.equal(deepseek.vision.mode, 'none');

  const packycode = resolveModelCapabilityProfile(resolveModelProfile('packycode'));
  assert.equal(packycode.tools.supported, true);
  assert.equal(packycode.tools.parallelCalls, false);
  assert.equal(packycode.tools.streaming, false);
  assert.equal(packycode.cache.promptCacheRead, false);
  assert.equal(packycode.session.sticky, false);

  const claude = resolveModelCapabilityProfile(resolveModelProfile('claude'));
  assert.equal(claude.routing.protocol, 'anthropic');
  assert.equal(claude.reasoning.parameter, 'thinking');
  assert.equal(claude.session.affinity, 'provider');
});

test('packycode defaults to openai-chat-completions apiShape (PackyCode does not support /v1/responses)', () => {
  const profile = resolveModelProfile('packycode');
  assert.equal(profile.protocol, 'openai');
  assert.equal(profile.apiShape, 'openai-chat-completions');
  assert.equal(profile.baseUrl, 'https://www.packyapi.ai/v1');
  assert.equal(profile.supportsTools, true);
  assert.equal(profile.supportsParallelToolCalls, false,
    'PackyCode parallel tool calls disabled to prevent streaming delta split-call bugs (L0)');
});

test('packycode apiShape can be overridden via options', () => {
  const overridden = resolveModelProfile('packycode', { apiShape: 'openai-chat-completions' });
  assert.equal(overridden.apiShape, 'openai-chat-completions');
});

test('openai stays on chat-completions, not affected by packycode changes', () => {
  const profile = resolveModelProfile('openai');
  assert.equal(profile.apiShape, 'openai-chat-completions');
});

test('summarizeModelProfile includes apiShape for runtime routing', () => {
  const packySummary = summarizeModelProfile(resolveModelProfile('packycode'));
  assert.equal(packySummary.apiShape, 'openai-chat-completions');
  const deepseekSummary = summarizeModelProfile(resolveModelProfile('deepseek'));
  assert.equal(deepseekSummary.apiShape, 'openai-chat-completions');
});

test('calculateCost computes per-component and total cost', () => {
  const cost = calculateCost(
    { promptTokens: 1_000_000, completionTokens: 500_000, cacheHitTokens: 200_000 },
    { promptTokenCostPer1M: 1.10, completionTokenCostPer1M: 4.40, cacheHitTokenCostPer1M: 0.14 },
  );
  assert.equal(cost.promptCostUsd, 1.10);
  assert.equal(cost.completionCostUsd, 2.20);
  // 200k cache hit tokens at $0.14/1M = $0.028 (floating point OK)
  assert.ok(Math.abs(cost.cacheHitCostUsd - 0.028) < 0.0001);
  // cache savings: 200k tokens at (1.10 - 0.14) = 0.96/1M = 0.192
  assert.ok(Math.abs(cost.cacheSavingsUsd - 0.192) < 0.001);
  assert.ok(Math.abs(cost.totalCostUsd - (1.10 + 2.20 + 0.028)) < 0.001);
});

test('calculateCost does not double bill cache hits included in prompt tokens', () => {
  const cost = calculateCost(
    { promptTokens: 1_000_000, completionTokens: 500_000, cacheHitTokens: 200_000, cacheMissTokens: 800_000 },
    {
      promptTokenCostPer1M: 0.14,
      completionTokenCostPer1M: 0.28,
      cacheHitTokenCostPer1M: 0.0028,
      promptTokensIncludeCacheHits: true,
    },
  );
  assert.ok(Math.abs(cost.promptCostUsd - 0.112) < 0.0001);
  assert.ok(Math.abs(cost.cacheHitCostUsd - 0.00056) < 0.0001);
  assert.ok(Math.abs(cost.totalCostUsd - 0.25256) < 0.0001);
});

test('calculateCost falls back to prompt tokens when cache breakdown is unavailable', () => {
  const cost = calculateCost(
    { promptTokens: 1_000_000, completionTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0 },
    {
      promptTokenCostPer1M: 0.14,
      completionTokenCostPer1M: 0.28,
      cacheHitTokenCostPer1M: 0.0028,
      promptTokensIncludeCacheHits: true,
    },
  );
  assert.equal(cost.promptCostUsd, 0.14);
  assert.equal(cost.totalCostUsd, 0.14);
});

test('calculateCost handles zero usage', () => {
  const cost = calculateCost(
    { promptTokens: 0, completionTokens: 0 },
    { promptTokenCostPer1M: 1.10, completionTokenCostPer1M: 4.40, cacheHitTokenCostPer1M: 0.14 },
  );
  assert.equal(cost.totalCostUsd, 0);
  assert.equal(cost.cacheSavingsUsd, 0);
});

test('estimateCost returns null when profile has no pricing', () => {
  const groq = resolveModelProfile('groq');
  assert.equal(groq.pricing, undefined);
  const cost = estimateCost({ promptTokens: 1000, completionTokens: 500 }, groq);
  assert.equal(cost, null);
});

test('estimateCost returns cost for priced profiles', () => {
  const deepseek = resolveModelProfile('deepseek');
  assert.ok(deepseek.pricing);
  const cost = estimateCost(
    { promptTokens: 100000, completionTokens: 50000, cacheHitTokens: 10000 },
    deepseek,
  );
  assert.ok(cost);
  assert.ok(cost.totalCostUsd > 0);
  assert.ok(cost.cacheSavingsUsd > 0);
});

test('DeepSeek pricing resolves by effective model', () => {
  const flash = resolveModelProfile('deepseek', { model: 'deepseek-v4-flash' });
  const pro = resolveModelProfile('deepseek', { model: 'deepseek-v4-pro' });
  const unknown = resolveModelProfile('deepseek', { model: 'deepseek-v5-preview' });

  assert.deepEqual(flash.pricing, {
    currency: 'cny',
    promptTokenCostPer1M: 1.5,
    completionTokenCostPer1M: 4.5,
    cacheHitTokenCostPer1M: 0.05,
    promptTokensIncludeCacheHits: true,
    peakMultiplier: 2,
    cnyPerUsd: 6.8,
    asOf: '2026-08-17',
  });
  assert.deepEqual(pro.pricing, {
    currency: 'cny',
    promptTokenCostPer1M: 4.5,
    completionTokenCostPer1M: 13.5,
    cacheHitTokenCostPer1M: 0.15,
    promptTokensIncludeCacheHits: true,
    peakMultiplier: 2,
    cnyPerUsd: 6.8,
    asOf: '2026-08-17',
  });
  assert.equal(unknown.pricing, undefined);
});

test('billingPeriodAt follows Beijing peak hours and weekend flat rate', () => {
  const at = (iso: string) => new Date(iso);
  // Weekday peak windows: 09:00-12:00 and 14:00-18:00 Beijing (UTC+8).
  assert.equal(billingPeriodAt(at('2026-08-17T01:00:00Z')), 'peak');    // Mon 09:00
  assert.equal(billingPeriodAt(at('2026-08-17T03:59:59Z')), 'peak');    // Mon 11:59
  assert.equal(billingPeriodAt(at('2026-08-17T04:00:00Z')), 'off-peak'); // Mon 12:00
  assert.equal(billingPeriodAt(at('2026-08-17T06:00:00Z')), 'peak');    // Mon 14:00
  assert.equal(billingPeriodAt(at('2026-08-17T09:59:59Z')), 'peak');    // Mon 17:59
  assert.equal(billingPeriodAt(at('2026-08-17T10:00:00Z')), 'off-peak'); // Mon 18:00
  assert.equal(billingPeriodAt(at('2026-08-17T15:00:00Z')), 'off-peak'); // Mon 23:00
  // Weekends are all off-peak regardless of the clock (since 2026-08-23).
  assert.equal(billingPeriodAt(at('2026-08-22T02:00:00Z')), 'off-peak'); // Sat 10:00
  assert.equal(billingPeriodAt(at('2026-08-23T02:00:00Z')), 'off-peak'); // Sun 10:00
});

test('calculateCost applies the peak multiplier inside peak hours only', () => {
  const pricing = {
    currency: 'cny' as const,
    promptTokenCostPer1M: 1.5,
    completionTokenCostPer1M: 4.5,
    cacheHitTokenCostPer1M: 0.05,
    promptTokensIncludeCacheHits: true,
    peakMultiplier: 2,
  };
  const usage = { promptTokens: 1_000_000, completionTokens: 500_000, cacheHitTokens: 800_000, cacheMissTokens: 200_000 };
  const offPeak = calculateCost(usage, pricing, new Date('2026-08-17T15:00:00Z')); // Mon 23:00
  const peak = calculateCost(usage, pricing, new Date('2026-08-17T02:00:00Z')); // Mon 10:00
  // Off-peak: miss 200k×1.5 + completion 500k×4.5 + hit 800k×0.05, in CNY → USD.
  assert.ok(Math.abs(offPeak.totalCostUsd - ((0.2 * 1.5 + 0.5 * 4.5 + 0.8 * 0.05) / DEFAULT_CNY_PER_USD)) < 0.001);
  // Peak: every rate doubles.
  assert.ok(Math.abs(peak.totalCostUsd - 2 * ((0.2 * 1.5 + 0.5 * 4.5 + 0.8 * 0.05) / DEFAULT_CNY_PER_USD)) < 0.001);
  // Weekend peak-hour request still bills off-peak.
  const weekend = calculateCost(usage, pricing, new Date('2026-08-22T02:00:00Z')); // Sat 10:00
  assert.equal(weekend.totalCostUsd, offPeak.totalCostUsd);
});

test('calculateCost converts CNY pricing to USD with a configurable rate', () => {
  const cost = calculateCost(
    { promptTokens: 1_000_000, completionTokens: 0 },
    { currency: 'cny', promptTokenCostPer1M: 1, completionTokenCostPer1M: 1, cacheHitTokenCostPer1M: 0, cnyPerUsd: 7 },
  );
  assert.equal(cost.promptCostUsd, 1 / 7);
  assert.equal(cost.totalCostUsd, 1 / 7);
  // Default rate applies when cnyPerUsd is omitted.
  const defaultRate = calculateCost(
    { promptTokens: 1_000_000, completionTokens: 0 },
    { currency: 'cny', promptTokenCostPer1M: 1, completionTokenCostPer1M: 1, cacheHitTokenCostPer1M: 0 },
  );
  assert.equal(defaultRate.promptCostUsd, 1 / DEFAULT_CNY_PER_USD);
});

test('openai and codex have pricing data', () => {
  assert.ok(resolveModelProfile('openai').pricing);
  assert.ok(resolveModelProfile('codex').pricing);
});

test('anthropic-based profiles have pricing data', () => {
  assert.ok(resolveModelProfile('claude').pricing);
  assert.ok(resolveModelProfile('anthropic').pricing);
});
