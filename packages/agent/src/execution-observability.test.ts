import assert from 'node:assert/strict';
import test from 'node:test';

import { GOLDEN_EXECUTION_OBSERVABILITY_FIXTURES } from './execution-observability-fixtures.js';
import { projectExecutionObservability, type ExecutionObservabilityProjection } from './execution-observability.js';

for (const fixture of GOLDEN_EXECUTION_OBSERVABILITY_FIXTURES) {
  test(`execution observability golden fixture: ${fixture.name}`, () => {
    const projection = projectExecutionObservability(
      fixture.sessionId,
      fixture.events,
      fixture.verificationRecords,
    );
    assert.deepEqual(snapshot(projection), fixture.expected);
  });
}

test('fingerprint does not infer missing versions from persisted free text', () => {
  const fixture = GOLDEN_EXECUTION_OBSERVABILITY_FIXTURES[1]!;
  const projection = projectExecutionObservability(fixture.sessionId, fixture.events, []);

  assert.equal(projection.fingerprint.status, 'unknown');
  assert.equal(projection.fingerprint.hash, null);
});

function snapshot(projection: ExecutionObservabilityProjection) {
  return {
    fingerprint: {
      status: projection.fingerprint.status,
      hash: projection.fingerprint.hash,
      components: {
        prompt: projection.fingerprint.components.prompt.status,
        spec: projection.fingerprint.components.spec.status,
        memory: projection.fingerprint.components.memory.status,
        toolCatalog: projection.fingerprint.components.toolCatalog.status,
      },
    },
    waterfall: projection.waterfall.map(turn => ({
      turn: turn.turn,
      modelWaitMs: turn.modelWait.durationMs,
      toolWaitMs: turn.toolWait.durationMs,
      retries: turn.retries.count,
      errors: turn.errors.count,
      denied: turn.denied.count,
      totalTokens: turn.tokens.totalTokens,
      eventIds: [...new Set([
        ...turn.modelWait.eventIds,
        ...turn.toolWait.eventIds,
        ...turn.retries.eventIds,
        ...turn.errors.eventIds,
        ...turn.denied.eventIds,
        ...turn.tokens.eventIds,
      ])],
    })),
    failureFacets: projection.failureFacets.map(facet => ({
      category: facet.category,
      code: facet.code,
      eventIds: facet.eventIds,
      verificationRecordIds: facet.verificationRecordIds,
    })),
  };
}
