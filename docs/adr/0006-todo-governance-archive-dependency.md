# ADR 0006: Todo Governance, Archive, And Dependency Model

## Status

Proposed.

## Background

ADR 0005 已经把 `todos` 放在 agent 调度之前，作为租户/项目级计划账本。本轮继续检查的是 todo 管理本身：历史项目里出现过 todo 未及时更新、todo 与实现漂移、完成项长期堆在当前列表、阶段任务拆分后依赖关系不可见等问题。

当前 `los` 已有：

1. `packages/agent/src/todos.ts`：PostgreSQL `todos` 表、tenant/project/user/node 字段、trace/request/dedupe/task/session 关联字段。
2. `packages/gateway/src/todo-routes.ts`：`GET/POST/PATCH /todos`、reopen、cancel、seed。
3. `packages/web/src/todo-page.tsx`：Web `Todos` 页面、筛选、详情和状态动作。
4. `docs/adr/0005-saas-todo-agent-dispatch.md`：SaaS todo 与 agent dispatch 的基础语义。

当前缺口：

1. 已完成 todo 仍与活跃 todo 混在同一查询面，完成项越多，调度候选越不可信。
2. `parentId` 可以表达拆分树，但不能表达跨阶段、跨分支的前置依赖。
3. `done` 只是人工状态，缺少与 `task_runs/session_events/requestId/traceId` 的定期核对。
4. todo 还不能作为 scheduler 的派发入口，当前只能人工维护状态。
5. SSE/WS 断线续传、指数退避和周期治理任务尚未显式拆成 todo。
6. 一致性分析、性能优化、数据结构/存储/架构优化、实现漂移、工具层漂移和热点文件治理需要区分“计划目录”和“执行尝试”。

## Historical Issues To Avoid

1. `TODO.md` 成为单一文字真源时，已完成项长期留在主列表，会让“当前应该做什么”失真。`vpsagentweb` 通过根 `TODO.md`、`README.md`、`docs/README.md` 分层和历史快照归档缓解了这个问题。
2. `lsclaw` 的 context snapshot 里同时存在 pending todo 和 done todo，如果没有运行事件和 read model 核验，UI 只能显示计划状态，不能证明执行状态。
3. agent 执行失败后重开、取消、分批重试如果不保留 trace/task/session 关系，会把“新的执行尝试”和“旧计划项”混在一起。
4. 多租户 SaaS 场景下，todo 不能只按全局 id 查；所有查询、幂等和归档都必须保留 `tenantId/projectId` 维度。

## Decision

Todo 管理拆成四个面：

1. **Active work set**：默认查询只返回 `archived_at IS NULL` 的 todo。Web 列表默认显示活跃工作集。
2. **Archive ledger**：完成、取消、过期或被替代的 todo 写入 `archived_at/archive_reason`，不删除 tenant/project/trace/request/task/session 证据。
3. **Split tree**：同一阶段内的拆分继续使用 `parentId`，子项保留 `stageId`、`batchKey` 和 `source`。
4. **Dependency graph**：跨阶段或跨分支前置关系用 `todo_dependencies(todo_id, depends_on_todo_id, relation_type)` 表示。

## Placement Decision

这些治理场景不直接放进 `task_runs` 主模型。

1. `todos` 负责记录治理目录、租户/项目范围、依赖、归档和下一步派发条件。
2. `task_runs` 只记录一次已经进入 scheduler 的执行尝试，例如某次一致性扫描、某次热点文件分析、某次工具漂移核验。
3. SSE/WS、heartbeat、replay、指数退避属于 gateway transport 和 scheduler recovery 的运行能力，不属于 todo 存储层。
4. 周期性治理如果只是一次性任务，先作为 todo + task_run 管理；如果需要保存 cadence、lease、last_run、next_run、SLO 和结果摘要，再新增 `governance_jobs` 或 `sweeps` 模块。
5. 热点文件治理、工具层漂移、实现漂移共享同一治理执行框架，但输出可以拆成不同 todo metadata category。

## Data Model

新增字段：

1. `todos.archived_at`：归档时间。为空表示仍在活跃工作集。
2. `todos.archive_reason`：归档原因，例如 `archived_from_todos_page`、`replaced_by_split`、`stale_after_verification`。

新增关系表：

```sql
todo_dependencies(
  todo_id,
  depends_on_todo_id,
  relation_type,
  created_at
)
```

当前只使用 `relation_type = 'blocks'`。后续如果要表达弱依赖、参考关系、重复项合并，可以扩展 relation type，但调度入口只应把 `blocks` 当作硬前置条件。

## Operating Rules

1. `done/cancelled` 不自动等于历史归档；归档是单独动作，因为部分完成项需要短期留在活跃视图供验收。
2. `reopen` 必须清空 `archived_at/archive_reason`，并保留原 trace、dedupe、metadata。
3. `archive` 不能删除依赖边。归档项仍可作为历史证据被其他 todo 引用，但 dispatch 入口不得把 archived todo 当作候选任务。
4. 拆分任务时：
   - 原 todo 可改为 `kind = phase/plan` 或归档为 `replaced_by_split`。
   - 子 todo 使用 `parentId` 指向原 todo。
   - 跨分支前置条件写入 `dependsOnIds`。
   - 同批执行项使用同一 `batchKey`。
5. 任务派发前必须检查：
   - `tenantId/projectId` 匹配当前请求上下文。
   - `archivedAt` 为空。
   - `kind` 是 `task` 或 `batch`。
   - `status` 是 `ready`。
   - `dependsOnIds` 指向的硬依赖均为 `done` 或已明确豁免。
   - `requestId/traceId/dedupeKey` 已生成或传入。

## Drift Control

Todo 状态不能只靠人工按钮维护。需要一个后续 sweeper 或 read-model 校验流程：

1. 对 `ready/in_progress/done` todo 定期读取 `taskRunId/sessionId/traceId/requestId`。
2. 如果 `done` 没有关联验收证据，标为 `blocked` 或写入 metadata `verificationMissing=true`。
3. 如果 `in_progress` 没有 active task 或最近事件超过 lease，标为 `blocked` 并写入恢复建议。
4. 如果实现已完成但 todo 仍是 `ready/backlog`，写入 `staleTodo=true`，等待人工确认后归档或置为 done。
5. 如果同一 `tenantId/projectId/dedupeKey` 出现重复 todo，保留最新活跃项，其他项归档为 `duplicate`.

## Task Split

当前 seed 已写入以下治理任务：

1. `todo-los-governance-archive-policy`：定义归档与活跃工作集策略。
2. `todo-los-governance-dependency-graph`：把拆分关系建成可追踪依赖图。
3. `todo-los-governance-drift-sweeper`：定期核对 todo 与真实实现的漂移。
4. `todo-los-governance-saas-todo-bridge`：补租户/项目级 todo 派发接口。
5. `todo-los-transport-sse-ws-recovery`：补 SSE/WS 接入、续传和指数退避策略。
6. `todo-los-governance-module-boundary`：定义周期治理任务的模块边界。
7. `todo-los-governance-periodic-sweeper`：实现周期性治理 sweeper 和租户级调度策略。
8. `todo-los-governance-hotspot-and-tool-drift`：治理热点文件、实现漂移和工具层漂移。

与 ADR 0005 的 SaaS 基础任务依赖关系：

1. `dependency-graph` 依赖 `archive-policy`。
2. `drift-sweeper` 依赖 `archive-policy` 和 `dependency-graph`。
3. `saas-todo-bridge` 依赖 `dependency-graph` 和 `request-id-ledger`。
4. `task-lease-recovery` 依赖 `node-registry` 和 `request-id-ledger`。
5. `transport-sse-ws-recovery` 依赖 `request-id-ledger` 和 `task-lease-recovery`。
6. `governance-periodic-sweeper` 依赖 `governance-module-boundary` 和 `request-id-ledger`。
7. `hotspot-tool-drift` 依赖 `governance-periodic-sweeper`。

## Current Implementation

本 ADR 对应的代码基础：

1. `todos` 表新增 `archived_at/archive_reason`。
2. 新增 `todo_dependencies` 关系表。
3. `TodoRecord` 返回 `dependsOnIds`、`blockedByIds`、`archivedAt`、`archiveReason`。
4. `GET /todos` 默认隐藏归档项，`includeArchived=true` 可显示归档项。
5. 新增 `POST /todos/:id/archive`、`POST /todos/:id/unarchive`。
6. `POST /todos/:id/reopen` 会解除归档并置为 `ready`。
7. Web `Todos` 页面增加归档筛选、依赖录入和 archive/unarchive/reopen 操作。

## Remaining Work

1. 给 `todo_dependencies` 补 FK 或应用级存在性校验，避免依赖不存在的 todo id。
2. 实现 `POST /todos/:id/dispatch`，把 ready todo 转为 scheduler task。
3. 给 dispatch 增加依赖检查和租户/project 权限边界。
4. 增加 drift sweeper：从 `task_runs/session_events` 反查 todo 状态。
5. 增加归档策略任务：例如 done/cancelled 保留 7-30 天后自动归档，P0/P1 默认需要人工确认。
6. 将 todo API 加入 contract source，而不是只在 gateway route 中隐式维护。
7. 增加 transport recovery：SSE Last-Event-ID/since、WS reconnect、heartbeat、指数退避和 jitter。
8. 增加 governance job policy：周期、租户范围、lease、dedupe、结果摘要、失败降级和热点文件阈值。

## Verification

需要验证：

1. `pnpm --filter @los/agent check`
2. `pnpm --filter @los/gateway check`
3. `pnpm --filter @los/web check`
4. `pnpm check`
5. `./tools/check-contracts.sh`
6. `curl -fsS 'http://127.0.0.1:8080/todos?includeArchived=true'`
