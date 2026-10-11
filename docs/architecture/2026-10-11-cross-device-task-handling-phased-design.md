---
subject: 跨设备/跨项目任务处理的分阶段设计（M1/M3/Win 执行节点 + 跨项目数据面）
auditedRev: 1d5d0a9a (git, 本轮工作副本基线)
readOnly: true
method:
  - 真库 SQL（executor_nodes 能力矩阵 / run_specs / task_runs 节点分布）
  - 源码阅读（node-routes / run-routes / executor-client / file_sync / artifact-transfer 契约）
  - 本会话前序实测（§10 边界复核、§11 cantool 试点、node-selection 与 cross-device 两篇评审）
---

# 跨设备 × 跨项目任务处理：分阶段设计（2026-10-11）

## 0. 范围与结论

本文回答"如何让任务在**正确的设备**上、以**正确的项目归属**执行，并且可查、可汇总、可追溯"，覆盖三类真实工作流：
cantool（M3 编译 → M1/M3 更新）、lot2extension（M1/M3/Win 协同）、**存储**（无独立项目目录，但天然跨项目跨设备）。

**核心判断**：本仓**已有**能力矩阵与选点算法（`executor.requiredCapabilities` + `executor-client` 健康排序 + 8 个能力齐全的在线节点），
**缺的不是设备管道，而是三道表达与观测面**：① 设备/能力**只读面未接出去**；② 派发**无法表达放置需求**；
③ 运行记录**没有按项目/按设备的汇总**。因此方案按"先观测 → 再表达 → 后编排"分阶段，**不新建第二套任务状态机**。

## 1. 事实基线（2026-10-11 实测）

**在线执行节点（8/36；全部 `run_agent` + `task_lease` + `stream_ndjson` + `artifact_transfer`）**

| 节点 | 设备 | 平台/沙箱 | resourceClass | heavy | 备注 |
| --- | --- | --- | --- | --- | --- |
| `mbp-executor-1` | **M1** | macos-sandbox-exec | standard | ✅ | `127.0.0.1:8090`；file_sync：`los-workspace` + `…/projects` |
| `m3pro-executor-1` | **M3** | macos-sandbox-exec | standard | ✅ | `100.82.176.56:8090` |
| `desktop-r45553o` | **Win-A** | windows-acl | standard | ✅ | `100.90.170.58:8090` |
| `desktop-srsbe20` | **Win-B** | windows-acl | standard | ✅ | `100.89.230.103:8090` |
| `node34-executor-1` | Linux VM | linux-bwrap | standard | ✅ | file_sync：`/opt/los/los-workspace` |
| `tencent-sin-executor` | 云 | tool_policy | standard | ✅ | |
| `oracle-executor` / `vultr-executor` | 云 | tool_policy | **constrained** | ❌ | `heavy_task_safe:false` |

**两条执行路径**：`/chat`（网关进程内，节点标签 = `config.executor.nodeId`，近 7 天 282 条全在 M1）
与 **scheduler 远端派发**（`executor-client`：能力过滤 + 维护窗口 + 健康排序；近 7 天 0 条远端 agent run，本机无 `EXECUTOR_MESH_NODES`，走 DB 节点路径）。

**数据面（不是执行节点）**：NAS（极空间，WebDAV/SMB）、本地 vault、冷层分卷包——它们**没有 `run_agent`**，只能经某个执行节点挂载/搬运；
现成机制是 `file_sync_*`（节点↔节点目录同步，M1 已登记两个 folder）与 `artifact-transfer` 契约（`artifact_transfer` 能力）。

## 2. 三个真实工作流的设备拓扑

| 工作流 | 拓扑 | 对任务的真实要求 |
| --- | --- | --- |
| **cantool** | 编译在 **M3** → 产物同时更新 **M3 + M1** | 一次逻辑任务、**两个目标设备**、有构建依赖顺序、需产物搬运（`artifact_transfer`）与"更新后验证" |
| **lot2extension** | 代码在 M1/M3 + **采集端在 Win**（Vivaldi + 扩展 + 桥） | 跨平台（mac/win）、**异构步骤**（win 侧要跑浏览器/扩展操作）、需要按平台选节点 |
| **存储** | 本地 vault（M1）+ NAS（Z4Pro）+ 可能的云副本；服务 **wechatdp / lot2extension / 其它仓** | **无项目目录**、天然跨项目；任务是**数据面**（取/推/校验/回收），要求"能到达该端点的节点" |

## 3. 设计原则（沿用本仓既有纪律）

1. **唯一任务事实**：`run_specs` / `task_runs` 是权威（`project_id` / `node_id` / `trace_id` 都是一等列）；视图只做投影，**不得**复制状态机。
2. **能力而非 if-else**：选点只依据**声明式能力**（`requiredCapabilities` / `resourceClass` / `heavy_task_safe`），不写"如果是 cantool 就用 M3"这类硬编码。
3. **放置需求必须显式**：无法表达的需求 = 不可观测的需求；一切"必须在某设备/某平台"的要求都要能进契约。
4. **投影带 `asOf`**：任何跨设备/跨项目汇总都要能让**陈旧可见**（沿用 `cross-project-summary` 的做法）。
5. **fail-loud**：选不到合格节点时明确拒绝并给出原因，**不得静默落本机**。
6. **登记门禁**：新设备/新数据端点进登记并有机械校验（沿用 `check-los-project-bindings` 的思路）。

## 4. 分阶段方案

### P0 观测先行（本批交付）
- **目标**：把"谁在线、能干什么、谁在跑什么"变成可查的只读面；补齐 run 的项目维度。
- **交付**：① `GET /runs` 服务端 `projectId/status/limit/since` 过滤 + `los_runs_list` 改服务端过滤；
  ② MCP `los_nodes_list`（薄包装既有 operator 门禁的 `GET /nodes`，含能力/健康/队列深度）。
- **验收**：任意 project 的三处（CLI/Web/MCP）同一查询计数一致；不存在的项目返回 **0**（负向控制）；节点清单含 8 个在线节点与其能力键。
- **不做**：不做汇总聚合、不动调度、不给 `/chat` 加节点参数。

### P1 放置可表达（placement-aware dispatch）
- **目标**：任务能声明"我要什么设备/能力"，并**经 scheduler 路径**落到合格节点。
- **交付**：远端路径 smoke 复验（先证可用）→ 暴露"带放置需求"的派发（如 `los_scheduled_execution` 带 `executor.nodeId` / `requiredCapabilities`）→ `GET /runs/summary?groupBy=project|node|status`（含 `asOf`）。
- **验收**：`task_runs.node_id` = 目标节点且事件面完整；能力不满足时**拒绝并说明**；汇总与逐项目求和机械对账。
- **不做**：不把远端派发接进 `/chat`（ADR 级，见 node-selection 文档）。

### P2 单任务多设备（fan-out 编排）
- **目标**：一个逻辑任务 → N 个设备子任务（cantool：M3 编译 → M1/M3 更新），父子可追。
- **交付**：复用 `agent-task-graph` + `session-subagents` 谱系（`parent_run_spec_id`）+ `artifact_transfer` / `file_sync` 搬运；父子统一 `traceId`。
- **验收**：父任务视图能看到全部子任务的设备与状态；任一子任务失败时父任务进 `blocked` 且 `nextAction` 指向补救；产物搬运有 hash 校验。

### P3 存储作为跨项目/跨设备工作流
- **目标**：把"无项目目录的数据面处理"变成一等工作流（见 §5）。
- **交付**：数据端点登记（NAS/vault/云）+ 归属 project（如 `storage`）+ 能力约束（能到达该端点的节点）。
- **验收**：存储任务的 `project_id=storage`、`node_id` 为具备该端点访问能力的节点；跨项目引用（wechatdp 等）以**引用**而非复制出现。

### P4 收敛与治理
- **目标**：投影边界三件套（owner/phase/transitionId + quarantine）、跨系统关联键强制、SLO/告警。
- **验收**：给定 `traceId` 一条查询能 join 出 DSH 会话 + los run/task/verification；投影坏状态进 quarantine 且有告警。

## 5. 存储怎么落（专门回答）

**问题**：存储没有独立项目文件夹，但处理是跨项目跨设备的。
**建议**：不要把 NAS/vault 塞进"repo 形状"的项目绑定，而拆成两件事：

1. **归属**：为数据面立一个**工作流项目**（建议 `projectId=storage` 或 `infra-storage`），
   让 run/task 有归属可查、可汇总（`run_specs.project_id=storage`）；它是"工作流身份"，**不是磁盘路径**。
   ⇒ 与现有 binding 模型的唯一冲突是"binding 需要 workspacePath"。**解法**：把该 binding 的 `workspacePath` 指向
   **数据面根目录**（如 `~/.local/state/los-storage` 之类的中性工作区），把真正的端点写在能力/配置里，
   而不是滥用 repo 路径表达 NAS。
2. **可达性**：端点（NAS WebDAV、vault 路径、密钥）用**能力**表达（如 `storage_nas_z4pro`、`vault_wechatdp_key`），
   由具备该能力的节点执行 ⇒ 与 P1 的 `requiredCapabilities` 直接衔接，天然跨设备。
3. **跨项目**：存储任务对具体仓只做**引用**（`wechatdp` / `lot2extension` 作为参数/标签），
   台账里仍记 `project_id=storage`，避免"一次搬运污染五个项目的运行记录"。

## 6. 拒绝清单（明确不做，避免后人重试）

1. 为跨设备引入**第二套任务状态机**或第二个 scheduler（Codex 的"权威日志 + 可重建镜像"已证明单源可行）。
2. 在 `/chat` 上硬塞 `nodeId`（该字段在 chat 路径无人消费；见 node-selection 文档）。
3. 让 DSH 直连 los 的 PostgreSQL 做汇总（绕过 `asOf` 与单写者纪律）。
4. 用"项目名 → 设备"的硬编码映射表达放置需求（应走能力声明）。
5. 把 NAS 当执行节点（它没有 `run_agent`；只能作为数据端点被节点访问）。

## 7. 第一批（P0）执行清单与验证项目

见本文 §4 P0；**验证项目：cantool**（用户点名的跨设备工作流：M3 编译 → M1/M3 更新）。
验证判据：① 用新的服务端过滤查到 cantool 的运行记录（与逐条核对一致）；② 用节点清单说明 cantool 工作流涉及的设备（M3 编译、M1/M3 更新）
在当前 fleet 里**都有合格节点**（`deploy_safe` + `heavy_task_safe`）。

## 8. 第一批（P0）验证记录（2026-10-11）

**交付**：`GET /runs` 服务端过滤（`projectId/status/limit/since`）+ `listRunSpecs` 支持过滤 + MCP `los_nodes_list`（operator 门禁）。
**前置动作**：网关重启（`tools/los.sh restart`，原进程 10:57 启的、早于本批代码；重启前确认 `queued_or_running=0`）。

**判别性证据（服务端过滤 vs 客户端兜底）** `[E]`：

| 查询 | 重启前（旧网关 + 客户端过滤） | 重启后（服务端过滤） | 库内真值 |
| --- | --- | --- | --- |
| `los_runs_list(projectId='dsfolder-fmtguard', limit=50)` | matched=**6** | matched=**50**（limit 截断） | `run_specs` 共 **58** |
| `los_runs_list(projectId='cantool')` | 3 | **4** | **4** |
| `los_runs_list(projectId='no-such-project-xyz')` | 0 | **0**（负向控制） | 0 |

⇒ 重启前的 6 正是"全局最新 50 条里恰好属于该项目的行数"，这就是原缺口（计数与真源不一致）的现场。

**节点清单** `[E]`：`total=36 / online=8`；M1 `mbp-executor-1`、M3 `m3pro-executor-1`、Win `desktop-r45553o` / `desktop-srsbe20` 均在线，
且 `heavy_task_safe` / `deploy_safe` / `artifact_transfer` 全为真。工具面从 10 增至 **11**。

**过程中修掉的自身缺陷（留档，同一失效模式第 4 次）**：`/nodes` 的 `capabilities` 是**对象**（键→`true`/字符串/数组），
我先前用 `curl | python` 打印时把它渲染成 `keys()`，误判为字符串数组，于是投影与测试都按错误形状写（能力全空）。
已改为"取值为 `true` 的键" + 单独暴露 `sandbox`（`windows-acl` / `macos-sandbox-exec` / `linux-bwrap` / `tool_policy` 是放置判据），
测试改用真实形状并加负向控制（`workspace_read:false` 不得出现）。

**Web 侧（同一批的后半）** `[E]`：

- `run-specs-page` 新增**项目维度**：选项来自 `GET /projects`（公开只读），过滤走服务端 `GET /runs?projectId=…`，
  缓存键改为 `['runs', projectFilter]`（否则切项目命中旧缓存）；`zh`/`en` 双语标签已加。
- **顺带修掉一个真实 UI bug**：Tasks 页的状态下拉**一直不生效**——页面把 `status` 发给 `/tasks`，
  而该路由过去**不读**这个参数（`listTaskRuns(50, scope)`），页面又没有客户端兜底（直接渲染 `tasks.data`）。
  已让 `listTaskRuns` 支持 `scope.status` 并在 SQL 内过滤。实测判别性证据：`/tasks?status=succeeded` → 50（上限截断）、
  `status=queued` → **0**、`status=no-such-status` → **0**；修复前任何 status 都返回最新 50 条。
- 产物验证（不是"构建成功"就算）：网关实际发出的 `/assets/index-TUpzyHR3.js`（1.27 MB）内含 `全部项目` /
  `ops.runSpecs.filterAllProjects` / `按项目筛选`，即**正在服务的 UI 就是改动后的**。

**残留**：`packages/agent/src/run-specs.ts` 现 **699 行**（硬上限 700）——下一个改动必须先抽取模块再动它；
另 `/tasks` 仍**没有项目维度**（`task_runs` 无 `project_id` 列，要 join `run_specs`），已列入下一批。

## 9. 项目适配性（哪些项目适合跨设备，按技能/实测拓扑）

| 项目 | 拓扑（实测/技能依据） | 适配阶段 | 判据 |
| --- | --- | --- | --- |
| **cantool** | 开发 M1/M3 · **构建 M3**（`m3pro-executor-1` = `losdeMacBook-Pro.local`）· 使用 **M1**（`/Applications/CanTool.app`）；产物 M3→M1 回传 + sha256/codesign/身份断言；已有一条命令 `scripts/m3-build.sh` | **P1 首选试点** | 三台设备在 fleet 里都有合格节点（heavy+deploy_safe+artifact）；跨设备流程**已存在且带门禁**，缺的只是"可派发 + 可观测" |
| **lot2extension** | 代码 M1/M3 + **采集端 Win**（Vivaldi + 扩展 + webbridge 桥） | **P2** | Win 节点在线且有 `node_command_runner`；但 win 侧是**长驻交互式运维**，需先有 P1 的放置表达再谈编排 |
| **存储** | 数据端 NAS（极空间 Z4Pro，WebDAV/SMB）+ 本地 vault；**不是执行节点** | **P3** | 无 `run_agent` ⇒ 只能作为数据端点被节点访问；按 §5 立工作流 + 能力约束 |
| 其余仓 | 单机（M1）为主 | 暂不需要 | 无跨设备结构 |

## 10. 证据边界

- **CONFIRMED**：§1 节点矩阵与两条执行路径；`GET /nodes` 已存在且 operator 门禁；`listRunSpecs` 无过滤（需扩展）；`file_sync`/`artifact_transfer` 契约与能力键存在。
- **INFERRED**：P1 的"放置可表达"成本（复用 executor-client，估为中等）；P2 的父子编排可复用 `agent-task-graph`（未读该契约实现细节）。
- **未验证**：远端 smoke 是否仍可用（P1 第一步）；`storage` binding 的 workspacePath 取法（需与 operator 确认落点）。
