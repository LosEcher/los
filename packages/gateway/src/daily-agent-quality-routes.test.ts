import assert from 'node:assert/strict';
import test from 'node:test';

import Fastify from 'fastify';
import { loadConfig } from '@los/infra/config';
import type {
  DailyAgentQualityBaseline,
  DailyAgentQualitySnapshot,
} from '@los/agent/daily-agent-quality';

import { registerRequestContext } from './request-context.js';
import { registerDailyAgentQualityRoutes } from './routes/data/daily-agent-quality-routes.js';

test('daily agent quality routes forward request scope and report a collecting baseline', async () => {
  const app = Fastify({ logger: false });
  registerRequestContext(app, await loadConfig());
  const projectId = `quality-route-${Date.now()}`;
  const snapshot = createSnapshot(projectId);
  const evidenceWindow = createEvidenceWindow();
  const captureInputs: Array<{ tenantId?: string; projectId: string }> = [];
  const baselineInputs: Array<{ tenantId?: string; projectId: string; requiredDays?: number }> = [];
  registerDailyAgentQualityRoutes(app, {
    captureDailyAgentQuality: async (input) => {
      captureInputs.push(input);
      return { snapshot, evidenceWindow };
    },
    getDailyAgentQualityBaseline: async (input) => {
      baselineInputs.push(input);
      return { snapshots: [snapshot], evidenceWindow };
    },
  });
  const headers = {
    'x-tenant-id': 'local',
    'x-project-id': projectId,
    'x-user-id': 'quality-test',
  };
  try {
    const first = await app.inject({
      method: 'POST', url: '/daily-agent-quality/capture', headers,
    });
    assert.equal(first.statusCode, 201);
    assert.equal(first.json().snapshot.projectId, projectId);
    assert.equal(first.json().evidenceWindow.status, 'collecting');

    const baseline = await app.inject({
      method: 'GET', url: '/daily-agent-quality/baseline?days=28', headers,
    });
    assert.equal(baseline.statusCode, 200);
    assert.equal(baseline.json().snapshots.length, 1);
    assert.equal(baseline.json().evidenceWindow.observedDays, 1);
    assert.equal(baseline.json().evidenceWindow.requiredDays, 28);
    assert.deepEqual(captureInputs, [{ tenantId: 'local', projectId }]);
    assert.deepEqual(baselineInputs, [{ tenantId: 'local', projectId, requiredDays: 28 }]);
  } finally {
    await app.close();
  }
});

function createSnapshot(projectId: string): DailyAgentQualitySnapshot {
  return {
    id: `snapshot-${projectId}`,
    tenantId: 'local',
    projectId,
    snapshotDate: '2026-07-25',
    capturedAt: '2026-07-25T12:00:00.000Z',
    windowStart: '2026-07-24T12:00:00.000Z',
    windowEnd: '2026-07-25T12:00:00.000Z',
    inbox: {
      actionableCount: 0, approvalRequired: 0, recoveryRequired: 0,
      verificationBlocked: 0, reviewReady: 0, running: 0, unknown: 0,
      over24h: 0, over72h: 0,
    },
    schedule: {
      runCount: 0, succeeded: 0, noOp: 0, failed: 0, skipped: 0,
      awaitingApproval: 0, other: 0, noOpRate: 0, failureRate: 0,
    },
    recovery: {
      requiredItems: 0, recoveryEvents: 0, retryAttempts: 0,
      recoveredSuccesses: 0, recoverySuccessRate: 0,
    },
    verification: {
      workItems: 0, required: 0, succeeded: 0, skipped: 0,
      failed: 0, pending: 0, missing: 0, coverage: 1,
    },
    providerQuality: {
      evalCount: 0, successCount: 0, failureCount: 0, successRate: 0,
      averageRetryCount: 0, toolErrorCount: 0, modelCost: 0,
    },
    createdAt: '2026-07-25T12:00:00.000Z',
    updatedAt: '2026-07-25T12:00:00.000Z',
  };
}

function createEvidenceWindow(): DailyAgentQualityBaseline['evidenceWindow'] {
  return {
    status: 'collecting',
    observedDays: 1,
    requiredDays: 28,
    expectedFrom: '2026-06-28',
    expectedTo: '2026-07-25',
    oldestEvidenceDate: '2026-07-25',
    newestEvidenceDate: '2026-07-25',
    missingDates: [],
  };
}
