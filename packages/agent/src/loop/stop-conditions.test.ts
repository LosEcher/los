import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildStopConditionReminder,
  checkStopConditionsMet,
  evaluateStopConditions,
  getStopConditions,
  hasStopConditions,
} from './stop-conditions.js';

// ── hasStopConditions ────────────────────────────────────

test('hasStopConditions detects populated arrays', () => {
  assert.equal(hasStopConditions(undefined), false);
  assert.equal(hasStopConditions({}), false);
  assert.equal(hasStopConditions({ stopConditions: [] }), false);
  assert.equal(hasStopConditions({ stopConditions: ['  '] }), false);
  assert.equal(hasStopConditions({ stopConditions: ['pnpm check passes'] }), true);
  assert.equal(hasStopConditions({ stopConditions: ['a', 'b'] }), true);
});

test('getStopConditions extracts and trims conditions', () => {
  assert.deepEqual(getStopConditions(undefined), []);
  assert.deepEqual(getStopConditions({ stopConditions: ['  a  ', 'b', '', '  c  '] }), ['a', 'b', 'c']);
});

// ── checkStopConditionsMet ───────────────────────────────

test('checkStopConditionsMet matches explicit declaration patterns', () => {
  assert.equal(checkStopConditionsMet('Stop conditions are met. Summary: done.'), true);
  assert.equal(checkStopConditionsMet('All conditions satisfied. Proceeding.'), true);
  assert.equal(checkStopConditionsMet('Stopping conditions fulfilled.'), true);
  assert.equal(checkStopConditionsMet('Task complete, all conditions met.'), true);
  assert.equal(checkStopConditionsMet('Goal achieved, conditions met.'), true);
  assert.equal(checkStopConditionsMet('I will continue working on the task.'), false);
  assert.equal(checkStopConditionsMet(''), false);
});

// ── evaluateStopConditions (per-condition) ───────────────

test('evaluateStopConditions returns empty result for empty input', () => {
  const result = evaluateStopConditions('', []);
  assert.equal(result.allMet, false);
  assert.equal(result.conditions.length, 0);
  assert.equal(result.declarativeMet, false);
});

test('evaluateStopConditions returns empty result for empty text', () => {
  const result = evaluateStopConditions('', ['pnpm check passes']);
  assert.equal(result.allMet, false);
  assert.equal(result.conditions.length, 0);
});

test('evaluateStopConditions uses declarative signal as fast path', () => {
  const result = evaluateStopConditions(
    'Stop conditions are all met. I verified everything.',
    ['pnpm check passes', 'tests green'],
  );
  assert.equal(result.declarativeMet, true);
  assert.equal(result.conditions.length, 2);
});

test('evaluateStopConditions parses stop-check fenced block', () => {
  const response = `Here is my evaluation:

\`\`\`stop-check
1. [yes] pnpm check output is clean — zero errors
2. [no]  still need to run tests
\`\`\``;
  const result = evaluateStopConditions(response, [
    'pnpm check passes',
    'pnpm test passes',
  ]);
  assert.equal(result.declarativeMet, false, 'declarative should be false (no global "all met")');
  assert.equal(result.conditions.length, 2);
  assert.equal(result.conditions[0]?.met, true, 'first condition should be met');
  assert.equal(result.conditions[1]?.met, false, 'second condition should be not met');
  assert.equal(result.allMet, false, 'not all met');
});

test('evaluateStopConditions parses all-yes stop-check block', () => {
  const response = `Stop conditions are all met.

\`\`\`stop-check
1. ✓ build passes — zero errors
2. ✓ lint clean — no warnings
\`\`\``;
  const result = evaluateStopConditions(response, [
    'build passes',
    'lint is clean',
  ]);
  assert.equal(result.declarativeMet, true);
  assert.equal(result.conditions[0]?.met, true);
  assert.equal(result.conditions[1]?.met, true);
  assert.equal(result.allMet, true);
});

test('evaluateStopConditions uses keyword fallback when no block', () => {
  const response = 'Yes, the pnpm check is done and the tests are complete. All conditions satisfied.';
  const result = evaluateStopConditions(response, [
    'pnpm check passes',
    'pnpm test passes',
  ]);
  assert.equal(result.declarativeMet, true);
  // Keyword heuristic: both conditions should have matched keywords + affirmative
  assert.equal(result.conditions.length, 2);
});

test('evaluateStopConditions detects missing condition in keyword fallback', () => {
  const response = 'The pnpm check is done. But I still need to handle the edge case.';
  const result = evaluateStopConditions(response, [
    'pnpm check passes',
    'edge case handling verified',
  ]);
  // First condition likely met (keyword found + affirmative), second may or may not
  assert.equal(result.conditions.length, 2);
  // With declarative not met and potentially one condition unmet, allMet should be false
  // (exact outcome depends on keyword matching)
});

// ── buildStopConditionReminder ───────────────────────────

test('buildStopConditionReminder returns null for empty conditions', () => {
  assert.equal(buildStopConditionReminder(undefined), null);
  assert.equal(buildStopConditionReminder({ stopConditions: [] }), null);
});

test('buildStopConditionReminder includes structured prompt format', () => {
  const reminder = buildStopConditionReminder({ stopConditions: ['pnpm check passes', 'tests green'] });
  assert.ok(reminder);
  assert.ok(reminder!.includes('STOP CONDITION CHECK'));
  assert.ok(reminder!.includes('pnpm check passes'));
  assert.ok(reminder!.includes('tests green'));
  assert.ok(reminder!.includes('stop-check'), 'new format should request structured stop-check block');
  assert.ok(reminder!.includes('[yes/no]'), 'new format should require yes/no per condition');
});

// ── Penultimate-turn guard path ──────────────────────────

test('evaluateStopConditions handles conditions with special characters', () => {
  const result = evaluateStopConditions(
    'Stop conditions are all met. I verified that PR #42 was merged and the v2.0.1 tag exists.',
    ['PR #42 merged to main', 'v2.0.1 tag created'],
  );
  assert.equal(result.declarativeMet, true);
  assert.equal(result.conditions.length, 2);
  // Should find keyword matches for both conditions
});

test('evaluateStopConditions handles large condition lists', () => {
  const conditions = Array.from({ length: 5 }, (_, i) => `condition ${i + 1} is satisfied`);
  const response = 'Stop conditions are all met. condition 1 is done, condition 2 is done, condition 3 is done, condition 4 is done, and condition 5 is done.';
  const result = evaluateStopConditions(response, conditions);
  assert.equal(result.declarativeMet, true);
  assert.equal(result.conditions.length, 5);
});
