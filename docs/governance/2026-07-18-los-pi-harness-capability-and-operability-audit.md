# 2026-07-18 LOS pi Harness 能力与可操作性审计

## 结论

LOS 可以被称为一个项目自有的 **agent execution evidence and governance
harness**：它能发起 agent run，约束工具权限，持久化 run/session/tool/verification
证据，支持计划审批、恢复、回放、provider gate、节点调度和 operator 控制。

LOS 不能等同于完整的 **pi-style interactive coding harness**。pi 的产品中心是
单个终端进程中的交互式 coding session、TUI、session tree、扩展、RPC 和 SDK；
LOS 的产品中心是 gateway、PostgreSQL、executor、Web/CLI/MCP 入口及持久化治理。
新增 stdio MCP 接口缩小了外部 agent 嵌入差距，managed jj workspace 增加了任务
隔离和备份证据，但两者仍未提供 pi 的 TUI/SDK 扩展体验，也未提供完整 swarm 的
自动创建、并行执行、冲突处理和 merge 流程。

证据标记：

- `[E]`：由本轮命令、测试、HTTP 响应或数据库记录验证。
- `[I]`：实现和测试存在，但本轮未消耗真实 provider、渠道或远端节点做 live run。
- `[U]`：当前没有足够实现或运行证据，不能作为现有能力宣传。

## 审计范围与证据

本轮以实现作为当前行为，以 contract/ADR 作为设计约束，并检查以下表面：

1. `contracts/`、`packages/agent`、`packages/gateway`、`packages/cli`、
   `packages/web`、executor 和 channel packages。
2. `README.md`、operations runbook、agent workflow roadmap、Hermes 对照文档。
3. 本地 pi 参考副本 `projects/pi/packages/coding-agent/README.md`。
4. Hermes Agent 官方文档和官方 GitHub 仓库，读取日期为 2026-07-18：
   - <https://hermes-agent.nousresearch.com/docs/>
   - <https://hermes-agent.nousresearch.com/docs/user-guide/features/tools>
   - <https://github.com/NousResearch/hermes-agent>
5. 本轮验证：`pnpm check`、`pnpm run gate`、agent/gateway/CLI package tests、
   gateway/executor health、migration 039 记录及 managed workspace list。

## 当前实际能力

| 能力 | 当前可执行行为 | 用户入口 | 判断 |
| --- | --- | --- | --- |
| 本地安装与就绪检查 | 检查 Node、pnpm、依赖、配置、PostgreSQL、auth、provider、project、channel、node 和外部工具；可幂等启动 gateway/executor | `pnpm run setup`、`los setup`、Web `Setup` | `[E]` |
| 直接 agent run | 选择 provider/model、workspace、tool mode、fallback policy，流式接收 session/run/task 结果 | `los chat` / `los run`、Web `Chat`、`POST /chat`、MCP `los_run` | `[I]`：入口和 harness 已验证，本轮未新跑付费 provider |
| 工具执行 | read/search/edit/patch/shell 等 coding tools 经 registry 和 L0/L1/L2 policy 执行；stdio MCP tools 可注入同一 registry | agent loop、MCP server registration | `[E]`：deterministic fixture；外部 MCP 凭据 transport 见下文限制 |
| Run contract | 持久化 mode、goal、plan、editable surfaces、required checks、stop conditions 和 evidence requirement | run API、`los run inspect/state/approve/revise-plan`、Web `Runs` | `[E]` |
| Operator 控制 | steering、follow-up、approve/reject、cancel、verify 和 recovery action 使用独立 operator credential | Web Chat/Runs、session operator API、MCP `los_operator_control` | `[E]` |
| 状态与回放 | PostgreSQL 持久化 task runs、session events、tool states、verification records；提供 state projection 和 cursor replay | `los run state/replay`、Web Sessions/Runs、MCP `los_run_state/los_run_replay` | `[E]` |
| 验证门 | plan 未持久化不能执行；required verification 未通过不能标记 succeeded；状态变化走统一 transition API | scheduler、run verification API/CLI/Web | `[E]` |
| Provider 治理 | discovery 与 compatibility evidence 分离；支持 dry-run/execute probe、显式 fallback、promotion decision 和 enforcement | `los provider`、`los compat`、Web Providers | `[E]`：决策路径；每个 provider 的当前 quota/兼容性仍需独立 live probe |
| Session 与 memory | session 继续/分支、trace、observability、compaction、retrieval、active rules 和 procedural candidate 证据 | Web Sessions/Memory、`los memory`、session APIs | `[E]`：store/API；长期质量仍需 eval |
| Planner/executor/verifier 图 | 持久化 graph/task/dependency/attempt/lease，scheduler 执行 executor 并由 verifier gate 判定完成 | graph/read APIs、scheduler、Web Runs | `[E]`：tests 和既有 smoke；本轮没有新建真实 provider graph |
| Managed jj workspace | 为已有 queued executor task 规划和分配隔离 workspace；保存 `jj diff --git` artifact；精确确认后 release | `los workspaces plan/apply/list/inspect/backup/release`、HTTP API | `[E]`：临时 jj repo flow、route/auth/CLI tests、migration 039 live；真实工作区只做只读 list |
| 节点与 artifact | executor registry、probe、drain/promote/restart/upgrade/rollback command evidence；artifact put/get/list/delete | `los nodes`、`los artifacts`、Web Nodes、HTTP API | `[E]`：tests 和当前 local executor health；远端节点本轮未重测 |
| Skills 分发 | inspect 后按 hash apply，保留 version/history，支持 pin/rollback | Web Skills、skill HTTP API | `[E]` |
| MCP 分发 | inspect/apply/verify/enable/pin/rollback；deny 优先的 tool policy | Web MCP Servers、MCP HTTP API | `[E]`：无认证 stdio；credential ref/OAuth/SSE/streamable HTTP 尚不可执行 |
| 外部 agent 接口 | 以 MCP stdio 暴露 run/state/replay/operator 四个窄工具，不直接写 DB 或绕过 gateway | `los mcp serve`、`los-mcp` | `[E]`：initialize/tools-list、state/replay smoke 和 CLI tests |
| Web operator console | Setup、Chat、Sessions、Runs、Providers、Skills、MCP、Nodes、Memory 等页面；auth token 持久化和 operator 403 恢复 | Web hash routes | `[E]`：Playwright operator-path E2E |
| 消息渠道 | Telegram、WeChat 具备配置 preflight、health、operator event consumption 和 reconnect | `pnpm run channels:*` | `[I]`：package/lifecycle tests 通过；当前 runtime 两者均为 disabled |
| Evals 与治理 | 记录/汇总/比较 eval，导入脱敏 external summary，执行 todo reconciliation、runtime cleanup 和 governance sweep | `los evals`、`los external-summaries`、`los governance` | `[E]`：CLI/store/tests；不是外部原始 transcript 回放 |

## 用户可操作路径

### 1. 首次启动

```bash
pnpm install
pnpm run setup
./bin/los setup
pnpm run status
```

先把 `los setup` 的 configured、ready、compatibility evidence 分开看。发现 provider
不代表该 provider 已通过当前模型和 tool-call 合约。

### 2. 发起与继续任务

```bash
los chat --provider deepseek --workspace . "inspect this repo"
los chat --resume SESSION_ID "continue the verified next step"
los run state RUN_ID
los run replay RUN_ID --since 50
```

Web 用户从 `Setup -> Chat -> Runs/Sessions` 操作。需要写文件时选择 project-write
并提供 operator credential；`all` 是更高权限模式，不是 MCP adapter 的可用模式。

### 3. 审批、验证与恢复

```bash
los run inspect RUN_ID
los run approve RUN_ID --reason "plan reviewed"
los run verify RUN_ID
los run recover RUN_ID
```

审批只允许进入执行阶段，不等于验证通过。最终 succeeded 仍取决于 required
verification records。

### 4. 从外部 editor/agent 调用 LOS

配置 host 启动 `los mcp serve` 或 `los-mcp`，然后调用：

```text
los_run -> los_run_state -> los_run_replay
                           -> los_operator_control (仅 operator action)
```

每次调用显式传 `projectId`。凭据通过 host secret/env 注入，不放进 tool argument。

### 5. 导入 Skill 和 MCP Server

Web Skills 使用 `inspect -> apply -> pin/history/rollback`。Web MCP Servers 使用
`inspect -> apply(disabled) -> verify -> enable -> pin/history/rollback`。当前只有
`authConfig.mode=none` 的 stdio server 是正式执行路径。

### 6. 隔离 graph task

```bash
los workspaces plan GRAPH_ID --project PROJECT_ID
los workspaces apply GRAPH_ID --project PROJECT_ID --tasks TASK_A,TASK_B
los workspaces inspect WORKSPACE_ID
los workspaces backup WORKSPACE_ID
los workspaces release WORKSPACE_ID --confirm WORKSPACE_ID
```

该路径只接收已有 graph 中的 queued executor task，并要求非空 editable surfaces。
release 先创建 artifact backup，再 forget/remove 已登记目录。集成 patch 仍由 operator
使用正常 jj 流程完成。

### 7. 渠道与运行诊断

```bash
pnpm run channels:status
pnpm run doctor
los health
los provider list
los compat --execute --workspace . --target PROVIDER:MODEL --probe read-context
```

channel 的 process health、gateway stream ready 和 external delivery ready 是三个不同
状态。当前本机 Telegram/WeChat 为 disabled，不能据 package tests 宣称真实消息已送达。

## 与 pi 的判断边界

本地 pi 参考副本把自己定义为 minimal terminal coding harness，并提供 interactive、
print/JSON、RPC 和 SDK 四种模式。其核心用户路径还包括 TUI editor、steering/follow-up
queue、session tree/fork/clone、extensions、skills、prompt templates 和 packages。

LOS 已覆盖的 pi-like 原语包括：agent loop、coding tools、provider/model 选择、流式输出、
steering/follow-up、session persistence、compaction、skills 和程序化调用。LOS 还比 pi
默认路径增加了 PostgreSQL evidence、run contract、verification gate、node registry 和
operator authorization。

但下面四项决定了 LOS 还不能直接称为 pi harness 的等价实现：

1. 没有成熟的单进程交互式 TUI，CLI 主要是 gateway client。
2. 没有与 pi SDK/RPC 同等宽度的嵌入 API；LOS MCP 目前只有四个有界工具。
3. 没有 pi extension/package 级别的 UI、command、provider 和 session lifecycle 扩展面。
4. session 分支和 run 治理可用，但没有 pi session tree 那种终端内直接导航体验。

因此更准确的表述是：**LOS 是具备 pi-like coding execution primitives 的持久化治理
harness，而不是 pi interactive coding harness 的替代实现。**

## 与 Hermes Agent 的差距

以下 Hermes 能力来自其 2026-07-18 官方文档。它们是对照输入，不是 LOS 依赖。

| 表面 | Hermes 当前公开能力 | LOS 当前状态 | 缺口判断 |
| --- | --- | --- | --- |
| 安装与交互 | installer/desktop、完整 TUI、slash commands | source checkout setup、Web console、非交互式 client CLI | `[U]` packaged desktop/TUI |
| 运行 backend | local、Docker、SSH、Daytona、Singularity、Modal | local gateway/executor、节点 HTTP/SSH command、local jj workspace | `[U]` backend abstraction、serverless persistence、cross-host workspace handoff |
| 消息平台 | 官方列出 20+ messaging platforms | Telegram、WeChat 两个受管 channel | `[I]` 当前两个 channel 也未做 live delivery；平台广度差距明显 |
| 工具广度 | 60+ tools，含 browser、media、Home Assistant、cron、delegation | coding tools、web tools、MCP、artifact、node、memory、governance | `[U]` consumer integration、browser/media 产品级覆盖 |
| 学习与记忆 | 自动 skill creation/self-improvement、session search、用户模型 | persistent memory、compaction、procedural candidates、operator-gated skill distribution | `[U]` 自动 skill 生成/改进和用户模型；LOS 当前刻意要求 promotion consent |
| 委派与并行 | isolated subagents、delegate tool、kanban workers | planner/executor/verifier graph、lease、scheduler、managed jj workspace | `[I]` 底层调度原语存在；缺少统一的 create/watch/integrate swarm 用户路径和自动 merge |
| 自动化 | 用户可配置 cron 并投递到各平台 | governance jobs、scheduler、todo dispatch | `[U]` 通用自然语言 cron 与多渠道 delivery 产品路径 |
| MCP | 消费 MCP server 并配置 toolsets | 消费 MCP；另将 LOS run control 暴露为 MCP | `[E]` stdio/no-auth；LOS credential resolver 和 HTTP transports 仍缺失 |
| 研究输出 | batch processing、trajectory export、RL workflow | trace/replay、eval、external summary | `[U]` batch trajectory/export/RL integration |
| 安全与证据 | command approval、authorization、container isolation | access/operator 分权、tool policy、run/verification/outbox evidence | `[E]` LOS 在项目审计证据上更强；container backend 广度更弱 |

## 已处理 Todo

本次 operability gap group 按依赖完成了以下子项：

1. CLI node auth 与 shared HTTP auth。
2. live steering/follow-up consumption。
3. Web operator E2E 与 setup onboarding。
4. provider fallback contract。
5. Telegram/WeChat lifecycle。
6. Skill/MCP distribution lifecycle。
7. programmatic MCP agent interface。
8. managed jj workspace operations。

这些任务修复的是 LOS 自身已有架构中的可操作性缺口，不构成对 pi/Hermes 全功能
复刻的承诺。

## 仍需决策或验证

1. `[U]` managed workspace 的自动 merge、冲突解决、跨主机 handoff 和 active session
   transfer 仍未实现。
2. `[U]` 完整 swarm 还缺 operator-facing graph create/watch/integrate 流程；现有能力以
   graph/scheduler API 和运行证据为中心。
3. `[U]` MCP `credential_ref`/OAuth resolver、SSE 和 streamable HTTP transport 仍然
   fail closed。
4. `[I]` provider、远端 executor、Telegram 和 WeChat 的 live 能力必须分别用当前
   credential/quota/node/channel 做 smoke，不能从配置或测试推断。
5. `[U]` pi-style TUI/SDK/extensions 和 Hermes-style broad backends/channels/autonomous
   learning 属于产品方向选择，实施前应先有 ADR 和范围批准。
6. `[I]` `pnpm check:migration-drift` 本轮被本地 PostgreSQL 角色缺少 `CREATE DATABASE`
   权限阻断；migration 039 已在实际 runtime DB 应用，但 migration-vs-ensure 结构差异
   仍需在 CI 或具备 CREATEDB 的隔离 PostgreSQL 上验证。

## 本轮验证记录

- `pnpm --filter @los/agent test`：732 pass、1 existing skip、0 failure。
- `pnpm --filter @los/gateway test`：exit 0。
- `pnpm --filter @los/cli test`：29/29 pass。
- `pnpm check`：exit 0；20 contracts；state-machine、wiring、channel lifecycle 通过。
- `pnpm run gate`：9 phases、15 test tasks、0 failure、285 seconds。
- runtime：gateway 和 executor 为 managed/running/healthy。
- DB：`schema_migrations.seq=039`，name 为 `039_managed_workspaces.sql`。
- HTTP：`GET /health` 为 ready；`GET /managed-workspaces` 返回空数组。
- `pnpm check:migration-drift`：未完成，PostgreSQL `CREATE DATABASE` 权限错误
  `42501`。

