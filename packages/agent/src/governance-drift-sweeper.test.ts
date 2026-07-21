import test from 'node:test';
import assert from 'node:assert/strict';

import {
  detectGovernanceDrift,
  sweepGovernanceDrift,
  type DriftFinding,
} from './governance-drift-sweeper.js';
import {
  createGovernanceJob,
  deleteGovernanceJob,
  updateGovernanceJob,
} from './governance-jobs-crud.js';
import type { GovernanceJobType } from './governance-jobs-types.js';

interface DriftScenario {
  jobType: GovernanceJobType;
  previous: Record<string, unknown>;
  current: Record<string, unknown>;
  expectedMetrics: string[];
}

async function detectAgainstBaseline(scenario: DriftScenario): Promise<DriftFinding[]> {
  const scope = `drift-direct-${scenario.jobType}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const baseline = await createGovernanceJob({
    jobType: scenario.jobType,
    cadence: 'hourly',
    tenantId: scope,
    projectId: scope,
    dedupeKey: `${scope}-baseline`,
  });

  try {
    await updateGovernanceJob(baseline.id, {
      lastRunAt: new Date(Date.now() - 60_000).toISOString(),
      resultSummary: scenario.previous,
    });
    const report = await detectGovernanceDrift({
      id: `${scope}-current`,
      jobType: scenario.jobType,
      tenantId: scope,
      projectId: scope,
      resultSummary: scenario.current,
    });
    assert.ok(report);
    assert.equal(report.baselineJobId, baseline.id);
    assert.equal(report.hasDrift, scenario.expectedMetrics.length > 0);
    assert.equal(report.hasNewRules, false);
    assert.deepEqual(report.findings.map(finding => finding.metric), scenario.expectedMetrics);
    return report.findings;
  } finally {
    await deleteGovernanceJob(baseline.id);
  }
}

test('detectGovernanceDrift returns null without comparable governed metrics', async () => {
  assert.equal(await detectGovernanceDrift({
    id: 'empty', jobType: 'hotspot', resultSummary: {},
  }), null);
  assert.equal(await detectGovernanceDrift({
    id: 'no-rules', jobType: 'reflection', resultSummary: { findings: 2 },
  }), null);
  assert.equal(await detectGovernanceDrift({
    id: 'no-baseline',
    jobType: 'memory_integrity',
    tenantId: `missing-${Date.now()}`,
    resultSummary: { integrityIssues: 1 },
  }), null);
});

test('detectGovernanceDrift maps thresholds and direction for every governed job family', async (t) => {
  const scenarios: DriftScenario[] = [
    {
      jobType: 'consistency_audit',
      previous: {
        todoReconciliation: { seedOnly: 2, dbOnly: 100, statusDrift: 4 },
        statusConstraints: { unvalidated: 4, invalidRows: 1 },
      },
      current: {
        todoReconciliation: { seedOnly: 2, dbOnly: 105, statusDrift: 3 },
        statusConstraints: { unvalidated: 3, invalidRows: 9 },
      },
      expectedMetrics: [],
    },
    {
      jobType: 'hotspot',
      previous: {
        runtimeCleanup: { illegalStatusCount: 10, staleFixtureCount: 5 },
        errorFrequency: { recentErrors24h: 10 },
      },
      current: {
        runtimeCleanup: { illegalStatusCount: 11, staleFixtureCount: 6 },
        errorFrequency: { recentErrors24h: 16 },
      },
      expectedMetrics: ['illegalStatusCount', 'staleFixtureCount', 'recentErrors24h'],
    },
    {
      jobType: 'architecture_drift',
      previous: { nodeCount: 100, edgeCount: 100, hasStructuralChanges: false },
      current: { nodeCount: 80, edgeCount: 110, hasStructuralChanges: true },
      expectedMetrics: ['hasStructuralChanges', 'nodeCount'],
    },
    {
      jobType: 'memory_integrity',
      previous: { integrityIssues: 0 },
      current: { integrityIssues: 1 },
      expectedMetrics: ['integrityIssues'],
    },
    {
      jobType: 'memory_retention',
      previous: { retentionIssues: 5 },
      current: { retentionIssues: 6 },
      expectedMetrics: ['retentionIssues'],
    },
    {
      jobType: 'file_size',
      previous: { filesOver600Count: 0, filesOver400: 100 },
      current: { filesOver600: 1, filesOver400Count: 109 },
      expectedMetrics: ['filesOver600'],
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.jobType, async () => {
      const findings = await detectAgainstBaseline(scenario);
      for (const finding of findings) {
        assert.equal(finding.direction, finding.currentValue > finding.previousValue ? 'increase' : 'decrease');
        assert.ok(['low', 'medium', 'high'].includes(finding.severity));
      }
    });
  }
});

test('sweepGovernanceDrift treats an explicit empty current set as no work', async () => {
  assert.deepEqual(await sweepGovernanceDrift({ jobIds: [] }), {
    jobsChecked: 0,
    jobsWithDrift: 0,
    totalFindings: 0,
    findings: {},
  });
});
