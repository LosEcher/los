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
- **交付**：~~远端路径 smoke 复验~~ **已完成（见 §10）** → ~~暴露"带放置需求"的派发~~ **已完成（见 §12）** → `GET /runs/summary?groupBy=project|node|status`（含 `asOf`）**待做**。
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
另 `/tasks` 的项目维度**已补**：初稿我写"`task_runs` 无 `project_id`、需要 join `run_specs`"，
核 `\d task_runs` 与 `createTaskRun` 的 INSERT 后发现**该列存在**（测试里也一直在传 `projectId`）——
**这是本会话第 5 次同类纠错**（都是没核列/没核消费点就下结论）。现在 `listTaskRuns` 直接按列过滤，
`/tasks?projectId=` 生效，Tasks 页也在同一位加了下拉（缓存键 `['tasks', statusFilter, projectFilter]`）。

## 9. 项目适配性（哪些项目适合跨设备，按技能/实测拓扑）

| 项目 | 拓扑（实测/技能依据） | 适配阶段 | 判据 |
| --- | --- | --- | --- |
| **cantool** | 开发 M1/M3 · **构建 M3**（`m3pro-executor-1` = `losdeMacBook-Pro.local`）· 使用 **M1**（`/Applications/CanTool.app`）；产物 M3→M1 回传 + sha256/codesign/身份断言；已有一条命令 `scripts/m3-build.sh` | **P1 首选试点** | 三台设备在 fleet 里都有合格节点（heavy+deploy_safe+artifact）；跨设备流程**已存在且带门禁**，缺的只是"可派发 + 可观测" |
| **lot2extension** | 代码 M1/M3 + **采集端 Win**（Vivaldi + 扩展 + webbridge 桥） | **P2** | Win 节点在线且有 `node_command_runner`；但 win 侧是**长驻交互式运维**，需先有 P1 的放置表达再谈编排 |
| **存储** | 数据端 NAS（极空间 Z4Pro，WebDAV/SMB）+ 本地 vault；**不是执行节点** | **P3** | 无 `run_agent` ⇒ 只能作为数据端点被节点访问；按 §5 立工作流 + 能力约束 |
| 其余仓 | 单机（M1）为主 | 暂不需要 | 无跨设备结构 |

## 10. P1 前置探针：远端 executor smoke 实测（2026-10-11）

**目的**：在暴露"放置需求"之前，先证明 scheduler 的远端路径**今天仍可用**（历史远端 agent run 仅 3 条、最近 2026-08-16）。
**做法**：`POST /scheduled-work-items`（`templateId=scheduled_execution`、`trigger=once@2099`）+ `POST …/:id/trigger`，
目标 `executor.nodeId=node34-executor-1`；跑完 `PATCH status=retired` 回收。

**结果：远端路径可用** `[E]`

| 判据 | 实测 |
| --- | --- |
| 落点 | `task_runs.node_id = node34-executor-1`，`succeeded` |
| 真在远端跑 | 会话 `workspaceRoot = /opt/los/los-workspace`（**节点本地路径**，M1 上不存在） |
| 真的执行了 prompt | agent 回答 = `LOS_REMOTE_EXECUTOR_SMOKE_1791692070`（与请求串一致） |

**同时测出四处必须处理的问题** `[E]`

1. **凭据必须由调用方给**：不带 `agentKey` 时远端调用直接 `error: "unauthorized"`（277ms 内 fail-loud，**没有静默挂起** ✅）。
   ⇒ 若把节点选择暴露给 MCP/DSH，**不能让每个调用方各自持有 agent 密钥**；网关应回退到自身配置的 `EXECUTOR_AGENT_KEY`。
2. **生效策略与声明不一致**（安全相关）：模板声明 `toolMode=read-only` + `sandboxMode=sandbox`，但远端会话是
   `toolMode=project-write`、`toolPolicy={maxRiskLevel: L1, allowWrites: true, sandboxAvailable: false}`。
   ⇒ 远端路径上"声明≠生效"，暴露前必须查清是谁覆盖了策略（或至少在契约里写明调度路径的策略来源）。
3. **声明的 `requiredChecks` 没有执行**：该次运行**没有 `run_spec_id`**，也没有写入任何 `verification_records`
   （近 10 分钟 0 条）⇒ 调度路径的"检查门禁"与 chat 路径不是同一套；跨设备任务若依赖检查门禁，需要另行接通。
4. **平台已自带强前置校验（好的一面，共 5 条 fail-loud）**：远端执行必须显式给 `sandboxMode`、
   `workspaceRoot` 必须是**节点本地路径**、必须有 `editableSurfaces` 与至少一条 `requiredChecks`、
   approval 策略必须是 `preapproved_scope`。⇒ P1 的工作主要是**暴露一条已被守卫的路径**，而不是新建管道。

**P1 的修订后的开工条件**：① 网关自动注入 agent 凭据；② 查清远端策略覆盖来源；
③ 决定跨设备任务是否要求 `verification_records`（要就接通调度路径的检查面）。

## 12. P1 落地记录：放置需求可表达（2026-10-11）

**HTTP 层**
- `normalizeExecutorConfig` **不再静默丢弃**不认识的能力名：此前 `.filter(...)` 把拼错的名字悄悄过滤掉，
  调用方以为约束生效、任务却可能落到不满足要求的节点上；现在 **400 + 允许清单**。
- **可要求能力集合从 7 个扩到 12 个**：`run_agent` / `artifact_transfer` / `node_command_runner` /
  `file_sync_scan` / `file_sync_deep_verify` 此前**既不可要求、又被静默丢弃**——而 cantool 的 M3→M1
  产物搬运正需要 `artifact_transfer`。单一真源与判定函数落在 `scheduler/types.ts`，
  网关改为委托（另删掉它自己那份 7 项清单）。判定语义照 `satisfiesCapability`：
  上报值为 `true` 即满足；`sandbox` 例外，需要具体后端（`linux-bwrap` / `macos-sandbox-exec`），
  `native` 与 `tool_policy` 不算。

**MCP 层**
- 新增第 12 个工具 **`los_placed_run`**（operator 门禁）：一次调用完成
  `POST /scheduled-work-items`（`scheduled_execution` + `preapproved_scope` + `once@2099` + 放置块）→
  `POST /…/:id/trigger`，回传 `{scheduleId, nodeId, requiredCapabilities, scheduleRunId, runStatus, error}`。
  远端执行的前置校验（sandboxMode / 节点本地 workspaceRoot / editableSurfaces / ≥1 requiredChecks）原样透传且**原样报错**。

**真机验收** `[E]`

| 判据 | 结果 |
| --- | --- |
| 未知能力（HTTP） | **400** `unknown executor capability: heavy_task_safe_typo; allowed: …`（此前：静默丢弃） |
| 新扩展能力被接受 | `artifact_transfer` 进入模板并被台账记录 |
| **能力真的参与选点** | 调度决策台账：`executor_selection \| executor_registry \| required=["artifact_transfer","heavy_task_safe","sandbox","shell","workspace_write"]` |
| **指定设备真的生效** | `los_placed_run(nodeId='m3pro-executor-1', projectId='cantool')` ⇒ `task_runs = succeeded \| **m3pro-executor-1** \| project **cantool**` |
| 未知能力（MCP） | `isError=true`，原文转达 400 与允许清单 |
| 能力不满足时 | 选点失败**已是 fail-loud**（`file:packages/agent/src/scheduler/scheduled-task-runner.ts` 记录 `no_executor_match` + 候选/能力后 **rethrow**）；只有"未请求 executor"才落 `gateway-local` |

**测试**：`@los/cli` 36/36（新增 `los_placed_run` 两次 POST + operator 头 + 请求体断言、以及拒绝路径用例）。

## 11. 证据边界

- **CONFIRMED**：§1 节点矩阵与两条执行路径；`GET /nodes` 已存在且 operator 门禁；`listRunSpecs` 无过滤（需扩展）；`file_sync`/`artifact_transfer` 契约与能力键存在。
- **INFERRED**：P1 的"放置可表达"成本（复用 executor-client，估为中等）；P2 的父子编排可复用 `agent-task-graph`（未读该契约实现细节）。
- **未验证**：远端 smoke 是否仍可用（P1 第一步）；`storage` binding 的 workspacePath 取法（需与 operator 确认落点）。
