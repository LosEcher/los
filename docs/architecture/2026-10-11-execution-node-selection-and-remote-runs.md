---
subject: los 执行节点选择与远端 chat run（/chat vs scheduler 两条执行路径的边界）
auditedRev: 1d5d0a9a (git, 本轮工作副本的基线提交)
readOnly: true
method:
  - 源码阅读（chat-service / chat-resume-plan / scheduler executor-client / scheduled-work-routes / run-spec 契约）
  - 真库 SQL（task_runs / run_specs / session_events，近 7 天与全量）
  - 真机探针（MCP 派发的 run 全部落 mbp-executor-1；本轮 4 次派发）
---

# 执行节点选择与远端 chat run：能力与边界（2026-10-11）

- **触发**：审计文档 §5 P1-4 的"节点不可选"待办——MCP 派发的 run 全落 `mbp-executor-1`，而 fleet 有 8 个在线 executor。
- **口径**：`[E]`=当场命令/DB 行可复现；`[I]`=源码推断；`[U]`=未验证。
- **结论先说**：**这不是一个可以"透传字段"的小活**。`/chat` 的 run 在网关进程内执行，远端派发只实现在 scheduler 路径；
  而那条路径**近 7 天零使用、历史仅 3 条**（最近 2026-08-16）⇒ 在复验它仍然可用之前，**不应**给 MCP 暴露节点参数。

## 1. 三条执行路径（现状）

| 路径 | 谁执行 | 节点标签来源 | 近 7 天 agent run | 依据 |
| --- | --- | --- | --- | --- |
| **chat run**（`/chat`、MCP `los_run`） | 网关进程内 | `config.executor.nodeId` | **282 条，全在 `mbp-executor-1`** | `file:packages/gateway/src/chat-service.ts:351` |
| scheduler 远端执行 | 远端 executor（HTTP，健康感知选点） | 选中节点 | **0 条** | `file:packages/agent/src/scheduler/executor-client.ts:44`（`nodeUrls` + 健康排序）、`:241` |
| fleet 主机自检 | 各节点本地 | 节点自身 | 28 条 `node34-executor-1`，但 **`run_spec_id` 为空** | `task_runs`（无 run_spec ⇒ 不是 agent run；间隔 6h，与 `.env` 的 `LOS_FLEET_HOST_CHECKS` 同频） |

远端 agent run 的**历史全部**：`node34-executor-1` 2 条（最后 **2026-08-16**，含一条
`run-remote-executor-smoke-…` **succeeded**）、`oracle-executor` 1 条（2026-07-28）`[E]`。
⇒ 远端路径**在代码与历史上成立**，但**近期无使用证据** `[E]`。

**本机配置态（2026-10-11 实测）**：`.env` 有 `EXECUTOR_ENABLED=true`、`EXECUTOR_NODE_ID=mbp-executor-1`、
`EXECUTOR_AGENT_KEY`、`EXECUTOR_NODE_CREDENTIAL`，但**没有 `EXECUTOR_MESH_NODES`**
⇒ `config.executor.meshNodes` 取默认 `[]`（`file:packages/infra/src/config.ts:276`）`[E]`。
于是选点走的是 `executor-client.ts` 的**第二条路径**：`listExecutorNodes(100)` +
`sortExecutorCandidates`（偏好 `config.nodeId`、健康排序）+ 维护窗口过滤 +
`execution.candidate` 计算（候选资格由 agent 侧评估得出，**不是 DB 里的裸列**）`[E]`。
DB 里当前 **8 online / 28 offline** 节点 `[E]`。⇒ 远端派发**不依赖 meshNodes 也能选点**，
但要真有节点被评成 candidate、且其 `agent_http` 可达。

## 2. `executor.nodeId`：声明与消费不一致（ADR 0049 同型；0049 未合并/编号已退役，见 `docs/README.md`）

- `contracts/run-spec.yaml` 顶层有 `executor{enabled,nodeId,leaseMs,heartbeatMs,requiredCapabilities}` `[E]`。
- **消费点只有**：scheduled-work 路由（`file:packages/gateway/src/routes/orchestration/scheduled-work-routes.ts:224`
  的 `normalizeExecutorConfig(body.executor)`）与 execution-experiment 路由 `[E]`。
- **`/chat` 完全不消费它** `[E]`（chat-route 无 `executor` 引用；chat-service 用的是 `config.executor.*`）。
- 因此"给 MCP 加一个 nodeId 参数"若只写进 `/chat` body，会是**第二真源**：网关读不到、run 照旧落本机。
  这与本批 §10.3 记录的跨项目授权问题同型（声明强于事实），但**方向相反**：那里是声明缺失、这里是声明多余。

## 3. 选项与取舍

| 选项 | 内容 | 成本/风险 | 判据 |
| --- | --- | --- | --- |
| **A. 把远端派发接进 `/chat`** | 让 chat run 也能在远端节点执行（复用 executor-client 的选点） | **高**：远端事件要回流进本地 SSE、task lease/所有权、远端验证与证据面、取消传播、节点离线时的恢复语义——属 ADR 级 | 需要 ADR + 专项 harness |
| **B. 保持 `/chat` 本地，远端走 scheduler** | 零新代码 | 低；但 DSH 侧目前没有触发面 | 现有能力，需文档化入口 |
| **C. 把 scheduler 的节点选择暴露给 MCP** | 新工具（如 `los_scheduled_execution`）带 `executor.nodeId`，operator 门禁 | 中：路由已消费该字段，但要走 scheduled-work 的模板/触发语义；**前提是远端路径仍可用** | 先复验远端 smoke，再谈暴露 |

**风险清单（A/C 共有）**：① 目标节点离线 ⇒ 任务可能一直 `queued` 到 lease 过期（`recoverExpiredTaskRuns` 兜底）；
② 远端执行的**证据面**（session_events / verification_records）是否在网关侧完整可见（本轮未验证 `[U]`）；
③ `los_task_cancel` 的取消传播到远端（`requestCancellation` 表存在，但对远端节点的实际生效未验证 `[U]`）。

## 4. 若要做 A：验收判据（先写判据，后写代码）

1. `los_run(projectId=X, operatorScope=true, nodeId='<远端>')` 返回的 `runSpecId` 对应 `task_runs.node_id = <远端>`（**台账为准**）。
2. 远端执行期间 `los_run_replay` 仍能从网关读到事件流（证据面不因远端而缺失）。
3. 目标节点离线时表达明确：要么拒绝派发（带原因），要么在可接受时限内进入 `blocked` 并给出 `nextAction`——**不得静默挂起**。
4. `los_task_cancel` 对远端任务生效（`task_runs.status=cancelled` + 远端收到取消请求）。

## 5. 建议（本轮的结论）

1. **先做一次远端 smoke 复验**（历史先例：`run-remote-executor-smoke-1786026859360-513d4bfa`，2026-08-06，`succeeded`）：
   走 **DB 节点路径**（本机无 `EXECUTOR_MESH_NODES`），目标选一个 `online` 且被评成 candidate 的节点
   （如 `node34-executor-1`），确认 `task_runs.node_id` 落在那台、且事件/证据面完整。
   **没有这一步，A/C 都不该开工**；这一步会创建一条 scheduled/experiment 记录（可回收），故先记判据再执行。
2. `/chat` 的节点选择**保持不暴露**（与适配器当前行为一致——本轮已刻意不造 node 参数）。
3. 真正需要"chat run 跑在远端"时再走 ADR（选项 A），并把 §4 四条判据作为验收门。

## 6. 本次修正记录（诚实留档）

复核过程中我先得出过两个**错误**结论，均由深查推翻，记录以免后人重犯：

1. "远端今天跑了 28 个 run"——`task_runs` 按 `node_id` 聚合得到的 28 条 `node34-executor-1` 任务**`run_spec_id` 为空**，
   是 fleet 主机自检，不是 agent run。**判据修正：agent run 必须 `coalesce(run_spec_id,'') <> ''`**。
2. （同批 §10.2 已记）resume-guard 那条"闸门不生效"——实为前序 run 已在续接前 0.65s 收口。

两条都是"聚合口径不对 ⇒ 貌似有证据"，与本仓 J6/ADR 0049 的主题同型（0049 未合并/编号已退役，见 `docs/README.md`）。
