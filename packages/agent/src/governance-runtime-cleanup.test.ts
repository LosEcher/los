import test from 'node:test';
import assert from 'node:assert/strict';

import { detectRuntimeCleanup } from './governance-runtime-cleanup.js';

test('detectRuntimeCleanup reports illegal task statuses and stale fixture tasks only', () => {
  const report = detectRuntimeCleanup({
    now: '2026-06-13T12:00:00.000Z',
    staleMs: 60 * 60 * 1000,
    taskRuns: [
      {
        id: 'task-illegal',
        sessionId: 'session-a',
        status: 'deepseek-reasoner',
        createdAt: '2026-06-13T10:00:00.000Z',
        updatedAt: '2026-06-13T10:00:00.000Z',
      },
      {
        id: 'task-smoke-1',
        sessionId: 'session-a',
        status: 'queued',
        promptPreview: 'smoke probe',
        createdAt: '2026-06-13T09:00:00.000Z',
        updatedAt: '2026-06-13T09:00:00.000Z',
      },
      {
        id: 'task-real-1',
        sessionId: 'session-real',
        status: 'running',
        promptPreview: '分析当前项目治理方案',
        createdAt: '2026-06-13T09:00:00.000Z',
        updatedAt: '2026-06-13T09:00:00.000Z',
      },
    ],
    runSpecs: [],
  });

  assert.deepEqual(report.taskRuns.illegalStatus.map(item => item.record.id), ['task-illegal']);
  assert.deepEqual(report.taskRuns.staleFixtureCandidates.map(item => item.record.id), ['task-smoke-1']);
});

test('detectRuntimeCleanup reports stale fixture run specs but leaves real sessions alone', () => {
  const report = detectRuntimeCleanup({
    now: '2026-06-13T12:00:00.000Z',
    staleMs: 60 * 60 * 1000,
    taskRuns: [],
    runSpecs: [
      {
        id: 'run-verifier-failure-1',
        sessionId: 'session-a',
        status: 'created',
        prompt: 'verifier failure fixture',
        createdAt: '2026-06-13T09:00:00.000Z',
        updatedAt: '2026-06-13T09:00:00.000Z',
      },
      {
        id: 'run-real-1',
        sessionId: 'session-real',
        status: 'running',
        prompt: '分析当前项目治理方案',
        createdAt: '2026-06-13T09:00:00.000Z',
        updatedAt: '2026-06-13T09:00:00.000Z',
      },
    ],
  });

  assert.deepEqual(report.runSpecs.staleFixtureCandidates.map(item => item.record.id), ['run-verifier-failure-1']);
});
