import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveModelRouteDecision } from './model-routing.js';

const effective = {
  effectiveProvider: 'deepseek',
  effectiveModel: 'deepseek-v4-flash',
};

test('model route defaults to configured provider and model', () => {
  assert.deepEqual(resolveModelRouteDecision(effective), {
    requestedProvider: undefined,
    requestedModel: undefined,
    ...effective,
    reason: 'configured_default',
  });
});

test('explicit model takes precedence over explicit provider reason', () => {
  assert.equal(resolveModelRouteDecision({
    ...effective,
    requestedProvider: 'deepseek',
    requestedModel: 'deepseek-v4-pro',
  }).reason, 'explicit_model');
});

test('explicit provider is recorded when the model comes from configuration', () => {
  assert.equal(resolveModelRouteDecision({
    ...effective,
    requestedProvider: 'deepseek',
  }).reason, 'explicit_provider');
});

test('architect editor overrides retain their distinct route reason', () => {
  const decision = resolveModelRouteDecision({
    ...effective,
    requestedProvider: 'deepseek',
    requestedModel: 'deepseek-v4-pro',
    architectEditorOverride: true,
  });
  assert.equal(decision.reason, 'architect_editor_override');
  assert.equal(decision.requestedModel, 'deepseek-v4-pro');
});
