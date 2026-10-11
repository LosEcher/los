---
subject: DSH/los 的跨项目与跨设备任务模型（派发 / 按项目查看 / 全局汇总三层）
auditedRev: 1d5d0a9a (git, 本轮工作副本基线)
readOnly: true
method:
  - 源码阅读（run-routes / cross-project-routes / web pages / executor-client / scheduler / 契约）
  - 真库 SQL（run_specs / task_runs / executor_nodes / dsh_session_* 投影）
  - 参考实现（Codex 分析文档、Cindy 本机落盘物）+ 四级可迁移性判定
  - 本会话前序实测（§10/§11 的审计与试点）
---

# 跨项目与跨设备任务模型评审（2026-10-11）

**评审对象**：这样一个设计是否成立——「在对应项目派发任务、支持按项目查看任务、也支持在 DSH/los 汇总查看全部执行记录」。

## 0. 结论（先回答"是不是"）

| 声称的能力 | 现状 | 判据 |
| --- | --- | --- |
| 在**对应项目**派发 | ✅ **成立** | `los_run(projectId=X, operatorScope=true)`；落错仓会 fail-loud；未登记仓够不到（10 binding / 30 登记仓 / **9 个够不到**，已有门禁） |
| **按项目**查看任务 | ⚠️ **数据面成立、展示面缺** | 数据：`los_runs_list(projectId)` 客户端过滤 `GET /runs`（该路由本身**无项目过滤**）；展示：Web 的 `run-specs-page.tsx` / `tasks-page.tsx` **没有项目维度**（`inbox` / `work` / `schedules` 有） |
| **汇总查看全部执行记录** | ⚠️ **分成两块、且缺 run 侧的跨项目汇总** | DSH 会话侧：`GET /cross-project/summary`（契约 `cross-project-summary`，`implemented`，聚合 `dsh_session_catalog` / `dsh_session_pain` / `dsh_context_injection`，**每段带 `asOf`**）；los run 侧：只有 `GET /runs`（全项目原始行，无聚合指标、无分页语义） |
| **跨设备**执行同一任务 | ❌ **基本不成立** | chat run 在网关进程内执行（近 7 天 282 条**全在 `mbp-executor-1`**）；远端派发只实现在 scheduler 路径（`executor-client.ts`），**近 7 天 0 条远端 agent run**，本机无 `EXECUTOR_MESH_NODES`；DSH 会话是**每机本地**的，靠 session-index → los 投影当桥 |

一句话：**"按项目派发"和"跨项目聚合读"已经成立（后者靠投影），但"按项目的 run 展示"缺失，"跨设备执行"实质为空白，"同一任务在 DSH 与 los 两侧的关联视图"也不存在。**

## 1. 三层模型与当前落点

| 层 | 事实源 | 现有落点 | 缺口 |
| --- | --- | --- | --- |
| **派发** | `run_specs` / `task_runs`（`project_id` / `node_id` / `trace_id` 都是一等列） | MCP 10 工具；`/chat`；scheduled-work | 无节点选择（见 `2026-10-11-execution-node-selection-and-remote-runs.md`） |
| **按项目查看** | 同上 + `GET /runs` | CLI/Web/`los_runs_list` | Web run 视图无 `project` 维度；`GET /runs` 无过滤参数（过滤在客户端做 ⇒ 与"服务端真源"不一致） |
| **全局汇总** | los 投影表（`dsh_session_*`）+ los 运行行 | `GET /cross-project/summary`；`GET /runs` | 无 **run 侧**跨项目聚合（按项目分组的成功率/成本/阻塞/最老未收口）；无 DSH 会话 ↔ los run 的**关联**视图 |

## 2. 四原则逐条评估（可维护 / 可扩展 / 可观测 / 可追溯）

| 原则 | 现状判定 | 依据与缺口 |
| --- | --- | --- |
| **可维护** | ✅ 大体成立 | 单一写者：`session_events` 权威、投影表可重建、每段 `asOf`；契约先行 + 生成物无 diff 门禁（`check-contracts` 抓到了我漏跑的 `contracts:generate`）。缺：`GET /runs` 与 `los_runs_list` 的过滤/排序口径**两处实现**，属潜在第二真源 |
| **可扩展** | ✅ 有机制 | 新项目 = 登记 binding（且有 `check-los-project-bindings` 门禁）；新工具 = 契约 + 适配器 + 探针。缺：binding 与工作区登记**两套命名口径**（`run-diff` vs `dsfolder-run-diff`）需要别名映射才算对齐 |
| **可观测** | ⚠️ 半 | 有：run 状态投影、`nextAction`、recovery 建议、跨项目会话汇总、`asOf` 陈旧可见。缺：**按项目/按设备的聚合指标**；DSH 与 los 两侧对"同一任务"没有共同 id 视图（`traceId` 是唯一可用的关联键，但 DSH 侧默认不透传） |
| **可追溯** | ✅ 强 | `trace_id` / `request_id` / `runSpecId` / `taskRunId` 全程落库；幂等键可由调用方指定（本轮修复）；detach 保证 id 不失。缺：DSH 会话 id 与 los `sessionId` 是两套命名空间，跨系统追溯要靠人拼 |

## 3. 参考实现能给什么（四级判定，逐条标注）

**Codex（本地分析：`dsfolder/CODEX-DSH-HARNESS-DESIGN-ANALYSIS-2026-08-21.md`）**

| 机制 | 级别 | 对本题的用法 |
| --- | --- | --- |
| 权威日志 + **可重建镜像**双轨（§2.5） | `可直接落地`（los 已有） | 与本仓 `session_events` + 投影同构 ⇒ 作为"不引入第二状态机"的**决策依据** |
| 多 agent 协作模型（§2.4，Codex 领先域） | `可直接落地`（部分） | 子代理谱系（los `session-subagents` 已有）+ **跨设备**协作缺"任务所有权"语义 |
| 任务 = 仓库 + **环境**（云任务按仓建环境） | `可直接落地` | 跨设备任务必须绑定"环境/节点资格"而不只是 repo——本仓**已有对应物**：`executor.requiredCapabilities` 经 `_compileExecutorRequirements()` 编译、再由 `satisfiesCapability()` 过滤节点（`file:packages/agent/src/scheduler/executor-client.ts:42`、`:140`），但**只在 scheduler 路径生效**，`/chat` 派发无法表达能力需求 |
| 沙箱/审批分档（§2.6） | `作决策依据` | 支持本仓"审批门禁放在网关、不放在适配器"的既有取舍 |

**Cindy（本机落盘物，`~/Library/Application Support/Cindy/`）**

| 观察 | 级别 | 说明 |
| --- | --- | --- |
| `ghost-skill-projection-boundary.json` = `{version, phase:"stable", ownerId, transitionId, updatedAt}`，且有 `…boundary.quarantine.json` 旁车 | `可直接落地`（**模式**，非代码） | **投影边界三件套**：单一 owner + 可比对的 transitionId + 坏状态隔离（quarantine）。与本仓 ADR 0047"单一写者/快照不是第二真源"同源，可直接用于 los 投影表（每张投影记 owner/phase/transitionId）|
| 机制语义（phase 如何迁移、quarantine 何时产生） | `不可迁移`（本轮） | 只读到落盘字段，**未读其代码** ⇒ 不得当经验引用；要用需另做 `reference-app-mechanism-audit` |

> 注：Cindy 在本机仅作为"已安装应用"存在（`ELECTRON-AND-LAUNCHER-ANALYSIS-2026-10-09.md` 只有体积/`.node` 计数）。**不要**把上面的模式写成"Cindy 的做法"，它是**从落盘物观察到的一个投影边界模式**。

## 4. 跨设备 × 跨项目：按 DSH/los 思路的处理方案

**总原则（与既有设计一致）**：`run_specs`/`task_runs` 是**唯一任务事实**（带 `project_id` + `node_id` + `trace_id`）；DSH 侧只做**投影与入口**，不复制状态机；每个新增维度要么进契约、要么进登记门禁，**不许出现第二真源**。

**推荐路径（按成本递增，前两步零/低风险）**

1. **补"按项目看"的缺口**（低成本，纯读）：`GET /runs` 增加 `projectId` / `status` / `since` / `limit` 服务端参数；Web `run-specs` / `tasks` 加项目筛选；`los_runs_list` 改为服务端过滤（消除两处口径）。验收：同一查询在 CLI/Web/MCP 三处返回同一 `count`。
2. **补 run 侧跨项目汇总**（低成本）：新增 `GET /runs/summary?groupBy=project|node|status`（只读、复用现有投影），字段含 `total / succeeded / failed / blocked / oldestOpenAgeMs / costUsd?`，**每段带 `asOf`**。验收：与逐项目 `GET /runs` 求和一致（机械对账）。
3. **让跨设备"可选"而不是"空白"**（中成本，需先复验）：先做一次远端 executor smoke（判据见 node-selection 文档 §4）；通过后把 scheduler 的节点选择**暴露给 MCP**（选项 C），而不是把远端派发硬接进 `/chat`（选项 A，ADR 级）。
4. **统一关联键**（低成本，收口可追溯）：MCP `los_run` 把 `traceId` 作为必填/自动生成并回传；DSH 侧在会话 metadata 里记 `runSpecId/traceId`；跨系统视图用 `traceId` join。验收：给定 `traceId` 能同时查到 DSH 会话与 los run/task/verification。
5. **投影边界三件套**（可选，借鉴第 3 节）：给每张投影表加 `ownerId / phase / transitionId`，坏状态进 `quarantine` 表 —— 与我们已有的 `asOf` 陈旧判定互补。

**明确不做（拒绝清单）**：① 为跨设备引入第二套任务状态机或第二个 scheduler；② 在 `/chat` 上硬塞 `nodeId`（已论证：委托字段无人消费）；③ 让 DSH 直连 los 的 PostgreSQL 做"汇总"（会绕过投影的 `asOf` 与单写者纪律）。

## 5. 缺口与可优化（按优先级，均给验收判据）

| 级别 | 缺口 | 落点 | 验收判据（可机械核） |
| --- | --- | --- | --- |
| P0 | Web run 视图无项目维度；`GET /runs` 无服务端过滤 ⇒ 过滤口径两处 | `packages/gateway/src/routes/orchestration/run-routes.ts`、`packages/web/src/pages/{run-specs,tasks}-page.tsx` | CLI/Web/MCP 同一查询 `count` 一致；负向：不存在的 project 返回 0 而非全量 |
| P0 | 无 run 侧跨项目汇总（观测面缺一块） | 新增 `/runs/summary`（只读） | 与逐项目求和一致；每段有 `asOf`；陈旧时显式标记 |
| P1 | 跨系统关联键未强制 | 适配器 `traceId` + DSH 会话 metadata | 给定 `traceId` 能 join 出两侧记录（一条 SQL 可证） |
| P1 | 跨设备执行未复验 | scheduler 远端路径 | 远端 smoke：`task_runs.node_id` = 目标节点且事件面完整 |
| P1 | 能力约束（`requiredCapabilities`）只在 scheduler 路径可表达；`/chat` 派发既不能选节点也不能声明能力 | 契约 / 选点 | 与 node 选择同批评估：要么把能力/节点需求接到 chat 派发（ADR 级），要么明确"远端执行只走 scheduler" |
| P2 | 投影表无 owner/phase/quarantine | `dsh_session_*` 投影 | 每张投影有 owner/phase；坏状态进 quarantine 且有告警 |
| P2 | DSH 侧 `los_chat` 无 target repo | `dsplugins/dsh-los-ops` | 带 `projectId` 的调用落到对应项目（非默认 los） |

## 6. 证据强度与不确定性

> **第三次自我纠错留档**：本文初稿写"`executor.requiredCapabilities` 声明未消费"，核 `executor-client.ts:42/140` 后
> 发现它**被消费**（编译需求 → 过滤节点），只是同样限于 scheduler 路径。三次纠错（§10.2 的 guard、
> 远端 run 计数、本条）**同一个失效模式**：只看聚合/声明就下结论，没核消费点。判据已固定为
> "**声称未消费前，必须在 `packages/*/src` 里 grep 消费点**"。

- **CONFIRMED（读过代码/查过库）**：§0 全部四行；`GET /runs` 无过滤（handler 只调 `listRunSpecs()`）；Web 两个页面无 project 维度（grep 无命中）；`cross-project-summary` 已实现且只聚合三张投影表；executor 选点两条路径与其排序依据；8 online / 28 offline 节点；近 7 天节点分布。
- **INFERRED**：§4 第 2 步的 `/runs/summary` 成本（按现有投影估）；Codex §2.4 的"跨设备协作"是否值得抄（只读了分析文档，未回源 codex-rs）。
- **未验证/需先核实**：远端 smoke 是否仍可用（`[U]`，本轮未执行）；Cindy 投影边界的运行时语义（只读到落盘字段）；`executor.requiredCapabilities` 是否有隐藏消费点。

## 7. 与现有待办的关系

本评审把此前散落的待办收敛到一张图：**派发/登记（已交付 + 已有门禁）→ 按项目看（P0 缺口，纯读改造）→ 全局汇总（P0 缺口，新增只读聚合）→ 跨设备（P1，先 smoke 再决定 A/C）→ 关联键与投影边界（P1/P2，追溯与可维护收口）**。
