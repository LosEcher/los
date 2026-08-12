import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyPlanAnnotations,
  composeOperatorReason,
  createPlanAnnotation,
  createReviewFinding,
  summarizePlanAnnotations,
  summarizeReviewFindings,
} from './plan-annotate.mjs';

test('applyPlanAnnotations patches title, description, and notes', () => {
  const plan = [
    { id: 's1', title: 'A', description: 'do a' },
    { id: 's2', title: 'B', description: 'do b' },
  ];
  const next = applyPlanAnnotations(plan, [
    createPlanAnnotation({ stepIndex: 0, kind: 'replace_title', text: 'A2' }),
    createPlanAnnotation({ stepIndex: 1, kind: 'note', text: 'cover edge cases' }),
  ]);
  assert.equal(next[0].title, 'A2');
  assert.equal(next[0].description, 'do a');
  assert.match(next[1].description, /cover edge cases/);
  assert.equal(plan[0].title, 'A'); // original untouched
});

test('composeOperatorReason merges free text with structured annotations', () => {
  const reason = composeOperatorReason(
    'needs tighter scope',
    [createPlanAnnotation({ stepIndex: 0, kind: 'note', text: 'drop migration' })],
    [createReviewFinding({ path: 'a.ts', line: 12, severity: 'critical', note: 'null deref' })],
  );
  assert.match(reason, /needs tighter scope/);
  assert.match(reason, /Plan annotations/);
  assert.match(reason, /drop migration/);
  assert.match(reason, /Review findings/);
  assert.match(reason, /a\.ts:12/);
});

test('summaries are empty when no annotations', () => {
  assert.equal(summarizePlanAnnotations([]), '');
  assert.equal(summarizeReviewFindings([]), '');
  assert.equal(composeOperatorReason('', [], []), 'operator review');
});
