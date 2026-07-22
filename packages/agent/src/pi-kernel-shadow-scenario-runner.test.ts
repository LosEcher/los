import assert from 'node:assert/strict';
import test from 'node:test';
import { _collectOutstandingPiKernelShadowLiveEvidence } from './pi-kernel-shadow-scenario-runner.js';
import type { PiKernelShadowScenarioReport } from './pi-kernel-shadow-scenarios.js';

const identity = { kind: 'pi' as const, version: '0.81.1+los.3', protocolVersion: '0.1.0' };

test('live runner refuses a corpus with an existing live failure before collection', async () => {
  let collections = 0;
  await assert.rejects(
    _collectOutstandingPiKernelShadowLiveEvidence({
      report: report(1), identity, provider: 'fixture', model: 'fixture', workspaceRoot: '/unused',
    }, {
      collect: async () => { collections += 1; return []; },
    }),
    /already has failing live-provider evidence/,
  );
  assert.equal(collections, 0);
});

test('live runner re-reads persisted evidence and stops after the first failing requirement', async () => {
  let calls = 0;
  let reads = 0;
  const collected = await _collectOutstandingPiKernelShadowLiveEvidence({
    report: report(0), identity, provider: 'fixture', model: 'fixture', workspaceRoot: '/unused',
  }, {
    collect: async (_input, dependencies) => {
      const observations = [];
      for (let index = 0; index < 3; index++) {
        calls += 1;
        const observation = {
          scenarioId: 'PKS01-no-tool' as const,
          taskRunId: `task-${index}`,
          sessionId: `session-${index}`,
          status: 'completed' as const,
        };
        observations.push(observation);
        if (await dependencies?.afterObservation?.(observation) === 'stop') break;
      }
      return observations;
    },
    readReport: async () => {
      reads += 1;
      return report(1);
    },
  });
  assert.equal(calls, 1);
  assert.equal(reads, 2);
  assert.equal(collected.observations.length, 1);
  assert.equal(collected.report.requirements[0]?.failing, 1);
});

function report(failing: number): PiKernelShadowScenarioReport {
  return {
    corpusVersion: '1.1.2', rubricRevision: 'pi-shadow-readonly-v4', candidate: identity,
    status: 'collecting', observedCount: failing, ignoredCount: 0,
    requirements: [{
      scenarioId: 'PKS01-no-tool', evidenceClass: 'live-provider', required: 3,
      observed: failing, passing: 0, failing,
    }],
    automaticAdmission: { status: 'disabled', reason: 'test fixture' },
  };
}
