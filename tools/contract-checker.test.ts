import test from 'node:test';
import assert from 'node:assert/strict';
import { checkEventCoverage, checkGeneratedContent, checkRouteCoverage } from './check-contracts.js';

test('route coverage fails when a declared Fastify route is removed', () => {
  const contract = {
    routes: [
      { method: 'GET', path: '/runs/{runSpecId}/events' },
      { method: 'GET', path: '/runs/{runSpecId}/stream' },
    ],
  };
  const issues = checkRouteCoverage('run-stream.yaml', contract, new Set([
    'GET /runs/{param}/events',
  ]));
  assert.deepEqual(issues.map(issue => issue.message), [
    'declared route has no Fastify registration: GET /runs/{param}/stream',
  ]);
});

test('event coverage ignores wildcard relays and requires literal emitters', () => {
  const contract = {
    eventTypes: ['model.delta'],
    sseProtocol: ['session.ready'],
  };
  const issues = checkEventCoverage(contract, new Set(['model.delta']));
  assert.deepEqual(issues.map(issue => issue.message), [
    'SSE protocol event has no literal emitter: session.ready',
  ]);
});

test('generated output drift fails the contract gate', () => {
  assert.deepEqual(checkGeneratedContent('generated/run-spec.ts', 'expected', 'stale'), [{
    surface: 'generated/run-spec.ts',
    message: 'generated file is stale; run pnpm contracts:generate',
  }]);
  assert.deepEqual(checkGeneratedContent('generated/run-spec.ts', 'expected', 'expected'), []);
});
