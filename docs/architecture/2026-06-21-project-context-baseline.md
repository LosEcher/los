# los 项目上下文盘点（项目审计 / 复盘 / 算法性能专项 基线）

> 盘点时间：2026-06-21
> 盘点对象：`/Users/echerlos/projects/los-workspace/projects/los`（workspace 下唯一活跃项目）
> 盘点方法：源码 + AST + 知识图谱（6167 nodes / 14520 edges，knowledge graph 已索引）
> 标注约定：所有事实仅基于仓库现有材料；无法从材料确认的字段统一标注「信息不足 / 假设 / 需要补充」

---

## 一、项目基本概况

### 1.1 项目身份

| 字段 | 值 | 来源 |
|---|---|---|
| 项目名 | **los** | `projects/los/AGENTS.md:1` |
| 副标题 | "Lightweight Agent Execution + Memory Management Platform" | `package.json:3`, `projects/los/README.md:3` |
| 类型 | 整合型 Agent 平台 / 单体 monorepo / TypeScript | `AGENTS.md:5` |
| 架构原则 | Modular Monolith + Contract-first + PostgreSQL-first | `AGENTS.md:8-15` |
| 仓库管理 | jj + git 双轨（`.jj/` + `.git/`），Forgejo PR（`LosEcher/review-…`） | `git log` 输出，`.forgejo/` 目录 |
| 当前 HEAD | `5966138 Merge pull request #72 from LosEcher/review-20260621-batched` | `git log -1` |
| 工作空间角色 | `los-workspace/` 7 项目中**唯一活跃项目**，其余 `lsclaw / vpsagentweb / los-ast / los-memory / pi / aigluetoolset` 均为历史参考源 | `WORKSPACE.md:8, AGENTS.md:5` |

### 1.2 业务领域与目标

- **核心目标**：本地化、可观测、可审计的 Agent 执行 + 记忆管理平台；项目自身声明「los owns the project-specific runtime evidence when a claim depends on task execution, session events, node state, or provider gates」。
- **服务对象**：当前为「单开发者 + 多工具」使用模式（开发者本人即操作员 + 终端用户），支撑 high-autonomy agent workflows（`docs/governance/agent-workflow-roadmap.md`）。
- **设计参照**（只读参考）：Codex、OpenCode、JiuwenSwarm、Hermes、ZeroClaw、IronClaw、pi、lsclaw、vpsagentweb、los-memory（`AGENTS.md:6, 303-318`）。

### 1.3 项目规模

| 维度 | 数值 | 来源 |
|---|---|---|
| 包（packages/）数量 | 11：`agent / cli / executor / gateway / infra / input-preprocessor / media / memory / telegram-bot / web / wechat-bot` | `projects/los/packages/` |
| 总 TS/TSX 文件 | ~474（400 `.ts` + 26 `web/src` `*.tsx` + 子目录统计差异） | 知识图谱 `languages.file_count` + `ls packages/*/src` |
| 总代码行数 | **119,575 行** | `find packages/ -name '*.ts' -o -name '*.tsx' \| xargs wc -l` |
| 包级别行数 | agent 46,795 / cli 4,115 / executor 2,823 / gateway 13,985 / infra 2,419 / input-preprocessor 4,342 / media 993 / memory 5,211 / telegram-bot 423 / web 9,141 / wechat-bot 1,705 | `wc -l` 输出 |
| 测试文件数 | **100** 个 `.test.ts`/`.test.mjs` | `find` 统计 |
| 测试代码行 | **17,246** 行 | `find` 统计 |
| ADR 数 | 23 个（`0001` 至 `0023`） | `ls docs/adr/` |
| 治理文档 | 22 个 md + 1 个 manifest + 26 个 run-chain-changes | `docs/governance/` |
| 运行时运维 smoke | 18 个日期化操作记录 | `ls docs/operations/` |
| 契约（contracts/） | 11 个 OpenAPI/JSON Schema：`agent-task-graph / artifact-transfer / integration-feed-analysis / memory / node-command / node-registry / provider-compat-evidence / run-spec / run-stream / session-trace / todo-dispatch` | `ls contracts/` |
| 知识图谱节点 | 6,167（Function 2,187 / Section 1,115 / Variable 744 / File 584 / Module 584 / Interface 367 / Type 297 / Route 159 / Folder 89 / Method 28 / Class 7 / Channel 5 / Project 1） | `mcp__codebase-memory-mcp__get_architecture` |
| 知识图谱边 | 14,520（DEFINES 5,329 / CALLS 4,689 / USAGE 1,915 / IMPORTS 1,003 / CONTAINS_FILE 584 / SIMILAR_TO 432 / FILE_CHANGES_WITH 203 / CONTAINS_FOLDER 79 / HTTP_CALLS 62 / TESTS_FILE 62 / WRITES 60 等） | KG 输出 |
| 30 天内 commits | **389 个** | `git log --since="30 days ago"` |
| 月活/日活/QPS/RT | **信息不足**（无生产监控、APM 数据暴露在仓库内） | — |

### 1.4 完整技术栈

| 层级 | 技术 | 版本/说明 |
|---|---|---|
| 语言 | TypeScript | `^5.5.0`（devDep） |
| 包管理 | pnpm | `9.0.0`，workspace + `.pnpm-workspace.yaml` |
| Monorepo 构建 | Turborepo | `^2.0.0`（`turbo.json`） |
| 运行时 | Node.js | `>=20`（`engines.node`） |
| 数据库 | PostgreSQL | 唯一持久化后端（ADR 0001：single-node mesh） |
| DB 客户端 | `pg` (node-postgres) | `^8.16.3` |
| HTTP 服务端 | Fastify | `^5.0.0` + `@fastify/cors ^10` + `@fastify/static ^8` + `@fastify/websocket ^11.2` |
| 前端 | React 19 + Vite 5 + TanStack Query 5 + lucide-react + qrcode.react | `packages/web/package.json` |
| 验证 | Zod | `^3.23.0`（config schema） |
| WS | `ws` | `^8.21.0` |
| YAML | `yaml` | `^2.6.0` |
| Provider 协议 | OpenAI-compatible（DeepSeek / OpenAI / Groq / Together / Ollama / vLLM）、Anthropic Messages（Claude / MiniMax） | `packages/agent/src/providers/index.ts:7-17` |
| 进程内事件 | 自研 `event-bus.ts` + PG NOTIFY | `execution-store.ts` / `server-maintenance.ts` |
| SSE | Fastify SSE + WebSocket | `routes/streaming/` |
| HTTP 客户端 | 原生 `fetch` + `node:http` | — |
| CLI 框架 | 自研 args 解析（无 commander/yargs） | `packages/cli/src/index.ts` |
| 工具脚本 | bash（`tools/*.sh` 15 个） | — |
| 系统服务 | `deploy/systemd/` | systemd unit |
| 第三方监控 | OTel bridge（auto-start in `server.ts:357-363`） | `startOtelBridge` |
| 自研包 | `@los/{agent, cli, executor, gateway, infra, input-preprocessor, media, memory, telegram-bot, wechat-bot, web}` + root `los` CLI bin | `packages/*/package.json` |
| LLM model profile | 自研 `model-profiles.ts` + `model-settings.ts` + `cost estimation` | `packages/agent/src/model-profiles.ts` |

### 1.5 部署架构

- **运行形态**：模块化单体 + 独立 Executor 节点（`packages/executor` 是独立进程，独立 `package.json`）。
- **进程拓扑**：1 Gateway 进程（Fastify，端口默认 8080，可由 `SERVER_PORT`/`SERVER_HOST` 覆盖）+ N 个 Executor 进程（端口默认 8090，`EXECUTOR_PORT`）+ CLI 进程（`bin/los`）+ 可选 Telegram Bot / WeChat Bot / Media / OTel bridge（`server.ts:357` 自动拉起）。
- **容器化**：**信息不足**（仓库内无 Dockerfile / docker-compose.yml；只有 `deploy/systemd/`）。
- **CI/CD**：本地 turbo gate（`pnpm gate` = `./tools/ci-gate.sh`）+ Forgejo Actions（`.forgejo/`）+ GitHub Actions（`.github/workflows/ci.yml`）；最近 commit 含 `ci: adapt Forgejo workflow for local runner`。
- **环境隔离**：仅 dev/prod 区分（无显式 staging 环境）；通过 `LOS_PROFILE`、`~/.los/config.yaml`、`/etc/los/config.yaml` 分层（`AGENTS.md:127-141`）。
- **状态保持**：所有持久状态均在 PostgreSQL；进程崩溃通过 `task_runs` lease + `recoverExpiredTaskRunsWithAdvisoryLock`（`server.ts:310`）和 `recoverExpiredAgentTasksWithAdvisoryLock`（`server.ts:347`）恢复。
- **后台定时任务**（`server-maintenance.ts`）：orphan reaper 30s / 内存 retention+integrity+auto-compact 24h / governance sweep / 写入死信队列。

### 1.6 项目成熟度

- **当前阶段**：规模化迭代中（`Stage B` 部分实现，`Phase 1-4` 完成度参差），ADR 0021 明确标注「partially implemented early」已修复并对齐；ADR 0012 标注 Phase 1 ✅、Phase 2 基线 smoke only、Phase 4 部分实现、Phase 5-7 仍为 roadmap。
- **Self-Audit 状态**（来源：知识图谱 + docs/governance）：`docs/governance/2026-06-10-stage-a-exit-audit.md` / `2026-06-15-agent-workflow-harness-exit-audit.md` 均已落档。
- **生产部署**：**信息不足**（仓库内未发现线上 SLA / 客户案例 / SLA 文档；workspace 历史归档 `vpsagentweb` 含 6 节点 mesh + `docs/reference/rclonemana-archive/` 含 `HH_TO_34_MIGRATION_NOTES.md`，暗示曾有 34 节点迁移，但当前 los 是否仍承接此规模待确认）。

### 1.7 近 30 天重大变更（按 commit 顺序摘录）

来源：`git log --since="30 days ago" --oneline`（389 commits，最近 25 条摘要）

| 日期/序列 | 主题 | 影响范围 |
|---|---|---|
| `4b4b96e` | `chore(governance): split ga loop fixes and tighten structure baseline` | governance + structure check |
| `db9399c` | `fix(gateway): gate operator actions with operator token` | gateway 安全加固 |
| `ae62b94` | `fix(executor): report file sync folders and settle by mtime` | executor file-sync |
| `7085686` | `feat(agent): support ssh executor dispatch` | agent 调度能力扩展 |
| `48aa024` | `feat(agent): add unified message router and external runtime chat controls` | 入站路由统一 |
| `f5baf98`/`56ba75d` | `fix(executor): run initDb unconditionally regardless of heartbeat path` | executor 启动健壮性 |
| `5ed772b` | `feat: add Memory scope/ACL and promotion gate (#70)` | memory governance |
| `089362e` | `docs: analyze Codex handoff and remote workspace integrations` | 文档 |
| `b3eb8c0` | `feat: wire external runtime and communication routes` | gateway + communication |
| `6e1422a` | `feat: add media runtime package` | 新包 `@los/media` |
| `d7d1337` | `feat: add communication account and IM handoff channels` | 通道 |
| `d3ffae7` | `fix: secure operator runtime event streams` | 安全 |
| `8dd1320` | `feat: add external agent runtime control surfaces` | 控制面 |
| `cafe044` | `feat: add external agent runtime control surfaces` | 控制面（前置） |
| `4365609`/`ec07891` | `ci: adapt Forgejo workflow for local runner` | CI |

近半年整体演化主线（基于 `docs/governance/run-chain-changes/` + `docs/operations/` + 知识图谱）：

1. Stage A→B 推进（Operator Contract Layer） — ADR 0021
2. Memory governance 闭环（retention/integrity/auto-compact） — `2026-06-17`
3. P0 安全加固（settings auth bypass / `.env.bak` / chat rate limit / security headers / session 批写） — `2026-06-19`
4. File-sync P0（34 节点修复 + 报告 + mtime settle） — `2026-06-21`
5. 输入预处理器 `@los/input-preprocessor` — `2026-06-18`
6. Web Runtime Selector（los agent / Claude Code / Codex 三选一） — `2026-06-21`
7. WeChat Bot（Telegram 替代，WxPusher） — `2026-06-20`
8. OTel bridge（外部 agent telemetry 接入） — `2026-06-20`
9. Module Graduation（11/11 NAV live，0 partial） — `2026-06-20`

---

## 二、核心模块与组件清单

### 2.1 包清单与定位

| 包 | 路径 | 节点数 | 层（KG） | 定位 |
|---|---|---|---|---|
| `@los/infra` | `packages/infra/` | 91 | **core**（fan-in 497, fan-out 0） | 基础设施：PostgreSQL pool、Zod config、logger、discovery、migrations |
| `@los/agent` | `packages/agent/` | 1,044 | **internal**（fan-in 224, fan-out 309） | ReAct loop、provider 抽象、scheduler、task graph、tools、session、identity |
| `@los/memory` | `packages/memory/` | 78 | **internal**（fan-in 13, fan-out 60） | PostgreSQL FTS 记忆、observations、compaction、procedural candidates |
| `@los/gateway` | `packages/gateway/` | 211 | **entry**（HTTP/SSE/WS） | Fastify HTTP + React SPA + WebSocket + SSE |
| `@los/executor` | `packages/executor/` | 104 | **entry**（node process） | 独立执行器进程：runAgent、file-sync、node commands |
| `@los/cli` | `packages/cli/` | 243 | **entry**（CLI） | `bin/los` 命令行入口 |
| `@los/web` | `packages/web/` | 250 | UI | React 19 + Vite 5 SPA |
| `@los/input-preprocessor` | `packages/input-preprocessor/` | 72 | 内嵌依赖 | 通用输入降噪管道（log/code/error/config/mixed） |
| `@los/media` | `packages/media/` | （KG 未列出） | 新建包 | 媒体 runtime（TTS/image/video） |
| `@los/telegram-bot` | `packages/telegram-bot/` | （KG 未列出） | 独立进程 | Telegram IM handoff bot |
| `@los/wechat-bot` | `packages/wechat-bot/` | （KG 未列出） | 独立进程 | 微信通道（WeClaw + WxPusher + 移动 web `/m/`） |
| `los`（root） | `/` | 29 | CLI 入口 | `bin/los` 包装 + 顶层 scripts |

### 2.2 模块依赖拓扑（知识图谱）

调用矩阵（按 call_count 排序，前 10）：

```
agent      → infra   309
gateway    → agent   177
memory     → infra    60
gateway    → infra    57
executor   → infra    57
los        → los-common 46   （root CLI → tools/los-common.sh）
executor   → agent    31
cli        → agent    16
cli        → infra    14
gateway    → memory   13
```

> 派生热点（fan-in 前 10）：`getDb`(268)、`query`(79)、`loadConfig`(46)、`getLogger`(46)、`exec`(46)、`initDb`(45)、`closeDb`(40)、`runtime-evidence-graph.warn`(38)、`info`(31)、`MCPStdioTransport.close`(27)。
> 结论：所有包向 `@los/infra` 单向收敛，`@los/agent` 是绝对内部枢纽（被 gateway + executor + cli 三向依赖）。`memory` 不依赖 `agent` 业务代码（仅 stores）。

### 2.3 模块分层（KG 自动识别）

| 名称 | 层 | 理由 |
|---|---|---|
| `infra` | **core** | high fan-in (497 in, 0 out) |
| `los-common` | **core** | high fan-in (46 in, 0 out) |
| `agent` | **internal** | fan-in=224, fan-out=309 |
| `memory` | **internal** | fan-in=13, fan-out=60 |
| `cli` / `gateway` / `executor` / `los` | **entry** | only outbound calls |
| 项目路由（`/projects/...`） | **api** | has HTTP route definitions |

> 派生 cluster（Leiden 社区检测前 5）：packages（220 成员，cohesion 0.59，含 `getDb/query/exec/warn/info`）、packages+streaming（149）、packages+web（144，cohesion 0.96，ChatPage/ProvidersPage）、packages（124，含 `runOperationCommand/main/chatCommand/withInitDb/governanceCommand`）、packages+tools（114）。

### 2.4 关键入口文件

| 角色 | 文件 |
|---|---|
| Gateway bootstrap | `packages/gateway/src/server.ts`（createServer + startServer） |
| Gateway route 编排 | `packages/gateway/src/server.ts:226-267`（按 categories 注册） |
| 路由目录树 | `packages/gateway/src/routes/{infrastructure,data,tools,streaming,providers,orchestration}/` |
| Chat route | `packages/gateway/src/chat-route.ts`（chat 业务主入口） |
| Agent loop | `packages/agent/src/loop.ts`（runAgent 主循环） |
| Loop 子模块 | `packages/agent/src/loop/{setup,phases,tool-runner,compression,utils,types,message-builder,phase-tool-gate,tool-resolver,token-utils}.ts` |
| Scheduler | `packages/agent/src/scheduler.ts` + `scheduler/{abort-registry,helpers,provider-selection,scheduled-task-runner,tool-call-state-persistence,verifier-task,types}/` |
| Provider 抽象 | `packages/agent/src/providers/{index,types,registry,anthropic,responses,openai-utils,delta-repair,telemetry,repair-telemetry}.ts` |
| Task graph | `packages/agent/src/agent-task-graph.ts` + `agent-task-graph-read-model.ts` + `agent-task-graph/lease.ts` + `agent-task-editable-surfaces.ts` |
| 执行状态机 | `packages/agent/src/execution-transitions.ts` + `execution-store.ts` + `run-contract.ts` |
| Executor 启动 | `packages/executor/src/index.ts`（startExecutor） |
| Executor routes | `packages/executor/src/{executor-routes,file-sync-routes,node-command-runner,file-sync/}.ts` |
| CLI | `packages/cli/src/index.ts` + 各 command 文件（`artifacts/compat/dead-letter/evals/external-summaries/governance/memory/cbm/node-commands/provider/scan/run-operations/help`） |
| Memory API | `packages/memory/src/index.ts`（导出 store + compaction + procedural） |
| Memory 主体 | `packages/memory/src/core/{store,compaction}.ts` + `procedures/` + `reflection/` + `transcript/` + `markdown.ts` + `normalizers.ts` |
| Config | `packages/infra/src/config.ts`（Zod schema）+ `db.ts` + `logger.ts` + `discovery.ts` + `migrate.ts` |

### 2.5 模块划分原则

- **按领域 + 按分层**双重：`AGENTS.md:8` 明确「Modular monolith — one Node process, but each package has enforceable import boundaries」。
- **强制约束**：`infra/` 是 cross-cutting concern 必经入口（DB、config、logger、provider discovery）；UI framework（React/Fastify）、build tool（Vite/tsc）、type system 可绕过（`AGENTS.md:11`）。
- **禁止规则**（`AGENTS.md:151-159`）：
  - `packages/infra/` 新文件需 package-level 批准
  - `packages/gateway/src/routes/` 才是 route 模块归属地；root 级 `*-routes.ts` 被 `tools/check-structure.sh` block
  - `packages/web/src/` 文件名不得与目录名同名（例：`api.ts` + `api/` 禁止，应用 `api/index.ts`）
  - **文件大小门禁**：> 400 行 warn、> 600 行 block（`AGENTS.md:16`，CI 强制）

### 2.6 对外暴露能力（按 packages exports 字段）

| 包 | 关键 sub-paths |
|---|---|
| `@los/agent` | `./loop` `./scheduler` `./session` `./session-events` `./task-runs` `./executor-nodes` `./service-instances` `./artifacts` `./node-commands` `./model-profiles` `./model-settings` `./compat-harness` `./todos` `./run-specs` `./stream-checkpoints` `./stream-lease` `./todo-seeds` `./run-evals` `./execution-transitions` `./execution-store` `./tool-call-states` `./mcp-servers` `./skills` `./rules` `./tools` `./tools/mcp-client` `./cancellation` `./agent-task-graph` `./providers/telemetry` `./providers/repair-telemetry` `./dead-letter` `./event-bus` `./runtime-adapter` `./pre-action-gate` `./message-router` |
| `@los/infra` | `./logger` `./config` `./db` `./discovery` `./migrate` `./procedural-candidates-ddl` |
| `@los/memory` | `.`（统一入口） |
| `@los/gateway` | `.` |
| `@los/executor` | `.` |
| `@los/cli` | `.` |
| `@los/web` | （构建产物） |

---

## 三、核心业务流程与算法场景

### 3.1 端到端核心链路

#### 3.1.1 Chat 链路（用户提交 prompt → 流式返回）

```
[入口]  HTTP POST /chat (Fastify)         ← packages/gateway/src/chat-route.ts
       ↓
[路由]  registerChatRoute(app, config, workspaceRoot, serviceId, chatLimiter.hook, messageRouter)
       ↓
[入站]  MessageRouter.process(message)     ← packages/agent/src/message-router/index.ts
       ├─ 5 builtin handlers + 8 commands
       ├─ 3 consumers (HTTP, SSE, IM)
       ↓
[鉴权]  authMiddleware + rate-limit (30 req/min) + security headers  ← server.ts:104-112
       ↓
[准备]  setupAgentRun → completeAgentSetup     ← packages/agent/src/loop/setup.ts
       ├─ 选 provider (registry + model profile + capability)
       ├─ 装 tools (read-only / project-write / all)
       ├─ 注册 MCP servers
       ├─ 组装 system prompt (identity loader)
       ↓
[预执行] runPreExecutionPhases                 ← packages/agent/src/loop/phases.ts
       ├─ self-check / discover / plan
       ↓
[主循环] runAgent (ReAct)                      ← packages/agent/src/loop.ts
       for i < maxLoops:
         ├─ provider.chat(messages, toolDefs)  ← OpenAI/Anthropic/Responses adapters
         ├─ emitEvent('model.turn.started')
         ├─ emitEvent('model.response')
         ├─ if cache hit/miss: emitEvent('model.cache')
         ├─ context monitor (warn 60% / checkpoint 75% / critical 85%)
         ├─ if no tool_calls: emitEvent('session.completed') → return
         ├─ else: runToolCalls(toolCalls)     ← packages/agent/src/loop/tool-runner.ts
         │     ├─ 工具策略 gate (phase-tool-gate.ts)
         │     ├─ policy eval
         │     ├─ 并行执行（AP1-修复后并行化）
         │     └─ 收集 tool_result
         ├─ 推入 messages
         ├─ mid-loop context compression       ← packages/agent/src/loop/compression.ts
         └─ continue
       maxLoops 到达 → 强制 summary turn
       ↓
[持久化] chat-route-persist.ts + chat-stream-persist.ts + tool-call-upsert.ts
       ├─ 写入 session_events (append-only ledger)
       ├─ 写入 tool_call_states (B0 验证前状态机)
       ├─ 写入 stream_checkpoints (SSE 断线重连)
       └─ 更新 task_runs + run_specs (通过 transitionExecutionState)
       ↓
[输出]  SSE 流 (text/event-stream) + 完成事件 session.completed
```

#### 3.1.2 Scheduler 任务图链路

```
[入口]  runAgentTaskGraphSerial(input)        ← packages/agent/src/scheduler.ts:60
       ↓
[准备]  ensureAgentTaskGraphStore + transitionExecutionState(run_spec → 'running')
       ↓
[循环]  while executedTasks.length < maxTasks:
       ├─ claimReadyAgentTasks(graphId, limit=batchLimit, nodeId=claimedBy, leaseMs, editableSurfaceMode)
       ├─ Promise.all → runClaimedAgentGraphTask
       │     ├─ resolveGraphTaskProviderModelSelection (能力匹配 + provider policy)
       │     ├─ recordSchedulerDecision (provider-selection ledger)
       │     ├─ createAgentTaskAttempt
       │     ├─ runScheduledAgentTask
       │     │   ├─ 判定 role: 'verifier' → runClaimedVerifierGraphTask
       │     │   ├─ 判定: planner/executor → runAgent loop
       │     │   ├─ 持久化 task_runs + tool_call_states
       │     │   ├─ B0 gate: canMarkSucceeded()（必须所有 verification succeeded/skipped）
       │     │   └─ emit SessionEvent（run.recovery_required / run.blocked / task.*）
       │     ├─ maybeQueueRecoveryFollowUp (recovery decision)
       │     ├─ updateAgentTaskStatus
       │     └─ createAgentTaskAttempt (final status)
       └─ if 任一 task failed 且非 recovery-follow-up: break
       ↓
[完成]  getAgentTaskGraphCompletion(graphId, {requireVerifier})
       ├─ applyGraphCompletionRunSpecTransition
       │     ├─ recovery.status === 'action_required' → run_spec → 'blocked'
       │     └─ completion.status → run_spec → 'succeeded'/'failed'/'blocked'/'running'
       ↓
[返回]  { graphId, executedTasks, completion, recovery }
```

### 3.2 主要业务场景

| 场景 | 触发 | 执行频次 | 入口 |
|---|---|---|---|
| Chat 流 | 用户消息到达 | 高（active 状态） | `POST /chat` |
| Tool 调用 | LLM 返回 tool_calls | 高 | `loop.ts:281` `runToolCalls` |
| Provider 兼容探测 | `pnpm run cli -- compat [--execute]` | 低（adhoc） | `cli/compat.ts` |
| Task graph serial | Agent 任务图入站 | 中 | `scheduler.runAgentTaskGraphSerial` |
| 死信回收 | `gateway_startup_recovery` / 定期 reaper | 低（每天/启动） | `server.ts:310` |
| Memory compaction | `registerServerMaintenance` 每 24h + chat-route 完成 | 中 | `memory/core/compaction.ts` |
| Memory retention/integrity | 同上每日 | 低 | `memory/core/retention.ts` + `memory/core/integrity.ts` |
| Governance sweep | `server-maintenance.ts` 周期 | 中 | `agent/governance-sweeper.ts` + `governance-jobs.ts` |
| File-sync 周期同步 | executor `startPeriodicSync` | 中（默认 1800s 间隔） | `executor/file-sync/periodic.ts` |
| OTel bridge | gateway 启动时拉起 | 常驻 | `agent/runtime-adapter` |
| Orphan reaper | 30s 周期 | 高频 | `server-maintenance.ts:23-32` |
| Service heartbeat | 10s 周期 | 高频 | `server.ts:386-387` |
| SSH executor dispatch | agent 检测到 ssh executor 时 | 低 | `agent/loop/setup.ts` + executor command |
| WeChat/Telegram handoff | IM 通道有新事件 | 低 | `wechat-bot/index.ts` + `telegram-bot/src/index.ts` |
| Auto-compact memory | `server-maintenance.ts` 24h | 低 | 内部 compactSession |

### 3.3 算法 / 计算逻辑 / 调度 / 匹配

#### 3.3.1 Provider 选择算法（`agent/scheduler/provider-selection.ts`）

- **用途**：为 graph 任务选最合适 provider/model。
- **时机**：每次 `runClaimedAgentGraphTask`。
- **复杂度**：未知（**信息不足**，需直接阅读 `provider-selection.ts` 才可给出精确复杂度）。

#### 3.3.2 编辑面冲突检测（`agent-task-editable-surfaces.ts`）

- **暴露**：`selectEditableSurfaceCompatibleTasks` / `editableSurfacesForAgentTask` / `editableSurfacesOverlap` / `normalizeEditableSurfaceMode`。
- **用途**：防止多个 task 同时修改同一可编辑面。
- **时机**：scheduler 领取任务前判定。
- **复杂度**：未知（需阅读实现确认）。

#### 3.3.3 状态机转移评估（`execution-transitions.ts`）

- **用途**：校验 `run_spec / task_run / tool_call_state / verification_record` 四类实体状态转移合法性。
- **时机**：每次 `transitionExecutionState`。
- **复杂度**：O(1)（查表）。
- **关键表**（直接读自 `execution-transitions.ts:32-67`）：
  - `run_spec`: created→{running, cancelled}; running→{succeeded, failed, cancelled, blocked}; blocked→{running, failed, cancelled}; 终态 succeeded/failed/cancelled。
  - `task_run`: queued→{running, cancelled}; running→{succeeded, failed, cancelled, blocked}; blocked→{running, failed, cancelled}; 终态同上。
  - `tool_call_state`: requested→{approved, denied, running, skipped}; approved→{running, denied, skipped}; running→{succeeded, failed, retrying, skipped}; retrying→{running, failed, skipped}; failed→{retrying}; 终态 succeeded/denied/skipped。
  - `verification_record`: required→{running, skipped}; running→{succeeded, failed, skipped}; failed→{running, skipped}; 终态 succeeded/skipped。
- **终止态**：`run_spec/task_run` = succeeded/failed/cancelled；`tool_call_state` = succeeded/denied/skipped；`verification_record` = succeeded/skipped。

#### 3.3.4 执行阶段机（run-contract.ts — 10-state）

- **状态序列**（`docs/adr/0021-stage-b-operator-contract-implemented-state.md`）：
  ```
  created → discovering → discovery_ready
         → planning    → plan_approved
         → executing   → verifying
         → succeeded | blocked | failed
  ```
- **门禁**：`canStartExecution(contract)` 要求 phase ∈ {`plan_approved`, `executing`}；`canMarkSucceeded(contract, verificationStatuses)` 要求所有 verification ∈ {succeeded, skipped}。
- **AP2/AP3 防漂移**：plan 必须写入 `run_specs.run_contract_json`（AP2）；succeeded 前必须过 `canMarkSucceeded`（AP3）。

#### 3.3.5 Memory 检索（`memory/core/store.ts`）

- **用途**：FTS 检索 + JSONB 多 facet 过滤。
- **DB 实现**：PostgreSQL tsvector + GIN index。
- **过滤维度**：q / kind / source / tag / scope / memoryLayer / archived / sessionId / tenantId / projectId / userId / requestId / traceId / limit（1-200）。
- **复杂度**：FTS 查询复杂度视索引而定，**信息不足**（需具体 EXPLAIN 才可量化）。

#### 3.3.6 Memory compaction + procedural candidate

- **触发**：手动 `compactSession(sessionId)` 或自动 compact（每天 + chat 完成）。
- **输出**：`memory_compactions`（含 `transcript_brief_json` 字段，migration 012）+ `procedural_candidates`（需 operator 审核后 promote，ADR 0020）。
- **复杂度**：未知。

#### 3.3.7 Input preprocessing（`@los/input-preprocessor`）

- **5 种内容检测器**：log / code / config / error / mixed。
- **降噪管线**：`tokenize → classifier → deduplicator → compressor → safety check`。
- **复杂度**：线性 O(n)（基于 token 流）；detectors 是正则匹配，**信息不足**（未量化常数）。

#### 3.3.8 Tool 策略门（`loop/phase-tool-gate.ts`）

- **行为**：基于 `runContract.phase` 拒绝不在允许阶段的工具（AP1/3 防御层）。
- **时机**：tool 实际执行前。

#### 3.3.9 Context fill monitor（`loop.ts:97-138` + `context-monitor.ts`）

- **三级阈值**：warn 60% / checkpoint 75% / critical 85%（默认，可被 `contextMonitor` 覆盖）。
- **动作**：emit `context.fill.warn/checkpoint/critical` event；触发 mid-loop compression。

### 3.4 核心数据实体

#### 3.4.1 数据库表（12 个迁移文件 → 至少 15 张表）

迁移文件清单与对应表：

| Migration | 新增/变更表 | 关键字段 |
|---|---|---|
| `001_sessions.sql` | `sessions` | id, tenant_id, project_id, user_id, request_id, trace_id, messages JSONB, turns JSONB, metadata JSONB |
| `002_task_runs.sql` | `task_runs` | id, session_id, run_spec_id, trace_id, dedupe_key, tenant_id, project_id, user_id, node_id, request_id, prompt_preview, tool_mode, provider, model, metadata_json, status, attempt, started_at, completed_at, heartbeat_at, lease_expires_at |
| `003_session_events.sql` | `session_events` | id SERIAL, session_id, tenant_id, project_id, user_id, node_id, request_id, trace_id, type, turn, source, model, tool_name, visibility, payload JSONB + 索引 `(session_id, id)`、`(session_id, type)` |
| `004_status_constraints.sql` | task_runs/run_specs/etc status CHECK constraints (NOT VALID) | status ∈ `queued/running/succeeded/failed/cancelled/blocked` |
| `005_file_sync.sql` | `file_sync_folders` / `file_sync_entries` / sync event log | folder_id, local_path, scan_interval_sec (默认 1800), settle_window_sec (默认 900), node_id, size, version_vectors |
| `006_procedural_candidates.sql` | `procedural_candidates` | id, name, content, severity, rationale, confidence NUMERIC, status (`draft/candidate/reviewed/confirmed/rejected`), compaction_id, session_id, evidence_json |
| `007_governance_jobs.sql` | `governance_jobs` | id, job_type, cadence, status, config_json, last_run_at, last_task_run_id, result_summary_json, dedupe_key |
| `008_static_graph_baselines.sql` | `static_graph_baselines` | id, label, graph_json, node_count, edge_count, captured_by, captured_at, previous_baseline_id + 索引 |
| `009_governance_jobs_evolve.sql` | `governance_jobs` 加列（status 替代 enabled） | `ADD COLUMN IF NOT EXISTS status` + 数据迁移 `enabled=false → status='paused'` |
| `010_dead_letter_events.sql` | `dead_letter_events` | id, task_run_id (FK→task_runs ON DELETE SET NULL), run_spec_id (FK→run_specs ON DELETE SET NULL), reason, original_error, event_payload JSONB, acknowledged_at + 索引 |
| `011_artifact_status.sql` | `artifacts` 加列 | `status TEXT DEFAULT 'draft'` + `confidence DOUBLE PRECISION DEFAULT 0.5` + 索引 `idx_artifacts_status` |
| `012_transcript_brief.sql` | `memory_compactions` 加列 | `transcript_brief_json JSONB` |

#### 3.4.2 隐含但存在的表（从代码引用倒推）

- `run_specs`（004 constraint + scheduler `transitionExecutionState({entityType:'run_spec'})`）
- `tool_call_states`（execution-store + scheduler）
- `verification_records`（run-contract + verification-records.ts）
- `executor_nodes`（executor-nodes.ts + ensureExecutorNodeStore）
- `service_instances`（service-instances.ts + heartbeat）
- `idempotency_keys`（idempotency.ts）
- `todos`（todos.ts + seed）
- `skills`（skills.ts + seed）
- `rules`（rules.ts + seed）
- `mcp_servers`（mcp-servers.ts）
- `artifacts`（artifacts.ts，已在 011 增强）
- `provider_compat_evidence`（provider-compat-evidence.ts）
- `run_evals`（run-evals.ts）
- `stream_checkpoints`（stream-checkpoints.ts）
- `observations`（memory store，server-maintenance.ts SQL 查询佐证）
- `memory_compactions`（memory core，迁移 012 引用）
- `agent_tasks` / `agent_task_attempts` / `agent_task_edges`（agent-task-graph.ts）

> 备注：上述未在迁移文件中显式建表的实体，其 DDL 大概率写在 `agent/*.ts` 的 `ensure*Store()` 中（与 `test-setup.ts:23 stores` + memory cross-dep 注释吻合）。**信息不足**（需直接 grep `ensure*Store()` 实现确认 DDL 细节）。

#### 3.4.3 核心枚举

- `ExecutionEntityType` = `run_spec | task_run | tool_call_state | verification_record`
- `TaskRunStatus` = `queued | running | succeeded | failed | cancelled | blocked`
- `ToolCallStateType` = `requested | approved | denied | running | succeeded | failed | retrying | skipped`
- `VerificationRecordStatus` = `required | running | succeeded | failed | skipped`
- `RunPhase`（10 值，run-contract.ts）：`created | discovering | discovery_ready | planning | plan_approved | executing | verifying | succeeded | blocked | failed`
- `RunContractMode` = `audit | execution | closeout | governance`
- `IdentityLevel`（ADR 0023） = `none | minimal | standard | full`
- `ExecutorNodeKind` = `executor | ssh_target | ingress | proxy`
- `ExecutorNodeConnectMode`（base）：`agent_http | agent_http_ndjson`，appendable: `socks5 | tailscale_ssh`（环境变量 EXECUTOR_CONNECT_MODES）
- `ProceduralCandidateStatus` = `draft | candidate | reviewed | confirmed | rejected`
- `GovernanceJobStatus` = `active | paused`（migration 009）

#### 3.4.4 主数据流转规则

1. **任务创建 → 完成**：
   ```
   POST /chat
     → session_events (session.started)
     → task_runs.status='queued' → 'running'
     → run_specs.phase='created' → ... → 'succeeded'
     → tool_call_states: requested → approved/running → succeeded
     → verification_records: required → running → succeeded/skipped
     → session_events: session.completed
   ```
2. **失败回退路径**：
   ```
   task_runs.status='failed' OR lease 过期
     → dead_letter_events (writeDeadLetterEvent, reason='lease_expired')
     → run_specs.status='blocked'（若需 operator attention）
     → session_events: run.recovery_required / task.failed
     → tool_call_recovery: action_required → recovery.follow-up attempt
   ```
3. **跨网关恢复**：
   ```
   gateway_startup_recovery（PG advisory lock 互斥）
     → recoverExpiredTaskRunsWithAdvisoryLock
     → recoverExpiredAgentTasksWithAdvisoryLock
     → orphan reaper 每 30s 重新认领 stale gateway 的 run_spec
   ```
4. **Memory 流转**：
   ```
   session_events (raw)
     → observations（按规则抽取）
     → memory_compactions（每 24h 或 chat 完成）
     → procedural_candidates（auto-discover，manual promote via ADR 0020）
   ```
5. **Provider promotion**：
   ```
   provider_compat_evidence (advisory)
     → provider_promotion_decisions (operator gate via ADR 0017)
     → verified_advisory → required / blocked
   ```

---

## 四、技术实现关键点

### 4.1 缓存

- **缓存类型**：**信息不足**（仓库内未发现 Redis/Memcached/LRU cache 显式使用）。
- **本地隐含缓存**：
  - `_pool: Pool | null`（`db.ts:23`，单例进程内）
  - Provider registry（`providers/registry.ts`，需阅读确认是否缓存）
  - Config `getConfig()`（`config.ts`，Zod 校验后导出单例）
- **PostgreSQL 自身**：作为事实缓存（`session_events`、`provider_compat_evidence` 表）。

### 4.2 消息队列 / 异步任务

- **PG NOTIFY**：`db.ts:116-118` `notify(channel, payload)` — 进程内 `event-bus.ts` 与跨进程通信机制。
- **Redis 队列**：**信息不足**（仓库内无 Redis 客户端依赖；用户全局规则 `redis-queue-patterns` 提示可能引用，但当前 los 实现未使用）。
- **Executor 队列**：`executor_nodes.queue_depth` + `active_task_count` 在 `executor-nodes.ts`（执行器调度）。
- **Open package API**：
  - `cancelScheduledTask`（scheduler/abort-registry.ts）
  - `persistScheduledToolCallState`
  - `runScheduledAgentTask`
- **后台定时器**（`server-maintenance.ts`）：
  - `setInterval` orphan reaper 30s
  - `setInterval` memory retention/integrity 24h
  - `setInterval` governance sweep
  - `setInterval` heartbeat 10s
- **异步任务类型**：
  - Provider compat probe (`compat-harness.ts`)
  - Eval backlog runner (`eval-backlog-runner.ts`)
  - Governance jobs (`governance-jobs.ts`)
  - File-sync periodic (`executor/file-sync/periodic.ts`)
  - Review runner (`review-runner.ts`)

### 4.3 状态机 / 流程编排

- **4 套状态机**：
  1. `run_spec` status + `run_spec.phase`（10-state）— ADR 0021 强制统一
  2. `task_run.status`（6-state）
  3. `tool_call_state.state`（8-state，含 retrying）
  4. `verification_record.status`（5-state）
- **统一入口**：`transitionExecutionState({entityType, entityId, to, reason, ...})`（AP1 强制）
- **串行/并行**：
  - Tool 执行：`runToolCalls` 支持并行（修复了 2026-06-19 P0 修复中的 tool 并行化）
  - Task graph：`runAgentTaskGraphSerial` 支持 `maxParallelTasks > 1`（默认 1），parallel > 1 时强制 `editableSurfaceMode='require-declared'`
  - Provider 选择：并行尝试 N 个候选项（**信息不足**）
- **顺序执行实现**：
  - Loop 顺序：`runPreExecutionPhases` → 主 for-loop（单流）
  - Scheduler 顺序：`claimReadyAgentTasks` → `Promise.all` 并行执行 → `getAgentTaskGraphCompletion`
  - Gateway 启动顺序（`server.ts:281-401`）：
    ```
    initDb → migrateDir → ensureTodoStore → ensureIdempotencyStore →
    ensureExecutorNodeStore → ensureServiceInstanceStore → heartbeat →
    ensureTaskRunStore → ensureRunSpecStore → ensureAgentTaskGraphStore →
    ensureMemoryStore/Compaction/Procedural → recoverExpiredTaskRunsWithAdvisoryLock →
    recoverExpiredAgentTasksWithAdvisoryLock → seedLosPlanningTodos → seedSkills/Rules →
    startOtelBridge → printOnboardingReport → printConfigDiagnostics →
    CBM check → createServer → setInterval heartbeat → registerServerMaintenance → listen
    ```

### 4.4 存储架构

- **数据库类型**：PostgreSQL（唯一，ADR 0001）。
- **连接池**：pg Pool，`max: 20`，`connectionTimeoutMillis: 5000`，`idleTimeoutMillis: 10000`，`allowExitOnIdle: true`（`db.ts:39-45`）。
- **测试隔离**：`isSafeTestDatabaseUrl` 强制 DB 名匹配 `test|_test|-test`；否则 `LOS_ALLOW_LIVE_TEST_DB=1` 显式 opt-in（`db.ts:74-83`）。
- **分库分表**：**信息不足**（仓库内未发现 explicit shard/partition 策略；ADR 0001 强调 single-node 但 mesh-ready）。
- **冷热数据归档**：`memory.applyRetentionPolicy` 自动 archive + delete（24h 周期）。
- **文件存储**：
  - Artifact：`ARTIFACT_STORAGE_ROOT = join(WORKSPACE_ROOT, '.los-runtime', 'artifacts')`（`server.ts:83`）+ executor 端 `executorArtifactStorageRoot(nodeId)`
  - 运行时日志：`.los-runtime/gateway.log` + `.omx/logs/omx-<date>.jsonl`
  - File-sync folders：本地路径，`scan_interval_sec` 默认 1800s，`settle_window_sec` 默认 900s
- **读写分离**：**信息不足**（仓库内未发现显式 read replica 配置；PG advisory lock 用于跨进程协调而非读写分离）。

### 4.5 内存管理

- **单例全局对象**：
  - `_pool`（db.ts）
  - `config` 单例（config.ts）
  - Logger 实例（logger.ts）
- **大对象**：
  - `messages: Message[]`（loop 主循环里 in-place 修改，使用 `compressOrTrimMessages` 中段压缩）
  - `turns: TurnSummary[]`
  - `cacheHitTokens / cacheMissTokens` 累计
- **内存缓存**：见 4.1
- **定时常驻**：`setInterval` 在 `server.ts:386`（heartbeat 10s）、`server-maintenance.ts`（reaper 30s + memory 24h）。
- **MCP 客户端连接**：进程内连接池（`tools/external/mcp-client.ts`），`MCPStdioTransport.close` fan-in 27，热点之一。

---

## 五、性能、监控与运维

### 5.1 现有性能指标

- **Token 累计**：`loop.ts` 中 `totalPromptTokens / totalCompletionTokens / totalCacheHitTokens / totalCacheMissTokens / totalCostUsd`。
- **Context fill**：`createContextMonitor` 实时监控 `fillPercent / level / usedTokens / turn`（warn 60% / checkpoint 75% / critical 85%）。
- **Cost estimation**：`estimateCost(usage, profile)` in `model-profiles.ts`，输出 `totalCostUsd / cacheSavingsUsd`。
- **Cache hit inference**：`inferCacheHit(usage)`（loop.ts）。
- **延迟**：`provider.chat()` 计时 `modelStartedAt / modelDurationMs`（loop.ts:156-171）。
- **DB / 网络 QPS / 平均 RT**：**信息不足**（仓库内无 APM exporter / Prometheus metrics 暴露）。

### 5.2 已知性能瓶颈 / 慢接口

- **代码审查基线**：`docs/governance/file-size-governance-status-2026-06-18.md` 提示 30 文件超 400 行；`check-structure.sh` warn 门禁 400、block 600。
- **API 调用热点**：KG hotspot 显示 `getDb(268)`、`query(79)`、`loadConfig(46)`、`getLogger(46)`、`exec(46)`、`initDb(45)`、`closeDb(40)`。**信息不足**（无调用分布与延迟统计）。
- **复用过深**：`MCPStdioTransport.close` fan-in 27，可能为连接泄漏点。
- **Memory 维护 SQL**（server-maintenance.ts）：compact + retention 全量扫表，**信息不足**（未量化表规模下的延迟）。

### 5.3 监控 / 日志 / 链路追踪 / 告警

- **日志系统**：`@los/infra/logger`（统一 logger，**信息不足**：未明确 winston / pino / 自研）。
- **链路追踪**：
  - 自研 session_events append-only ledger（`session_events` 表，所有动作可审计）。
  - OTel bridge（`runtime-adapter`，`startOtelBridge`，`server.ts:357` 自动拉起，端口信息不足）。
  - Trace ID 跨表字段：`session_events.trace_id` / `task_runs.trace_id` / `requests_id` / `request_id`。
- **Runtime evidence graph**（`runtime-evidence-graph.ts`）：记录 warn（fan-in 38）、构建可视化关系，触发 `tool-call-recovery.ts`。
- **OMX tool-level logging**：`.omx/hooks/los-omx-tool-logger.mjs` 捕获 `PreToolUse / PostToolUse`，写入 `.omx/logs/omx-<date>.jsonl`。**仅记录元数据**（byte count、status、timing、exit code、command preview ≤200 字符），不存储 raw stdout/stderr / tool args / auth tokens。
- **告警体系**：**信息不足**（仓库内无 Alertmanager / PagerDuty / Slack webhook 配置；仅 `appendSessionEvent('run.recovery_required')` 触发 Telegram/WeChat handoff 投递）。
- **Health check**：
  - Gateway `GET /health` 返回 `{status, uptime, serviceId, serviceKind, ready, blockers}`
  - Executor `GET /health` 返回 node identity + liveness
- **Service heartbeat**：10s 周期写入 `service_instances` 表。
- **Service readiness**：`/ready` + `/live` + `/services` + drain + promote 路由存在（ADR 0012）。

### 5.4 近 30 天变更摘要

详见 §1.7；变更主轴：

1. Stage A→B Operator Contract Layer 收敛（ADR 0021）
2. Memory governance 闭环（retention/integrity/auto-compact + procedural candidates + scope/ACL）
3. P0 安全加固（settings auth bypass / `.env.bak` / chat rate limit / security headers / session 批写 / tool 并行化 / agent barrel 收紧）
4. File-sync P0（34 节点 fix + 报告 + mtime settle + SSH executor dispatch）
5. 输入预处理器 `@los/input-preprocessor`（P0 完成，P1/P2 14 项待办）
6. WeChat Bot（替换 Telegram 为 IM 主通道）+ OTel bridge + Runtime Adapter
7. Web Runtime Selector（los agent / Claude Code / Codex 三选一）
8. Module Graduation（11/11 NAV live，0 partial）

---

## 六、异常、权限与安全基础

### 6.1 统一异常处理

- **基础类**：`AgentError`（`packages/agent/src/error-base.ts`） + `ExecutionTransitionError`（`execution-transitions.ts:131-136`）。
- **错误码体系**：**信息不足**（仓库内未发现统一 `ErrorCode` enum；`error-base.ts` 细节需阅读）。
- **全局拦截**：
  - `chat-route.ts` 顶层 try/catch
  - `loop.ts:140-373` try/finally + `mcpCleanup`
  - `server.ts:404-408` `startServer().catch(...)` 兜底日志
  - `server.ts:386-393` `onClose` hook 清理 OTel bridge
- **Fallback**：工具失败 → `onSessionError` 累积 → `session.completed` payload 含 `errorSummary`。
- **死信队列**：`dead_letter_events` 表 + `writeDeadLetterEvent`（`packages/agent/src/dead-letter.ts`），可被 operator 通过 `/tasks/failed` + `operator_attention` 接入。
- **AP1 拦截**：`transitionExecutionState` 在非法转移时抛 `ExecutionTransitionError`。

### 6.2 鉴权 / 身份认证 / 权限

- **当前模型**：单用户本地模式为主。
- **Auth middleware**：`packages/gateway/src/auth-middleware.ts`（含测试文件），根据 `config.auth.enabled` 开关。
- **P0 加固**：`db9399c fix(gateway): gate operator actions with operator token` — operator actions 需 token。
- **Settings PATCH**（`server.ts:206-227`）：仅允许 merge 现有顶层 key，防止注入。
- **Executor agent key**：`EXECUTOR_AGENT_KEY`（自动生成 ephemeral 警告），可选持久化。
- **Multi-tenant 字段**（已预留但未启用）：`tenant_id / project_id / user_id / node_id / request_id / trace_id` 在 sessions / task_runs / session_events / todos / observations 表均存在。
- **Memory scope/ACL**：`5ed772b feat: add Memory scope/ACL and promotion gate (#70)` — ADR 0017 / 0020 引入 `procedure_candidates` 需 operator 审核。
- **Provider promotion**（ADR 0017）：advisory → verified_advisory → required / blocked，必须 operator 审核。

### 6.3 敏感数据传输 / 存储 / 脱敏

- **Provider credentials**：仅通过 `*_API_KEY` 环境变量或 `~/.los/accounts/<name>.json`（cc-switch 兼容），不写入代码。
- **OMX 日志脱敏**：`docs/adr/0016-omx-tool-level-logging-scope.md` 规定不存 raw stdout/stderr / tool args / auth tokens。
- **Provider compat evidence 脱敏**（`contracts/provider-compat-evidence.yaml:51-54`）：
  - 不暴露 provider credentials
  - 不暴露 raw prompts / model output / raw transcripts / 任意 summary JSON
  - failure strings 必须 bounded 后才可 HTTP 序列化
- **DB URL 校验**：`isSafeTestDatabaseUrl` 强制测试 DB 命名（`db.ts:74-83`）；生产 DB 名通过 `redactedDatabaseName` 在错误信息中脱敏。
- **Artifact confidence**（migration 011）：`confirmed` 状态需 human attestation，AI agents 不能写。
- **Gateway rate limit**：`chatLimiter = createRateLimiter({max: 30, windowMs: 60_000})`（`server.ts:104-112`）。
- **Security headers**：`registerSecurityHeaders(app, {hsts: false})`（`server.ts:102`）。
- **CORS**：`cors, {origin: config.server.corsOrigin}`（`server.ts:98`）。

### 6.4 已知安全相关变更

来源：MEMORY + git log：
- `2026-06-19` P0 安全加固 6 项：settings auth bypass / `.env.bak` 删除 / chat rate limit / 安全 headers / session 批量写入 / tool 并行化 / agent barrel 收紧
- `2026-06-20` Operator token gate（db9399c）
- `2026-06-20` Secure operator runtime event streams（d3ffae7）

---

## 七、文档与设计材料

### 7.1 现有架构图 / ER 图 / 时序图

- **架构图**：**信息不足**（仓库内未发现 PlantUML / Mermaid / draw.io 架构图文件）。
- **ER 图**：**信息不足**（迁移 SQL 隐含 schema，但未发现 explicit ER 图）。
- **时序图**：**信息不足**（KG 未包含 Sequence 节点）。
- **API/路由文档**：11 个 `contracts/*.yaml` + 知识图谱中的 159 个 Route 节点（含 method + path）。

### 7.2 关键设计文档清单

- **AGENTS.md**：项目最高规则源（`projects/los/AGENTS.md`，~15k bytes）
- **CLAUDE.md**：`projects/los/CLAUDE.md` — 入口指针（不复制全局规则）
- **SKILL.md**：`projects/los/SKILL.md` — 7k bytes，重复 los-specific 工作流
- **23 个 ADR**（`docs/adr/0001` 至 `0023`）：
  - 0001：PostgreSQL single-node mesh
  - 0002：Session ledger observability
  - 0003：Controlled runtime evolution + DeepSeek dev
  - 0004：Web observability console plan
  - 0005：SaaS todo agent dispatch
  - 0006：Todo governance archive dependency
  - 0007：Provider loop-first model profiles
  - 0008：Single-node mesh ready execution order
  - 0009：Client-first execution + node binaries
  - 0010：Node connectivity capability taxonomy
  - 0011：Node operations artifact transfer
  - 0012：Service cluster + stateful agent roadmap
  - 0013：Historical state drift cleanup
  - 0014：Testing strategy + regression gates
  - 0015：External transcript truncation + run replay policy
  - 0016：OMX tool-level logging scope
  - 0017：Advisory provider promotion playbook
  - 0018：CLI fallback gate
  - 0019：External summary ingestion contract
  - 0020：Memory compaction procedural learning
  - 0021：Stage B operator contract implemented state（**关键：current-state declaration**）
  - 0022：1Panel boundary analysis
  - 0023：Agent identity decision framework
- **22 治理文档 + manifest + 26 run-chain-changes**（`docs/governance/`）
- **18 个日期化 operation smokes**（`docs/operations/2026-06-*`）
- **5 个 research 笔记**（`docs/research/`，含 MiMo-Code analysis、Codebase Memory MCP analysis）
- **4 个 spec 文件**（`.los/spec/{infra,agent/{loop,provider,tool},memory,gateway/{route,web},executor,identity,input-preprocessor}/index.md`）

### 7.3 当前实现与原始设计文档的已知差异

- **ADR 0012**：Phase 2 / Phase 4 部分实现，Phase 5-7 仍为 roadmap。
- **ADR 0021**：明确声明「partially implemented early」已修复对齐 — 当前实现与 ADR 一致。
- **docs/README.md「Truth Surfaces」表**：声明 config truth / runtime truth / persisted evidence / design intent / live proof / governance queue 必须分清；runtime-evidence-graph + state machine drift 修复（AP4）是关键工作。
- **文件大小门禁**：400 warn / 600 block；近 1 周报告显示部分文件治理仍在持续（`docs/governance/l1-file-size-refactor-2026-06-13.md`）。

---

## 八、周边依赖与约束

### 8.1 团队规模 / 开发维护模式 / 迭代节奏

- **团队规模**：**信息不足**（仓库内未发现 `CODEOWNERS` / `team.md` / git author 统计自动汇总）。
- **维护模式**：单人 owner（commit 作者均为 `echerlos`/`LosEcher` PR robot）；jj + git 双轨；Forgejo PR（`review-YYYYMMDD-*` 分支命名约定）。
- **迭代节奏**：**389 commits / 30 天**，约 **13 commits / 天**，高强度。
- **代码评审**：`tools/check-contracts.sh` + `tools/check-structure.sh` + `tools/check-state-machine-bypass.sh` + `tools/check-unwired-exports.sh` + `tools/check-readiness.sh` 五个本地检查 + `pnpm gate` 整合 → CI gate（`ci-gate.sh`）。

### 8.2 外部第三方服务 / API 依赖 / 外部数据源

| 类别 | 名称 | 说明 |
|---|---|---|
| LLM Provider | DeepSeek | required default target（ADR 0017） |
| LLM Provider | OpenAI / Anthropic / Codex / PackyCode / MiniMax | configurable |
| LLM Provider（local） | Ollama (:11434) / LM Studio (:1234) / vLLM (:8000) | auto-detect |
| 推送 | WxPusher（微信 fallback） | optional |
| IM | WeClaw（微信 primary，二维码登录） | optional |
| IM | Telegram Bot | optional |
| MCP | （user-defined） | 通过 MCP servers 注册 |
| CBM（Codebase Memory MCP） | `config.memory.codeGraph.cbmCommand` | optional |
| OTel collector | gateway 自拉起 | optional |
| 迁移来源 | rclonemana archive（HH→34 节点） | 历史参考 |
| 迁移来源 | sync-node 设计 | 历史参考 |

### 8.3 当前线上问题 / 运维反馈 / 用户侧主要痛点

来源：MEMORY + docs/governance：

1. **File-sync 节点不一致**：`los-p0-file-sync-34-fix-2026-06-21` — GATEWAY_URL 设置时 initDb skip bug，34 节点紧急修复。
2. **Operator action token 缺失**：`db9399c` — operator actions 之前未充分 gate。
3. **实施但未接线反模式**：`los-implemented-but-not-wired-antipattern` — 7 天 6 次出现，需 CI gate。
4. **文件大小门禁 warn 失效**：`los-file-size-governance-status-2026-06-18` — 30 文件超 400 行，warn 门禁无效，需升级 CI block。
5. **Knowledge Memory 数据稀疏**：`los-memory-module-audit-2026-06-16` — 381 条全为测试数据，maxObservations 未强制，retention/integrity 无人调用，procedural_candidates 表不存在。
6. **HH-to-34 迁移未完全收敛**：`vpsagentweb-phased-migration-2026-06-14` — 端口 8080 冲突，节点替换分阶段。
7. **Node taxonomy 漂移**：`los-mesh-node-taxonomy-2026-06-18` — 15 节点实时分类，3 离线/僵尸节点。
8. **CLI fallback 决策**：`docs/adr/0018-cli-fallback-gate.md` — 任何外部 CLI fallback 需明确 gate。
9. **Provider compat evidence 显示**：`docs/governance/provider-promotion-evidence-display-plan.md` — API/CLI/Web UI 展示策略待完善。
10. **Provider phantom tool call**：`los-packycode-wire-api-fix-2026-06-11` — PackyCode wire_api=responses 400 + mergeToolCallDeltas index 跳变。
11. **MImo P1 待办**：`los-remaining-backlog-2026-06-17` — Phase 4.4-4.5 / file-sync P0 / module readiness 8 gaps / MiMo P1。

---

## 九、信息缺口建议

为完成后续架构审计、算法优化、性能调优，建议优先补充以下材料。

### 9.1 必须补充（影响核心结论）

1. **DB schema 完整 DDL**：除 12 个迁移文件外，需 grep `ensure*Store()` 列出所有隐含建表 SQL（如 `run_specs / tool_call_states / verification_records / executor_nodes / service_instances / idempotency_keys / todos / skills / rules / mcp_servers / artifacts / provider_compat_evidence / run_evals / stream_checkpoints / observations / memory_compactions / agent_tasks`）。
2. **当前生产 / 测试 Postgres 数据规模**：表行数、索引大小、长事务频率、PG NOTIFY 频率。**来源**：仓库无此数据；建议 `SELECT pg_size_pretty(pg_database_size(...))` + `pg_stat_user_tables` 抓取基线。
3. **Provider provider-selection.ts 完整算法**：时间复杂度、候选项规模、决策权重。
4. **editable-surfaces 冲突算法完整实现**：边界判定复杂度。
5. **memory/store.ts / compaction.ts 完整实现**：FTS 查询的 EXPLAIN ANALYZE、compaction 的算法复杂度。
6. **gateway 全部 184 个 route 的方法/路径完整列表**：当前仅有 8 delete / 95 get / 12 patch / 69 post 计数，无逐项。
7. **executor file-sync 算法**：scanner / sync-runner 完整实现，settle 逻辑复杂度。
8. **生产监控 / APM 数据**（Prometheus / Datadog / Sentry 等接入情况）：仓库内目前仅有 OTel bridge，需确认是否对接实际后端。
9. **用户量级 / DAU / QPS / 平均 RT / p95 / p99**：当前完全缺失。
10. **服务部署拓扑**：是否多 gateway / 多 executor，是否对接 1Panel / systemd unit 之外的服务编排（K8s / Docker Compose）。
11. **团队与角色**：owner / reviewer / 运维分工。
12. **线上事故 / 故障 list**：最近 90 天的 P0/P1 incident + RCA。

### 9.2 强烈建议补充（影响模块级审计）

1. **MCPStdioTransport.close fan-in 27 的具体调用图**：是否存在连接泄漏。
2. **`getDb` 268 fan-in 中是否有 hot path 的连接管理风险**。
3. **`runtime-evidence-graph.warn` 38 fan-in 的语义定义**：是性能瓶颈还是审计点。
4. **identity-loader / resolveAgentIdentity 完整实现**：6 条执行路径的身份注入策略是否一致。
5. **provider-policy + provider-promotion-decisions 完整实现**：判定规则与阈值。
6. **chat-route 全套 handler**：rate-limit 命中后的具体行为。
7. **`input-preprocessor` 5 种 detector 的正则 / 性能**：log denoiser 的 token reduction ratio。
8. **memory retention / integrity / auto-compact SQL 的执行时间分布**。
9. **`tool-call-recovery.ts` 全部状态转移**：4 类实体的 failure → recovery 矩阵。
10. **governance-jobs 9 个 seed jobs 的执行周期、依赖、阈值**。
11. **OTel bridge 端口、协议、目标 collector 配置**。
12. **Wechat-bot / Telegram-bot 的实际接入门槛与失败模式**。
13. **测试覆盖率**：100 个测试文件 / 17k 行测试代码对应的覆盖率（**信息不足**，仓库未暴露 coverage 报告）。
14. **Turbo pipeline 的实际行为**：是否有 cache miss 风险。

### 9.3 可选补充（锦上添花）

1. 架构图（plantuml / mermaid / draw.io）
2. ER 图（基于迁移 SQL 反推）
3. 时序图（chat 链路 / scheduler 链路 / recovery 链路）
4. OpenAPI 渲染（基于 11 个 contracts/*.yaml）
5. 性能压测报告（缺）
6. 容量规划（DAU / QPS / RT / storage growth）
7. CI/CD pipeline 完整图
8. 灾备 / RTO / RPO 文档（缺）

---

## 附录 A：知识图谱 cluster 摘要（Leiden 社区检测）

> 来源：`mcp__codebase-memory-mcp__get_architecture`（按 cohesion 排序前 5）

| Cluster | 成员数 | Cohesion | 顶级节点 |
|---|---|---|---|
| 12 | 220 | 0.590 | `getDb`, `query`, `exec`, `warn`, `info` |
| 30 | 149 | 0.642 | `appendSessionEvent`, `readRuntimeEvidenceGraph`, `transitionExecutionState`, `registerRunRoutes`, `all` |
| 10 | 144 | 0.964 | `getJson`, `postJson`, `formatDate`, `ChatPage`, `ProvidersPage` |
| 0 | 124 | 0.864 | `runOperationCommand`, `main`, `chatCommand`, `withInitDb`, `governanceCommand` |
| 54 | 114 | 0.744 | `get`, `register`, `safeWorkspacePath`, `registerBuiltinTools`, `registerFindInCodeTool` |

## 附录 B：模块依赖矩阵（KG 推断）

```
                  infra  agent  memory  cli   gateway  executor  los-common
agent             309    -      ?       16    -        -         -
cli               14     16     -       -     -        -         -
executor          57     31     -       -     -        -         -
gateway           57     177    13      -     -        -         -
memory            60     ?      -       -     -        -         -
los(root CLI)     -      -      -       -     -        -         46
web               (通过 gateway 静态文件挂载，无直接调用关系)
input-preprocessor (由 agent loop 通过 preprocessInput 引用)
media             (由 wechat-bot / external-runtime routes 引用)
telegram-bot      (独立进程，通过 SSE + HTTP /operator/steering 通信)
wechat-bot        (独立进程，通过 SSE + HTTP 通信)
```

## 附录 C：HTTP 路由清单（部分高优先级）

> Gateway：184 个路由（get 95 / post 69 / patch 12 / delete 8）；完整列表见 `mcp__codebase-memory-mcp__search_graph` 过滤 `label=Route`。

高优先级（KG 已识别）：

| Method | Path |
|---|---|
| GET | /mcp-servers, /mcp-servers/:id |
| POST | /mcp-servers, /mcp-servers/:id/verify, /mcp-servers/:id/reload |
| DELETE | /mcp-servers, /mcp-servers/:id |
| - | /skills/sync-to-dir, /skills/load-from-dir |
| - | /projects/browse, /projects/bind, /projects/:projectId, /projects/:projectId/touch |
| - | /sessions/:sessionId, /sessions/:sessionId/events, /sessions/:sessionId/observability, /sessions/:sessionId/verification |
| POST | /chat |
| GET/PATCH | /settings |
| GET | /protected |
| GET | /health |
| GET | /runs/:runSpecId/events, /runs/:runSpecId/inspect, /runs/:runSpecId/state, /runs/:runSpecId/stream |

Executor routes（Node process）：

| Method | Path |
|---|---|
| GET | /health |
| POST | /v1/tasks/run-agent |
| GET/POST/DELETE | /v1/artifacts[/...] |
| POST | /v1/node-commands/... |
| GET/POST | /v1/file-sync/scan, /deep-verify, /status, /events |

---

**本文档版本**：v1.0（2026-06-21 首版基线盘点）
**生成方式**：源码 + AST + 知识图谱 + docs 全文阅读
**下一步**：建议优先按 §9.1 清单补充必需材料；§9.2 / §9.3 按审计目标选择性补充。