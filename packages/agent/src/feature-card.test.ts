import test from 'node:test';
import assert from 'node:assert/strict';

import {
  _assertSurfacesWithinParent,
  buildCoordinatorWakeEvent,
  canDispatchReworkWorker,
  formatFeatureCardForReviewer,
  formatFeatureCardForWorker,
  validateFeatureCard,
  type FeatureCard,
} from './feature-card.js';

const card: FeatureCard = {
  goal: 'Add plan annotations to Work',
  acceptance: ['annotate path works', 'tests pass'],
  editableSurfaces: ['packages/web/src/plan-annotate.mjs'],
  files: [{ path: 'packages/web/src/plan-annotate.mjs', note: 'pure helpers' }],
  keySymbols: ['applyPlanAnnotations'],
  constraints: ['no raw hex in CSS'],
  outOfScope: ['kernel canary'],
  verificationHints: ['pnpm --filter @los/web test'],
};

test('validateFeatureCard rejects incomplete cards', () => {
  assert.deepEqual(validateFeatureCard(card), []);
  assert.ok(validateFeatureCard({
    goal: '',
    acceptance: [],
    editableSurfaces: [],
  }).length >= 3);
});

test('_assertSurfacesWithinParent flags out-of-parent paths', () => {
  assert.deepEqual(_assertSurfacesWithinParent(card, ['packages/web/src/plan-annotate.mjs']), []);
  assert.deepEqual(
    _assertSurfacesWithinParent(card, ['packages/agent/src']),
    ['packages/web/src/plan-annotate.mjs'],
  );
});

test('canDispatchReworkWorker forbids same writer identity', () => {
  const writer = {
    attemptId: 'att-1',
    taskRunId: 'run-1',
    sessionId: 'sess-1',
    role: 'worker' as const,
  };
  assert.equal(
    canDispatchReworkWorker(writer, { ...writer, attemptId: 'att-1' }).ok,
    false,
  );
  assert.equal(
    canDispatchReworkWorker(writer, {
      attemptId: 'att-2',
      taskRunId: 'run-1',
      sessionId: 'sess-2',
      role: 'worker',
    }).ok,
    false,
  );
  assert.equal(
    canDispatchReworkWorker(writer, {
      attemptId: 'att-2',
      taskRunId: 'run-2',
      sessionId: 'sess-1',
      role: 'worker',
    }).ok,
    false,
  );
  assert.equal(
    canDispatchReworkWorker(writer, {
      attemptId: 'att-2',
      taskRunId: 'run-2',
      sessionId: 'sess-2',
      role: 'worker',
    }).ok,
    true,
  );
});

test('formatFeatureCardForWorker is compact and goal-first', () => {
  const text = formatFeatureCardForWorker(card);
  assert.match(text, /# Feature card/);
  assert.match(text, /Add plan annotations/);
  assert.match(text, /applyPlanAnnotations/);
  assert.doesNotMatch(text, /full product vision/i);
});

test('formatFeatureCardForReviewer adds read-only role and findings', () => {
  const text = formatFeatureCardForReviewer(card, [
    { path: 'a.ts', line: 3, severity: 'critical', note: 'null deref' },
  ]);
  assert.match(text, /fresh reviewer/i);
  assert.match(text, /null deref/);
  assert.match(text, /read-only/i);
});

test('buildCoordinatorWakeEvent always names wake type', () => {
  const event = buildCoordinatorWakeEvent({
    kind: 'reviewer_rejected',
    graphId: 'g1',
    taskId: 't1',
    findings: [{ path: 'a.ts', severity: 'warning', note: 'x' }],
  });
  assert.equal(event.type, 'operator.coordinator.wake');
  assert.equal(event.kind, 'reviewer_rejected');
});
