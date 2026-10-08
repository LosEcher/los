import test from 'node:test';
import assert from 'node:assert/strict';

import {
  OVERRIDABLE_FIELDS,
  detectRouteConflicts,
  detectRouteRouting,
  sourceNamespace,
  summarizeConflicts,
} from './provider-route-conflicts.js';

// ─────────────────────────────────────────────────────────────
// 正向：prefer 覆盖了不同的值 ⇒ 必须留下冲突记录
// ─────────────────────────────────────────────────────────────
test('prefer overwriting a different baseUrl is recorded as a conflict', () => {
  const conflicts = detectRouteConflicts({
    provider: 'packycode',
    existing: { baseUrl: 'https://www.packyapi.com/v1', source: '~/.los/config.yaml' },
    incoming: { baseUrl: 'https://www.packyapi.ai/v1', source: 'cc-switch/codex/PackyCode', sourceTool: 'cc-switch' },
    prefer: true,
  });
  assert.equal(conflicts.length, 1);
  const c = conflicts[0]!;
  assert.equal(c.provider, 'packycode');
  assert.equal(c.field, 'baseUrl');
  assert.equal(c.previous, 'https://www.packyapi.com/v1');
  assert.equal(c.next, 'https://www.packyapi.ai/v1');
  assert.equal(c.winnerSource, 'cc-switch');
  assert.equal(c.loserSource, '~/.los/config.yaml');
  assert.equal(c.ownerLayer, 'cc-switch-desktop');
});

test('conflict reports one entry per differing field', () => {
  const conflicts = detectRouteConflicts({
    provider: 'xai',
    existing: { baseUrl: 'https://a/v1', model: 'grok-4.5', apiShape: 'openai-chat-completions', source: 'discovered' },
    incoming: { baseUrl: 'https://b/v1', model: 'grok-4.7', apiShape: 'openai-responses', source: 'cc-switch/grokbuild/PackyCode', sourceTool: 'cc-switch' },
    prefer: true,
  });
  assert.deepEqual(conflicts.map(c => c.field).sort(), ['apiShape', 'baseUrl', 'model']);
});

// ─────────────────────────────────────────────────────────────
// 安全：apiKey 覆盖必须脱敏（绝不落明文）
// ─────────────────────────────────────────────────────────────
test('apiKey conflict is recorded but NEVER stores the plaintext value', () => {
  const conflicts = detectRouteConflicts({
    provider: 'kimi',
    existing: { apiKey: 'sk-old-secret-value', source: 'env:KIMI_API_KEY' },
    incoming: { apiKey: 'sk-new-secret-value', source: 'cc-switch/kimi/x', sourceTool: 'cc-switch' },
    prefer: true,
  });
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0]!.field, 'apiKey');
  assert.equal(conflicts[0]!.previous, '<redacted>');
  assert.equal(conflicts[0]!.next, '<redacted>');
  const blob = JSON.stringify(conflicts);
  assert.ok(!blob.includes('sk-old-secret-value'), 'plaintext previous must not appear');
  assert.ok(!blob.includes('sk-new-secret-value'), 'plaintext next must not appear');
});

// ─────────────────────────────────────────────────────────────
// 负向控制：以下情形**不得**产生冲突记录（否则就是噪音/fail-open）
// ─────────────────────────────────────────────────────────────
test('NEGATIVE: non-prefer discovery never produces a conflict', () => {
  const conflicts = detectRouteConflicts({
    provider: 'packycode',
    existing: { baseUrl: 'https://a/v1', source: 'config' },
    incoming: { baseUrl: 'https://b/v1', source: 'codex-auth' },
    prefer: false,
  });
  assert.deepEqual(conflicts, []);
});

test('NEGATIVE: first-time fill (previous empty) is not a conflict', () => {
  for (const prev of [{}, { baseUrl: '' }, { baseUrl: undefined }]) {
    const conflicts = detectRouteConflicts({
      provider: 'p',
      existing: prev as Record<string, unknown>,
      incoming: { baseUrl: 'https://new/v1', source: 'cc-switch/x', sourceTool: 'cc-switch' },
      prefer: true,
    });
    assert.deepEqual(conflicts, [], `prev=${JSON.stringify(prev)} must not conflict`);
  }
});

test('NEGATIVE: identical value is not a conflict', () => {
  const conflicts = detectRouteConflicts({
    provider: 'p',
    existing: { baseUrl: 'https://same/v1', source: 'yaml' },
    incoming: { baseUrl: 'https://same/v1', source: 'cc-switch/x', sourceTool: 'cc-switch' },
    prefer: true,
  });
  assert.deepEqual(conflicts, []);
});

test('sourceNamespace treats cc-switch sub-routes as one decision center', () => {
  assert.equal(sourceNamespace('cc-switch/codex/PackyCode'), 'cc-switch');
  assert.equal(sourceNamespace('cc-switch/grokbuild/PackyCode'), 'cc-switch');
  assert.equal(sourceNamespace('cc-switch'), 'cc-switch');
  assert.equal(sourceNamespace('env:KIMI_API_KEY'), 'env');
  assert.equal(sourceNamespace(''), '(unknown)');
});

test('NEGATIVE: same decision center variant is NOT a conflict (real 2026-10-08 false positive)', () => {
  // 实测形态：cc-switch 的 codex 路由 → api-slb.packyapi.com，grokbuild 路由 → cf.api.fan。
  // 两者同属 cc-switch，是**合理路由**，不是冲突。
  const r = detectRouteRouting({
    provider: 'packycode',
    existing: { baseUrl: 'https://api-slb.packyapi.com/v1', source: 'cc-switch/codex/PackyCode' },
    incoming: { baseUrl: 'https://cf.api.fan/v1', source: 'cc-switch/grokbuild/PackyCode', sourceTool: 'cc-switch' },
    prefer: true,
  });
  assert.deepEqual(r.conflicts, [], 'same-center variant must not be a cross-center conflict');
  assert.equal(r.sameCenterVariants.length, 1, 'but it must still be observable');
  assert.equal(r.sameCenterVariants[0]!.field, 'baseUrl');
});

test('cross-center overwrite (operator yaml vs cc-switch) IS a conflict', () => {
  const r = detectRouteRouting({
    provider: 'packycode',
    existing: { baseUrl: 'https://operator.example/v1', source: '~/.los/config.yaml' },
    incoming: { baseUrl: 'https://cc.example/v1', source: 'cc-switch/codex/PackyCode', sourceTool: 'cc-switch' },
    prefer: true,
  });
  assert.equal(r.conflicts.length, 1);
  assert.equal(r.conflicts[0]!.loserSource, '~/.los/config.yaml');
  assert.equal(r.sameCenterVariants.length, 0);
});

test('redacted apiKey overwrite is reported AND marked unverifiable', () => {
  const r = detectRouteRouting({
    provider: 'kimi',
    existing: { apiKey: 'sk-a', source: 'env:KIMI_API_KEY' },
    incoming: { apiKey: 'sk-b', source: 'cc-switch/kimi/x', sourceTool: 'cc-switch' },
    prefer: true,
  });
  assert.equal(r.conflicts.length, 1, 'must still be surfaced');
  assert.equal(r.unverifiable.length, 1, 'but explicitly marked not-decidable');
  assert.match(r.unverifiable[0]!.reason, /redacted/);
});

test('NEGATIVE: no existing entry at all means nothing to overwrite', () => {
  const conflicts = detectRouteConflicts({
    provider: 'new-provider',
    existing: undefined,
    incoming: { baseUrl: 'https://x/v1', source: 'cc-switch/x', sourceTool: 'cc-switch' },
    prefer: true,
  });
  assert.deepEqual(conflicts, []);
});

test('NEGATIVE: empty incoming value does not overwrite (and is not a conflict)', () => {
  const conflicts = detectRouteConflicts({
    provider: 'p',
    existing: { baseUrl: 'https://a/v1', source: 'yaml' },
    incoming: { baseUrl: '', source: 'cc-switch/x', sourceTool: 'cc-switch' },
    prefer: true,
  });
  assert.deepEqual(conflicts, []);
});

// ─────────────────────────────────────────────────────────────
// 覆盖字段集必须与 merge 的实际覆盖面一致（防"检测漏字段"）
// ─────────────────────────────────────────────────────────────
test('OVERRIDABLE_FIELDS matches the fields mergeDiscoveredProviders actually overwrites', () => {
  assert.deepEqual([...OVERRIDABLE_FIELDS], ['apiKey', 'baseUrl', 'model', 'apiShape']);
});

test('every overridable field is individually detectable', () => {
  for (const field of OVERRIDABLE_FIELDS) {
    const conflicts = detectRouteConflicts({
      provider: 'p',
      existing: { [field]: 'old', source: 'yaml' },
      incoming: { [field]: 'new', source: 'cc-switch/x', sourceTool: 'cc-switch' },
      prefer: true,
    });
    assert.equal(conflicts.length, 1, `field ${field} must be detectable`);
    assert.equal(conflicts[0]!.field, field);
  }
});

// ─────────────────────────────────────────────────────────────
// 摘要
// ─────────────────────────────────────────────────────────────
test('summarizeConflicts renders a stable one-line summary', () => {
  assert.equal(summarizeConflicts([]), 'no provider route conflicts');
  const conflicts = detectRouteConflicts({
    provider: 'packycode',
    existing: { baseUrl: 'https://a/v1', model: 'm1', source: 'yaml' },
    incoming: { baseUrl: 'https://b/v1', model: 'm2', source: 'cc-switch/x', sourceTool: 'cc-switch' },
    prefer: true,
  });
  const s = summarizeConflicts(conflicts);
  assert.match(s, /^packycode\(/);
  assert.match(s, /baseUrl:yaml→cc-switch/);
  assert.match(s, /model:yaml→cc-switch/);
});

test('existingSource override takes precedence when provided', () => {
  const conflicts = detectRouteConflicts({
    provider: 'p',
    existing: { baseUrl: 'https://a/v1', source: 'something-else' },
    incoming: { baseUrl: 'https://b/v1', source: 'cc-switch/x', sourceTool: 'cc-switch' },
    prefer: true,
    existingSource: 'explicit-operator-value',
  });
  assert.equal(conflicts[0]!.loserSource, 'explicit-operator-value');
});
