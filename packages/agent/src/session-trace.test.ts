import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildGoldenSessionTraceRecords,
  GOLDEN_SESSION_TRACE_PROJECTION,
  GOLDEN_SESSION_TRACE_SESSION_ID,
} from './session-trace-fixtures.js';
import { projectSessionTrace, validateTraceCompleteness } from './session-trace.js';

test('golden session trace fixture projects raw events into stable trace turns', () => {
  const events = buildGoldenSessionTraceRecords();
  const projection = projectSessionTrace(GOLDEN_SESSION_TRACE_SESSION_ID, events);

  assert.equal(events.find(event => event.type === 'session.started')?.payload.routeReason, 'explicit_fallback_policy');
  assert.equal(events.find(event => event.type === 'provider.fallback.selected')?.payload.compatibilityEvidenceId, 'compat-golden-xai');
  assert.deepEqual(projection, GOLDEN_SESSION_TRACE_PROJECTION);
  assert.deepEqual(validateTraceCompleteness(events, projection), {
    orphans: [],
    stalledRunning: [],
  });
});
