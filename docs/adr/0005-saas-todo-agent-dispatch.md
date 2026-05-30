# ADR 0005: SaaS Todo Layer For Agent Dispatch

## Status

Proposed.

## Background

`los` 当前已经有单节点 mesh 方向、PostgreSQL 持久化、`task_runs`、`session_events`、工具能力策略、取消、超时和工具级幂等重试。

本轮检查确认：

1. 单节点仍按 mesh/cloud 的持久化路径走，避免 SQLite local mode 和 PostgreSQL cloud mode 两套真相。
2. `task_runs` 已有 `traceId`、`dedupeKey`、`attempt`、状态流转和取消。
3. `session_events` 已能记录模型、工具、任务状态事件。
4. SaaS 所需的 `tenant_id`、`project_id`、`user_id`、`node_id`、`request_id` 仍没有成为核心表的一等字段。
5. 当前 dedupe 只处理 active task，不等价于 HTTP 请求幂等和防重放。
6. Executor node 仍停留在配置/README/Reserved UI 阶段，没有 node registry、heartbeat、lease 和弱网恢复。

Todo 归档、拆分依赖和漂移治理的细化规则见 ADR 0006。

历史项目的主要教训：

1. `lsclaw` 的 UI、ledger、runtime、provider billing 不能混为一个 truth surface；agent 执行必须能从事件和持久化记录复原。
2. `vpsagentweb` 的 mesh 不能只看配置字段，必须证明节点可见、心跳正常、策略允许、当前 profile/route 生效。
3. 弱网和重试必须以状态和幂等为边界，不能用“再执行一次”解决所有失败。

## Decision

新增 `todos` 作为 agent 调度的上游计划层。

Todo 不替代 `task_runs`：

1. `todo` 表示待处理的问题、方案、阶段、批次或可派发任务。
2. `task_run` 表示一次已经进入 scheduler 的执行尝试。
3. `session` 表示一次 agent 会话及其消息/事件。
4. `session_events` 表示可追溯的运行证据。

设计目标是先支持 `local/los` 单租户默认值，同时字段和 API 形状按 SaaS 预留：

1. `tenantId`：租户隔离边界。
2. `projectId`：项目/空间边界，类似 Linear team/project、GitHub repo/project、Teambition project。
3. `userId`：发起人、负责人或审核人。
4. `nodeId`：未来 executor node 或 mesh worker 归属。
5. `traceId`：跨 todo/task/session 的链路标识。
6. `requestId`：单个 HTTP/API 请求标识。
7. `dedupeKey`：业务级去重键，后续应与 idempotency key 表分开。
8. `stageId`、`parentId`、`batchKey`：阶段、子任务、分批执行的组织字段。

## Concepts

### Stage

Stage 是一组 todo 的计划阶段，不直接执行。

示例：

1. `saas-foundation`
2. `mesh-nodes`
3. `scheduler-recovery`
4. `quality`

Stage 可由 `kind = phase` 的 todo 表示，也可后续升级为独立 `stages` 表。

### Todo

Todo 是计划和执行之间的调度候选项。

当前 kind：

1. `problem`：已发现问题。
2. `solution`：解决方案或设计决策。
3. `plan`：规划集合。
4. `phase`：阶段。
5. `task`：可派发执行项。
6. `batch`：分批执行集合。

当前 status：

1. `backlog`：记录但未准备执行。
2. `ready`：可进入调度候选。
3. `in_progress`：人工处理中或已开始派发。
4. `blocked`：等待依赖或决策。
5. `done`：已完成。
6. `cancelled`：已取消。

### Execution

Execution 由 `task_runs` 表示，不直接写进 todo 主状态。

Todo 只保存 `taskRunId`、`sessionId`、`traceId`、`requestId`、`nodeId` 等关联字段。这样可以允许：

1. 一个 todo 多次尝试执行。
2. 一次执行失败后保留 todo 上下文。
3. 后续引入 `todo_executions` 或 `task_attempts` 表。

### Reopen

Reopen 是把 `done` 或 `cancelled` 的 todo 重新置为 `ready` 或 `backlog`。

规则：

1. 保留原 `traceId`、`dedupeKey` 和历史 metadata。
2. 记录 `reopenedAt`。
3. 不复用旧 `taskRunId` 作为新执行的唯一证据。

### Cancel

Cancel 分两层：

1. Todo cancel：停止计划项进入新的调度。
2. Task cancel：中断或标记已进入 scheduler 的执行。

如果 todo 已关联 active task，后续应同时调用 scheduler cancel，并写入 `session_events`。

### Batch

Batch 是弱网、多节点和大型变更下的分批单位。

分批规则应优先看状态和依赖，而不是只按数量切分：

1. 同一 `tenantId/projectId/stageId` 下分批。
2. 高风险项先小批量执行。
3. 非幂等写操作不自动重试。
4. 每批有独立 `batchKey`、trace 和可恢复状态。

## Current Implementation

已新增：

1. `packages/agent/src/todos.ts`
   - PostgreSQL `todos` 表。
   - `tenant_id/project_id/user_id/node_id/stage_id/parent_id` 字段。
   - `trace_id/request_id/dedupe_key/task_run_id/session_id/batch_key` 字段。
   - `createTodo`、`updateTodo`、`loadTodo`、`listTodos`、`seedLosPlanningTodos`。
2. `packages/gateway/src/server.ts`
   - `GET /todos`
   - `POST /todos`
   - `PATCH /todos/:id`
   - `POST /todos/:id/reopen`
   - `POST /todos/:id/cancel`
   - `POST /todos/seed`
3. `packages/web`
   - `Todos` 导航项。
   - Todo 列表、状态/kind 筛选、详情面板。
   - 新增 todo 表单。
   - ready/start/block/done/cancel 状态动作。
4. 初始 seed todos
   - SaaS 字段骨架。
   - requestId ledger。
   - idempotency key 表。
   - executor node registry。
   - task lease/recovery。
   - test DB isolation。

## Placement

1. Todo storage lives in `packages/agent` because it is part of scheduling semantics.
2. HTTP routes live in `packages/gateway`.
3. UI lives in `packages/web`.
4. Long-form rationale lives in `docs/adr`.
5. Future auth/tenant enforcement should not be hidden in UI; it belongs in gateway middleware and DB query boundaries.

## Open Risks

1. `todos` 目前支持字段预留，但没有真正的 auth、tenant isolation 或 row-level permission check。
2. `dedupeKey` 仍不是完整防重放；需要独立 `idempotency_keys` 表。
3. `task_runs`、`session_events`、`sessions`、`observations` 还没有同步补齐 tenant/project/user/node/request 字段。
4. `Todos` UI 现在只管理计划项，还没有真正从 todo 创建 scheduler task。
5. Node heartbeat、lease、weak-network resume 尚未实现。
6. 测试仍可能写入有效配置数据库，需隔离。

## Next Tasks

1. P0：为 gateway 增加 request context middleware，生成 `requestId` 并贯穿日志、todo、task、session events。
2. P0：新增 `idempotency_keys` 表，按 tenant/project/route/key/body_hash 防重放。
3. P0：把 tenant/project/user/node/request 字段补到 `task_runs` 和 `session_events`。
4. P1：新增 `executor_nodes` registry 和 heartbeat read model。
5. P1：新增 task lease 和 orphan task recovery。
6. P1：实现 `POST /todos/:id/dispatch`，只允许 `ready` 且 kind 为 `task` 或 `batch` 的 todo 派发。
7. P1：隔离测试数据库或在测试 teardown 清理 fixture。

## Verification

当前应验证：

1. `pnpm check`
2. `./tools/check-contracts.sh`
3. `pnpm run restart`
4. `curl -fsS http://127.0.0.1:8080/todos`
5. Web console 中 `Todos` 页面能看到 seed 项并可新增/改状态。
