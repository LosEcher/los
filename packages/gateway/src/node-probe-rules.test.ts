/**
 * node-probe-rules unit tests (B9 declarative probe rules, borrowed from
 * mac-performance-monitor CheckCatalog/DiagnosticProbes).
 *
 * Run: node --test src/node-probe-rules.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NODE_PROBE_SIGNALS,
  builtinNodeProbeRules,
  evaluateNodeProbeRules,
  _ruleMatches,
  _signalValueOf,
  type NodeProbeRule,
  type NodeHealthSignals,
} from './node-probe-rules.js';

function signals(partial: Partial<NodeHealthSignals>): NodeHealthSignals {
  return {
    modesOk: partial.modesOk ?? 1,
    modesTotal: partial.modesTotal ?? 1,
    heartbeatAgeSec: partial.heartbeatAgeSec ?? 10,
    blockerCount: partial.blockerCount ?? 0,
    hasVerificationGap: partial.hasVerificationGap ?? false,
    recovering: partial.recovering ?? false,
  };
}

// ── signalValueOf ───────────────────────────────────────────────────────
test('signalValueOf: maps each signal', () => {
  const s = signals({ modesOk: 2, modesTotal: 4, heartbeatAgeSec: 60, blockerCount: 3, hasVerificationGap: true, recovering: true });
  assert.equal(_signalValueOf('heartbeatAgeSec', s), 60);
  assert.equal(_signalValueOf('modesRatio', s), 0.5);
  assert.equal(_signalValueOf('blockerCount', s), 3);
  assert.equal(_signalValueOf('hasVerificationGap', s), 1);
  assert.equal(_signalValueOf('recovering', s), 1);
  assert.equal(_signalValueOf('modesRatio', signals({ modesTotal: 0 })), 0);
});

// ── ruleMatches ─────────────────────────────────────────────────────────
test('ruleMatches: all operators', () => {
  const rule = (op: '>=' | '<=' | '>' | '<' | '==' | '!='): NodeProbeRule => ({
    id: 't', title: 't', severity: 'warning',
    when: { signal: 'heartbeatAgeSec', op, value: 10 }, message: 'm',
  });
  assert.equal(_ruleMatches(rule('>='), 10), true);
  assert.equal(_ruleMatches(rule('>='), 9), false);
  assert.equal(_ruleMatches(rule('<='), 10), true);
  assert.equal(_ruleMatches(rule('<='), 11), false);
  assert.equal(_ruleMatches(rule('>'), 11), true);
  assert.equal(_ruleMatches(rule('>'), 10), false);
  assert.equal(_ruleMatches(rule('<'), 9), true);
  assert.equal(_ruleMatches(rule('<'), 10), false);
  assert.equal(_ruleMatches(rule('=='), 10), true);
  assert.equal(_ruleMatches(rule('=='), 9), false);
  assert.equal(_ruleMatches(rule('!='), 9), true);
  assert.equal(_ruleMatches(rule('!='), 10), false);
});

// ── evaluateNodeProbeRules ──────────────────────────────────────────────
test('evaluate: stale heartbeat fires critical', () => {
  const findings = evaluateNodeProbeRules(builtinNodeProbeRules(), signals({ heartbeatAgeSec: 3600 }));
  const stale = findings.find((f) => f.ruleId === 'node-stale-heartbeat');
  assert.ok(stale, 'stale-heartbeat should fire');
  assert.equal(stale!.severity, 'critical');
});

test('evaluate: no probe coverage fires critical (modesRatio 0)', () => {
  const findings = evaluateNodeProbeRules(builtinNodeProbeRules(), signals({ modesOk: 0, modesTotal: 2 }));
  const noCov = findings.find((f) => f.ruleId === 'node-no-probe-coverage');
  assert.ok(noCov);
  assert.equal(noCov!.severity, 'critical');
});

test('evaluate: healthy node fires nothing', () => {
  const findings = evaluateNodeProbeRules(builtinNodeProbeRules(), signals({}));
  assert.deepEqual(findings, []);
});

test('evaluate: accumulating blockers fires warning', () => {
  const findings = evaluateNodeProbeRules(builtinNodeProbeRules(), signals({ blockerCount: 3 }));
  assert.ok(findings.some((f) => f.ruleId === 'node-blockers-accumulating'));
});

test('evaluate: recovering fires info', () => {
  const findings = evaluateNodeProbeRules(builtinNodeProbeRules(), signals({ recovering: true }));
  assert.ok(findings.some((f) => f.ruleId === 'node-recovering'));
  assert.equal(findings.find((f) => f.ruleId === 'node-recovering')!.severity, 'info');
});

test('evaluate: unknown signal skipped (forward-compatible)', () => {
  const bogus: NodeProbeRule = {
    id: 'bogus', title: 'b', severity: 'critical',
    when: { signal: 'totally.unknown' as NodeProbeRule['when']['signal'], op: '>', value: 1 }, message: 'm',
  };
  const findings = evaluateNodeProbeRules([bogus], signals({}));
  assert.deepEqual(findings, []);
});

test('evaluate: null/undefined rules → empty', () => {
  assert.deepEqual(evaluateNodeProbeRules(null as unknown as NodeProbeRule[], signals({})), []);
});

// ── signal allow-list stability ──────────────────────────────────────────
test('NODE_PROBE_SIGNALS is the fixed allow-list', () => {
  assert.deepEqual(NODE_PROBE_SIGNALS, [
    'heartbeatAgeSec', 'modesRatio', 'blockerCount', 'hasVerificationGap', 'recovering',
  ]);
});
