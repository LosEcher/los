import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveSessionCwd, resolveSessionCwds } from './session-path-resolver.js';

const ROOT = '/NEW/project';
const MAP = {
  version: 2,
  verified: [{ from: '/OLD/project/x', to: '/NEW/project/x', basis: 'same-leaf' }],
  declared: [{ from: '/GONE/project/y', to: '/NEW/project/y', basis: 'reloc', declaredBy: 'operator' }],
};

test('B3.3: three states are distinguishable', () => {
  assert.equal(resolveSessionCwd('/NEW/project/a', { currentRoot: ROOT, aliasMap: MAP }).state, 'current');
  assert.equal(resolveSessionCwd('/OLD/project/x', { currentRoot: ROOT, aliasMap: MAP }).state, 'resolved');
  assert.equal(resolveSessionCwd('/GONE/project/y', { currentRoot: ROOT, aliasMap: MAP }).state, 'resolved');
  assert.equal(resolveSessionCwd('/GONE/project/y', { currentRoot: ROOT, aliasMap: MAP }).target, '/NEW/project/y');
  assert.equal(resolveSessionCwd('/ELSEWHERE/z', { currentRoot: ROOT, aliasMap: MAP }).state, 'unknown');
  assert.equal(resolveSessionCwd('/OLD/project/x/', { currentRoot: ROOT, aliasMap: MAP }).state, 'resolved');
});

test('B3.3 NEGATIVE: a MISSING alias map yields unknown, never current, and is never dropped', () => {
  const one = resolveSessionCwd('/GONE/project/y', { currentRoot: ROOT, aliasMap: null });
  assert.equal(one.state, 'unknown');
  assert.notEqual(one.state, 'current');
  assert.match(String(one.reason), /no-map/, '"没读到映射表" 必须与 "无映射需求" 可分辨');

  // 批量：一条都不能少
  const many = Array.from({ length: 214 }, (_, i) => `/GONE/project/r${i}`);
  const b = resolveSessionCwds(many, { currentRoot: ROOT, aliasMap: null });
  assert.equal(b.byState.unknown, 214, '214 条历史会话必须全部保留为 unknown');
  assert.equal(b.results.length, 214, '一条都不能丢');
  assert.equal(b.unknownCwds.length, 214, 'unknown 清单不得截断');
});

test('B3.3: no-map and unmapped are distinguishable reasons', () => {
  const noMap = resolveSessionCwd('/ELSEWHERE/z', { currentRoot: ROOT, aliasMap: null });
  const unmapped = resolveSessionCwd('/ELSEWHERE/z', { currentRoot: ROOT, aliasMap: MAP });
  assert.equal(noMap.state, 'unknown');
  assert.equal(unmapped.state, 'unknown');
  assert.match(String(noMap.reason), /no-map/);
  assert.match(String(unmapped.reason), /unmapped/);
  assert.notEqual(noMap.reason, unmapped.reason);
});

test('B3.3: byState counts add up to the input size', () => {
  const b = resolveSessionCwds(['/NEW/project/a', '/OLD/project/x', '/ELSEWHERE/z'], { currentRoot: ROOT, aliasMap: MAP });
  assert.deepEqual(b.byState, { current: 1, resolved: 1, unknown: 1 });
  assert.equal(b.byState.current + b.byState.resolved + b.byState.unknown, b.results.length);
});
