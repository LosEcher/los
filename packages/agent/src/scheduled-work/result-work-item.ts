/**
 * result-work-item — scheduled 运行的「结果待办」投影策略。
 *
 * 背景（2026-10-09 治理盘点）：`createScheduleWorkItem` 过去对**每次成功运行**都
 * 落一条 `status='backlog'` 的 P2 todo，dedupeKey 是 `schedule-run-result:<runId>:succeeded`
 * ——每次运行的 runId 都不同 ⇒ 完全不去重。两个自检任务（15m + 30m）一天就产生 ~144 条，
 * 累积到 4873 条 backlog（110 个标题），把真正需要人处理的待办挤出视野
 * （`todos` 收件箱失去判别力，AP12 的僵尸行问题在 todo 侧的翻版）。
 *
 * 策略：**待办收件箱只放可执行项**。
 *   - `failed`（含 circuit 打开 / recovery required）→ 留在 backlog，且按 revision 去重；
 *   - `awaiting_approval` → 留（等 operator 审批）；
 *   - `succeeded` → 结果本身已经落在 `scheduled_work_item_runs.result_summary_json`
 *     台账里，todo 只是重复投影 ⇒ 建后**立即归档**（`archive_reason='schedule-run-result'`），
 *     保留可查性与 run.workItemId 链接，但不占待办。
 *
 * 为什么不直接不建：`attachScheduledRunWorkItem` 会把 run 关联到这条 work item，
 * 归档比删除更能保住"这次运行对应哪条结果"的可追溯性（T1/T4 不变量）。
 */

import { archiveTodo, createTodo } from '../todos.js';
import type { ScheduledWorkItem, ScheduledWorkItemRun } from './types.js';

export type ScheduleResultStatus = 'awaiting_approval' | 'succeeded' | 'failed';
type Disposition = 'keep' | 'archive';

/** 非可执行的结果通知在待办里的处置（建后即归档，而不是丢弃）。 */
function dispositionFor(status: ScheduleResultStatus): Disposition {
  return status === 'succeeded' ? 'archive' : 'keep';
}

export type CreateScheduleResultWorkItemDeps = {
  createTodo: typeof createTodo;
  archiveTodo: typeof archiveTodo;
};

const defaultDeps: CreateScheduleResultWorkItemDeps = { createTodo, archiveTodo };

/**
 * 把一次 scheduled 运行的结果投影成一条 work item（todo），并按策略决定是否
 * 立即归档。返回值是 work item id（调用方用 `attachScheduledRunWorkItem` 关联 run）。
 */
export async function createScheduleResultWorkItem(
  schedule: ScheduledWorkItem,
  run: ScheduledWorkItemRun,
  scheduledStatus: ScheduleResultStatus,
  summary: Record<string, unknown>,
  title = schedule.title,
  deps: CreateScheduleResultWorkItemDeps = defaultDeps,
): Promise<string> {
  const todo = await deps.createTodo({
    tenantId: schedule.tenantId, projectId: schedule.projectId, userId: schedule.userId,
    title, description: schedule.runTemplate.goalTemplate, kind: 'task', status: 'backlog', priority: 'P2',
    source: 'scheduled-work',
    dedupeKey: scheduledStatus === 'failed'
      ? `schedule-circuit:${schedule.id}:revision:${schedule.revision}`
      : `schedule-run-result:${run.id}:${scheduledStatus}`,
    runContract: {
      mode: schedule.runTemplate.mode,
      phase: scheduledStatus === 'awaiting_approval' ? 'planning' : scheduledStatus === 'failed' ? 'blocked' : 'succeeded',
      goal: schedule.runTemplate.goalTemplate, editableSurfaces: [],
      requiredChecks: schedule.runTemplate.requiredChecks, stopConditions: ['operator cancels schedule'],
      evidenceRequired: ['scheduled work run record'], toolMode: 'read-only',
      externalEvidenceAllowed: [], rawEvidenceProhibited: [],
    },
    metadata: {
      createdFrom: 'scheduled-work-runner',
      scheduledWork: { scheduleId: schedule.id, runId: run.id, status: scheduledStatus, summary },
    },
  });
  if (dispositionFor(scheduledStatus) === 'archive') {
    // 归档失败不得吞掉整次运行（结果已落 run 台账，todo 只是投影）。
    await deps.archiveTodo(todo.id, 'schedule-run-result').catch(() => undefined);
  }
  return todo.id;
}
