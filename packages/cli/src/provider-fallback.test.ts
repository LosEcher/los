import assert from 'node:assert/strict';
import test from 'node:test';

import { parseProviderFallbackFlags } from './provider-fallback.js';

test('CLI parses an explicit ordered provider fallback policy', () => {
  assert.deepEqual(parseProviderFallbackFlags({
    'fallback-target': 'deepseek:deepseek-v4-flash,xai:grok-4.3',
    'fallback-on': 'rate_limit,provider_unavailable',
    'fallback-max-switches': '1',
  }), {
    mode: 'explicit_ordered',
    targets: [
      { provider: 'deepseek', model: 'deepseek-v4-flash' },
      { provider: 'xai', model: 'grok-4.3' },
    ],
    onFailure: ['rate_limit', 'provider_unavailable'],
    requireCompatibilityEvidence: true,
    maxSwitches: 1,
  });
});

test('CLI fallback remains opt-in and evidence-gated by default', () => {
  assert.equal(parseProviderFallbackFlags({}), undefined);
  assert.equal(parseProviderFallbackFlags({ fallback: 'a:a-1,b:b-1' })?.requireCompatibilityEvidence, true);
  assert.equal(parseProviderFallbackFlags({
    fallback: 'a:a-1,b:b-1',
    'fallback-without-compat-evidence': true,
  })?.requireCompatibilityEvidence, false);
});

test('CLI rejects incomplete or unsupported fallback policies', () => {
  assert.throws(() => parseProviderFallbackFlags({ 'fallback-target': 'a:a-1' }), /at least two/);
  assert.throws(() => parseProviderFallbackFlags({
    'fallback-target': 'a:a-1,b:b-1',
    'fallback-on': 'auth',
  }), /supports only/);
});
