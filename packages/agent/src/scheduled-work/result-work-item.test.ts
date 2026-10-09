import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createScheduleResultWorkItem,
  type CreateScheduleResultWorkItemDeps,
} from './result-work-item.js';
import type { CreateTodoInput } from '../todos.js';
import type { ScheduledWorkItem, ScheduledWorkItemRun } from './types.js';

const schedule: ScheduledWorkItem = {
  id: 'schedule-test-1',
  tenantId: 'local',
  projectId: 'los',
  title: 'dogfood runtime readiness check',
  status: 'enabled',
  trigger: { kind: 'interval', timezone: 'Asia/Shanghai', expression: '15m' },
  runTemplate: {
    templateId: 'runtime_readiness',
    mode: 'governance',
    goalTemplate: 'check runtime readiness',
    editableSurfaces: [],
    requiredChecks: ['nodes listed'],
    toolMode: 'read-only',
  },
  approvalPolicy: 'read_only_auto',
  approvalTimeoutMs: 1_800_000,
  approvalTimeoutAction: 'deny',
  concurrencyPolicy: 'skip',
  catchUpPolicy: 'skip',
  maxConcurrentRuns: 1,
  maxLatenessMs: 3_600_000,
  maxAttempts: 2,
  retryBackoffMs: 60_000,
  failureThreshold: 3,
  nextRunAt: '2026-10-10T00:00:00.000Z',
  circuitState: 'closed',
  consecutiveFailures: 0,
  consecutiveNoOps: 0,
  revision: 7,
  metadata: {},
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
};

const run: ScheduledWorkItemRun = {
  id: 'schedule-run-test-1',
  scheduleId: schedule.id,
  scheduledFor: '2026-10-09T00:00:00.000Z',
  triggerKind: 'scheduled',
  status: 'succeeded',
  attemptCount: 1,
  maxAttempts: 2,
  createdAt: '2026-10-09T00:00:00.000Z',
  updatedAt: '2026-10-09T00:00:00.000Z',
};

function deps(): { calls: { created: CreateTodoInput[]; archived: [string, string | undefined][] };
  deps: CreateScheduleResultWorkItemDeps } {
  const calls = { created: [] as CreateTodoInput[], archived: [] as [string, string | undefined][] };
  return {
    calls,
    deps: {
      createTodo: (async (input: CreateTodoInput) => {
        calls.created.push(input);
        return { id: `todo-${calls.created.length}` } as never;
      }) as unknown as CreateScheduleResultWorkItemDeps['createTodo'],
      archiveTodo: (async (id: string, reason?: string) => {
        calls.archived.push([id, reason]);
        return null;
      }) as unknown as CreateScheduleResultWorkItemDeps['archiveTodo'],
    },
  };
}

test('成功运行的结果 todo 建后立即归档（否则 15m/30m 自检任务会把收件箱刷满）', async () => {
  const { calls, deps: d } = deps();
  const id = await createScheduleResultWorkItem(schedule, run, 'succeeded', { nodes: 36 }, undefined, d);
  assert.equal(id, 'todo-1');
  assert.equal(calls.created.length, 1);
  assert.deepEqual(calls.archived, [['todo-1', 'schedule-run-result']]);
  // 归档原因必须可查（历史行判据：archive_reason 非空）
  assert.equal(calls.created[0]!.source, 'scheduled-work');
  assert.equal(calls.created[0]!.status, 'backlog');
});

test('失败结果留在待办收件箱，且按 schedule revision 去重（不按 runId）', async () => {
  const { calls, deps: d } = deps();
  await createScheduleResultWorkItem(schedule, run, 'failed', { error: 'boom' }, 'task: recovery required', d);
  assert.deepEqual(calls.archived, []);
  assert.equal(calls.created[0]!.dedupeKey, `schedule-circuit:${schedule.id}:revision:${schedule.revision}`);
  assert.equal(calls.created[0]!.title, 'task: recovery required');
});

test('待审批结果留在收件箱（等 operator 处置），dedupeKey 含 runId', async () => {
  const { calls, deps: d } = deps();
  await createScheduleResultWorkItem(schedule, run, 'awaiting_approval', {}, undefined, d);
  assert.deepEqual(calls.archived, []);
  assert.equal(calls.created[0]!.dedupeKey, `schedule-run-result:${run.id}:awaiting_approval`);
});

test('归档失败不抛出（结果已落 run 台账，todo 只是投影）', async () => {
  const { deps: d } = deps();
  const failing: CreateScheduleResultWorkItemDeps = {
    createTodo: d.createTodo,
    archiveTodo: (async () => { throw new Error('db down'); }) as unknown as CreateScheduleResultWorkItemDeps['archiveTodo'],
  };
  const id = await createScheduleResultWorkItem(schedule, run, 'succeeded', {}, undefined, failing);
  assert.equal(id, 'todo-1');
});
