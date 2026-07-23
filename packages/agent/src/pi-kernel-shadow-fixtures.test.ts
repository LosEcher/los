import assert from 'node:assert/strict';
import test from 'node:test';
import { _collectPiKernelShadowDeterministicEvidence } from './pi-kernel-shadow-fixtures.js';
import type { SessionEventWrite } from './session-events.js';

test('deterministic collector runs the fixed Pi scenarios through shadow settlement', async () => {
  const writes: SessionEventWrite[] = [];
  let sequence = 0;
  const observations = await _collectPiKernelShadowDeterministicEvidence({
    'PKS01-no-tool': 1,
    'PKS02-read-only-tool': 1,
    'PKS03-policy-denial': 3,
    'PKS04-provider-failure': 3,
    'PKS05-interruption': 3,
  }, {
    id: () => `test-${sequence++}`,
    appendEvent: async input => { writes.push(input); },
  });

  assert.equal(observations.length, 11);
  assert.deepEqual(
    observations.filter(item => !item.passed),
    [],
  );
  assert.ok(observations.every(item => item.candidateInputLineageMatches));
  assert.deepEqual(
    observations.map(item => item.status),
    ['completed', 'completed', 'completed', 'completed', 'completed', 'failed', 'failed', 'failed', 'interrupted', 'interrupted', 'interrupted'],
  );
  assert.equal(writes.length, 11);
  assert.ok(writes.every(item => item.type === 'kernel.shadow.compared'));
  assert.ok(writes.every(item => {
    const evidence = item.payload?.scenarioEvidence as Record<string, unknown> | undefined;
    return evidence?.evidenceClass === 'deterministic' && evidence.passed === true;
  }));
});

test('deterministic collector rejects unbounded repeat counts', async () => {
  await assert.rejects(
    _collectPiKernelShadowDeterministicEvidence({ 'PKS01-no-tool': 11 }),
    /Invalid deterministic fixture observation count/,
  );
});
