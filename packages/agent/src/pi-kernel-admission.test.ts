import assert from 'node:assert/strict';
import test from 'node:test';
import {
  _PI_KERNEL_ADMISSION_DECISIONS,
  assertPiKernelInputAdmission,
  _evaluatePiKernelInputAdmission,
  evaluatePiKernelShadowAdmission,
} from './pi-kernel-admission.js';

test('Pi admission reports every unsupported semantic without silently dropping settings', () => {
  const issues = _evaluatePiKernelInputAdmission({
    providerFallback: {
      mode: 'explicit_ordered',
      targets: [{ provider: 'a' }, { provider: 'b' }],
      onFailure: ['transport'],
      requireCompatibilityEvidence: false,
      maxSwitches: 1,
    },
    architectEditor: { enabled: true },
    contextCompression: { enabled: true },
    modelSettings: { topP: 0.9, reasoningEffort: 'none' },
  });

  assert.deepEqual(issues.map(issue => issue.code), [
    'provider_fallback',
    'architect_editor',
    'context_compression',
    'sampling_settings',
    'reasoning_disablement',
  ]);
  assert.equal(_PI_KERNEL_ADMISSION_DECISIONS.childAgents, 'los_owned');
  assert.throws(() => assertPiKernelInputAdmission({ providerFallback: {
    mode: 'explicit_ordered', targets: [{ provider: 'a' }], onFailure: ['transport'],
    requireCompatibilityEvidence: false, maxSwitches: 0,
  } }), /provider fallback mapping is not implemented/);
});

test('Pi shadow admission requires local read-only execution', () => {
  const issues = evaluatePiKernelShadowAdmission({
    config: {},
    effectiveToolMode: 'project-write',
    remoteExecutor: true,
  });

  assert.deepEqual(issues.map(issue => issue.code), [
    'non_read_only_shadow',
    'remote_executor_shadow',
  ]);
});
