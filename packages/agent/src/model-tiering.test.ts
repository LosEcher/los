import test from 'node:test';
import assert from 'node:assert/strict';

import {
  scoreComplexity,
  resolveModelTier,
  type ComplexityInput,
  type TieringConfig,
} from './model-tiering.js';

// ── scoreComplexity ─────────────────────────────────────────

test('scoreComplexity: simple prompt → simple tier', () => {
  const input: ComplexityInput = {
    prompt: 'Fix a typo in README.md',
    fileCount: 1,
    specLayerCount: 1,
    toolCount: 5,
  };
  const result = scoreComplexity(input);
  assert.equal(result.label, 'simple');
  assert.ok(result.score <= 25);
});

test('scoreComplexity: large prompt + many files → complex tier', () => {
  const input: ComplexityInput = {
    prompt: 'x'.repeat(2500),
    fileCount: 20,
    specLayerCount: 5,
    toolCount: 25,
  };
  const result = scoreComplexity(input);
  assert.equal(result.label, 'complex');
  assert.ok(result.score >= 56, `expected >=56, got ${result.score}`);
});

test('scoreComplexity: moderate input', () => {
  const input: ComplexityInput = {
    prompt: 'Add input validation to the provider config resolver and update tests.',
    fileCount: 8,
    specLayerCount: 3,
    toolCount: 12,
  };
  const result = scoreComplexity(input);
  assert.equal(result.label, 'moderate');
  assert.ok(result.score >= 26 && result.score <= 55, `expected 26-55, got ${result.score}`);
});

test('scoreComplexity: prompt length boundaries', () => {
  const short = scoreComplexity({ prompt: 'x'.repeat(100), fileCount: 0, specLayerCount: 0, toolCount: 0 });
  assert.equal(short.score, 0, 'very short prompt → 0');

  const mid = scoreComplexity({ prompt: 'x'.repeat(600), fileCount: 0, specLayerCount: 0, toolCount: 0 });
  assert.equal(mid.score, 15, 'mid-length prompt → +15');

  const long = scoreComplexity({ prompt: 'x'.repeat(2500), fileCount: 0, specLayerCount: 0, toolCount: 0 });
  assert.equal(long.score, 30, 'long prompt → +30');
});

test('scoreComplexity: factor list references contributing inputs', () => {
  const input: ComplexityInput = {
    prompt: 'x'.repeat(2500),
    fileCount: 20,
    specLayerCount: 5,
    toolCount: 25,
  };
  const result = scoreComplexity(input);
  assert.ok(result.factors.length >= 4, `expected >=4 factors, got ${result.factors.length}`);
  assert.ok(result.factors.some(f => f.includes('prompt')));
  assert.ok(result.factors.some(f => f.includes('file')));
  assert.ok(result.factors.some(f => f.includes('spec')));
  assert.ok(result.factors.some(f => f.includes('tool')));
});

// ── resolveModelTier ────────────────────────────────────────

const TEST_TIERING: TieringConfig = {
  enabled: true,
  tiers: [
    { label: 'simple', provider: 'deepseek', model: 'deepseek-v4-flash' },
    { label: 'moderate', provider: 'anthropic', model: 'claude-sonnet-4-20250514' },
    { label: 'complex', provider: 'anthropic', model: 'claude-opus-4-8-20250514' },
    { label: 'default', provider: 'deepseek', model: 'deepseek-v4-pro' },
  ],
};

test('resolveModelTier routes simple to flash model', () => {
  const result = resolveModelTier(
    { score: 10, label: 'simple', factors: [] },
    TEST_TIERING,
  );
  assert.ok(result);
  assert.equal(result!.provider, 'deepseek');
  assert.equal(result!.model, 'deepseek-v4-flash');
});

test('resolveModelTier routes complex to opus model', () => {
  const result = resolveModelTier(
    { score: 80, label: 'complex', factors: [] },
    TEST_TIERING,
  );
  assert.ok(result);
  assert.equal(result!.provider, 'anthropic');
  assert.equal(result!.model, 'claude-opus-4-8-20250514');
});

test('resolveModelTier returns null when tiering disabled', () => {
  const result = resolveModelTier(
    { score: 80, label: 'complex', factors: [] },
    { enabled: false, tiers: [] },
  );
  assert.equal(result, null);
});

test('resolveModelTier returns null when no tiers configured', () => {
  const result = resolveModelTier(
    { score: 10, label: 'simple', factors: [] },
    { enabled: true, tiers: [] },
  );
  assert.equal(result, null);
});

test('resolveModelTier falls back to default tier for unknown labels', () => {
  // 'moderate' with no moderate tier → should fall to 'default'
  const config: TieringConfig = {
    enabled: true,
    tiers: [
      { label: 'simple', provider: 'deepseek', model: 'flash' },
      { label: 'default', provider: 'openai', model: 'fallback' },
    ],
  };
  const result = resolveModelTier(
    { score: 35, label: 'moderate', factors: [] },
    config,
  );
  assert.ok(result);
  assert.equal(result!.model, 'fallback');
});

test('scoreComplexity max score is naturally bounded by thresholds', () => {
  const input: ComplexityInput = {
    prompt: 'x'.repeat(10000),
    fileCount: 100,
    specLayerCount: 100,
    toolCount: 100,
  };
  // 30 (prompt) + 25 (files) + 20 (specs) + 20 (tools) = 95 max
  const result = scoreComplexity(input);
  assert.equal(result.score, 95);
  assert.equal(result.label, 'complex');
});
