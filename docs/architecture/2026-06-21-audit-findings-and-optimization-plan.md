# los 项目审计发现、优化方案与修复 TODO

> 基于：`docs/architecture/2026-06-21-project-context-baseline.md`（888行，九章节盘点）
> 分析日期：2026-06-21
> 方法：源码 + KG（6167/14520）+ docs + contracts + ADR 交叉验证

---

## 一、发现问题分类总览

按严重度 + 修复紧迫度分三级：

| 级别 | 数量 | 定义 |
|---|---|---|
| **P0 立即修复** | 8 项 | 数据正确性问题 / CI 门禁失效 / 运行时漂移 / 安全缺陷 |
| **P1 本迭代修复** | 12 项 | 质量/可靠性/覆盖度 gap，影响后续审计/自治 |
| **P2 计划中** | 9 项 | 可观测性/文档化/性能基线，不阻塞当前迭代 |

---

## 二、P0 级别：必须立即修复（8 项）

### P0-1 文件大小门禁失效 — warn 升级为 block

**现状**：`tools/check-structure.sh` 定义 `BLOCK_LINES=400`，但新文件 >400 行是 `warn` 不是 `error`（仅 `MAX_LINES=600` 才是 error）。28 个源文件超 400 行（排除 node_modules 和 dist）：

| 文件 | 行数 |
|---|---|
| `packages/memory/src/core/store.ts` | 600 |
| `packages/web/src/chat-page.tsx` | 592 |
| `packages/gateway/src/chat-service.ts` | 592 |
| `packages/memory/src/core/compaction.ts` | 588 |
| `packages/agent/src/todo-seeds-agent-workflow.ts` | 570 |
| `packages/agent/src/run-contract.ts` | 567 |
| `packages/infra/src/config.ts` | 564 |
| `packages/agent/src/session-events.ts` | 553 |
| `packages/gateway/src/server.ts` | 542 |
| `packages/media/src/media-runtime.ts` | 539 |
| 其他 18 个文件 | 401–522 |

**影响**：`AGENTS.md:16` 声明的门禁（>400 warn, >600 block）部分失效；超大文件掩盖算法复杂度和重复逻辑。

**修复方案**：
1. 修改 `tools/check-structure.sh`：将新文件 (不在 grandfathered baseline) 的 warn 阈值从 600 降到 400，超 400 报 error
2. 创建 grandfathered baseline 清单（当前 28 个文件，逐项标记 owner + 分拆计划）
3. 对 P0 候选文件（>500 行）启动专项拆解：`store.ts(600)` → 拆成 `store-queries.ts` + `store-writes.ts` + `store-search.ts`；`chat-service.ts(592)` 已有子模块但需进一步抽离；`chat-page.tsx(592)` → 拆成 `chat-page/` 子组件

**验证**：`pnpm check` 通过后，新文件不应有 >400 行报错（grandfathered 除外）。

---

### P0-2 DB Schema 完整 DDL 缺失 — ensure*Store() 分散在 4 个包

**现状**：仅 12 个迁移文件覆盖了 `sessions / task_runs / session_events / status_constraints / file_sync / procedural_candidates / governance_jobs / static_graph_baselines / dead_letter_events / artifacts+status / transcript_brief`。但是代码中引用了至少 **另外 15+ 张表**：

| 表名 | 建表位置 | 状态 |
|---|---|---|
| `run_specs` | `agent/run-specs.ts` 确保 | 未在迁移中 |
| `tool_call_states` | `agent/tool-call-states.ts` | 未在迁移中 |
| `verification_records` | `agent/verification-records.ts` | 未在迁移中 |
| `executor_nodes` | `agent/executor-nodes.ts` | 未在迁移中 |
| `service_instances` | `agent/service-instances.ts` | 未在迁移中 |
| `idempotency_keys` | `gateway/idempotency.ts` | 未在迁移中 |
| `todos` | `agent/todos.ts` | 未在迁移中 |
| `skills` | `agent/skills.ts` | 未在迁移中 |
| `rules` | `agent/rules.ts` | 未在迁移中 |
| `mcp_servers` | `agent/mcp-servers.ts` | 未在迁移中 |
| `artifacts` | `agent/artifacts.ts` | 迁移 011 仅加列 |
| `provider_compat_evidence` | `agent/provider-compat-evidence.ts` | 未在迁移中 |
| `run_evals` | `agent/run-evals.ts` | 未在迁移中 |
| `stream_checkpoints` | `agent/stream-checkpoints.ts` | 未在迁移中 |
| `observations` | `memory/core/store.ts` | 未在迁移中 |
| `memory_compactions` | `memory/core/compaction.ts` | 迁移 012 仅加列 |
| `agent_tasks / agent_task_attempts / agent_task_edges` | `agent/agent-task-graph.ts` | 未在迁移中 |

**影响**：双 DDL 路径（迁移 SQL + ensure*Store 内的 CREATE TABLE IF NOT EXISTS）导致生产 schema 与迁移历史不一致；`CREATE TABLE IF NOT EXISTS` 掩盖列缺失直到运行时出错。

**修复方案**：
1. `grep -rh "CREATE TABLE IF NOT EXISTS\|CREATE TABLE\|ensure\w*Store" packages/*/src/ | sort` 生成完整建表清单
2. 为每个缺失表写独立迁移文件（`013_xxx.sql` 起）
3. 所有 `ensure*Store()` 中的 DDL 移入迁移，`ensure*Store()` 仅保留幂等校验
4. 加 `tools/check-migrations.sh`：验证迁移覆盖所有已知表

**验证**：`grep -r "CREATE TABLE IF NOT EXISTS" packages/*/src/` 返回空（除了 migrateDir 加载的 SQL）。

---

### P0-3 "Implemented But Not Wired" 反模式 — 需 CI gate

**现状**：MEMORY 记录 "7 天 6 次出现"。当前仅靠人工审查，无自动化检测。典型模式：
- 函数已 export 但无 caller（fan-out=0 且非 entry point）
- Route handler 已注册但 `createServer` 未调用注册函数
- 命令已实现但 CLI `main()` switch 未接

**影响**：看起来完成的功能实际未生效，"完成"的幻觉持续产生。

**修复方案**：
1. `tools/check-unwired-exports.sh` 已有，验证其覆盖面和 CI 集成
2. 扩展检测规则：
   - `grep -L "from.*${package}" caller-packages` → 无 caller
   - KG fan-in=0 且不在 entry-point list → 标记
   - Route 注册函数 vs `createServer` 调用 → 匹配检查
3. 将检测加入 `pnpm check`（`turbo check` 之后、`check-contracts.sh` 之前）

**验证**：`pnpm check` 在发现 unwired export 时应 report error（非 warn）。

---

### P0-4 Memory 模块数据稀疏 + governance 未接线

**现状**（来自 `2026-06-16 memory-module-audit`）：
- `observations` 表 381 条全为测试数据
- `maxObservations` 未强制（config 有字段但无运行时检查）
- retention/integrity 用户无人调用（仅 `server-maintenance.ts` 24h 自动运行）
- procedural_candidates 表从未生成候选（compaction 端可能缺触发）

**影响**：Memory 子系统是 los 的核心差异化能力，但当前不在生产路径上运行。

**修复方案**：
1. 在每次 chat 完成后自动触发 observation 抽取（`chat-memory-augment.ts` 已有，检查是否接电）
2. 在 writeObservation 处 enforce `maxObservations`（最老 observation 自动 archive）
3. 在 `/memory` 路由或 CLI `los memory` 命令暴露 `stats` 查看 compaction 状态
4. 确保 `procedural_candidates` 在 compactSession 后自动种子填充（ADR 0020 的 "auto-discover" phase）

**验证**：单次 chat 后 `SELECT count(*) FROM observations` 应 > 0。

---

### P0-5 Governance sweeper 未按 schedule 运行 — 3 backlog jobs

**现状**（来自 `todo-seeds-governance.ts` + `governance-jobs.ts`）：

| Job | 状态 |
|---|---|
| consistency_audit | 未在 seed 中 |
| architecture_drift | 未在 seed 中 |
| hotspot (file-size) | 未在 seed 中 |
| provider_surveillance | 未在 seed 中 |
| memory_integrity / memory_retention | 未在 seed 中 |
| drift_sweeper | implemented but `todo: backlog` |
| periodic_sweeper | `todo: backlog` |
| hotspot_and_tool_drift | `todo: backlog` |

`governance-drift-sweeper.ts` 实现了 drift 检测逻辑，但未被 `server-maintenance.ts` 周期性调用（仅有 orphan reaper + memory retention/integrity/auto-compact + governance sweep 引用，需确认 sweep 注册了哪些 jobs）。

**修复方案**：
1. 完成 `todo-los-governance-periodic-sweeper` implementation
2. 为 5 个 governance 类别各创建至少 1 个 seed job
3. 在 `server-maintenance.ts` 注册 governance sweep 定时器（已存在但需确认调用了 drift sweeper）
4. 确认 governance sweep 结果写入 `governance_jobs.result_summary_json`

**验证**：`SELECT job_type, last_run_at, result_summary_json FROM governance_jobs` 显示所有活跃 job 有最近执行。

---

### P0-6 Eval probe 覆盖不足 — 仅 E02/E03/E08 有自动 probe

**现状**：20 个 eval cases（E01-E20），但 `eval-probes.test.ts` 仅覆盖 E02（runtime from config）、E03（provider readiness as compat）、E08（ADR repeated without source check）。E01/E04/E05/E06/E07/E09-E20 全为文档级——手动检查，无自动回归。

**影响**：防漂移机制无牙。

**修复方案**：
1. 按 promotion order（`eval-backlog.md:287-293`）优先写 E01（dirty worktree formatter）+ E06（todo done without evidence）+ E07（legacy as active target）
2. E14/E15/E16 已有 `run-contract.test.ts` 覆盖，确认标记为 `hasProbe: true`
3. 更新 `eval-backlog-runner.ts` 中各 case 的 `hasProbe` 状态

**验证**：`node --test packages/agent/src/eval-probes.test.ts` 覆盖 >= 8 个 eval case。

---

### P0-7 AP6（Child agent run contract 继承）未修复

**现状**：`spawn_agent` 工具（`tools/agent-tools.ts:83`）创建子 agent 时，run contract 传播是 "basic"（ADR 0021 描述），但 ADR 0021 明确 "remaining gaps" 包含 "durable child run-spec lineage and child attempt linkage"。

**影响**：子 agent 无 phase 约束，可执行未经 approved 的任务，可 succeeded 无 verification（Fleet Loop invariant 破损）。

**修复方案**：
1. 在 `spawn_agent` 工具中确保 parent 的 `runContract` 完整传播
2. 子 agent 的 `canStartExecution()` 和 `canMarkSucceeded()` 必须检查 inherited contract
3. 子 agent 需有独立的 `child_run_spec_id` + `parent_run_spec_id` 外键

**验证**：单元测试覆盖 `spawn_agent` → `runContractMetadata.planParentRunSpecId` 非空。

---

### P0-8 MCPStdioTransport.close fan-in 27 — 潜在连接泄漏

**现状**：KG 热点 `MCPStdioTransport.close` fan-in = 27。每创建一次 MCP client 都应在 finally 中 close，但 fan-in 如此高表明子进程管理可能不一致。

**影响**：长时间运行的 gateway 可能留下僵尸 stdio 子进程。

**修复方案**：
1. Review `tools/external/mcp-client.ts` 的 `MCPStdioTransport` 生命周期
2. 确保 `mcpCleanup`（`loop.ts:372`）覆盖所有 MCP transport
3. 在 gateway 启动和关闭时添加 MCP server 子进程健康检查

**验证**：运行 gateway 30min 后，`ps aux | grep "mcp\|stdio"` 无泄露子进程。

---

## 三、P1 级别：本迭代修复（12 项）

### P1-1 Provider promotion decision 完整逻辑缺失文档

**问题**：`provider-promotion-decisions.ts` 的判定规则与阈值未文档化；ADR 0017 定义了 3 种 target state（advisory / verified_advisory / required）但未定义 automated promotion 条件（哪些 evidence 字段触发自动提升）。

**修复**：
1. 在 ADR 0017 补充 automated promotion 判定矩阵
2. 为 `recordProviderPromotionDecision` 添加单元测试（覆盖 all-decision-states）

---

### P1-2 Tool-call recovery state 完整矩阵未验证

**问题**：`tool-call-recovery.ts` 处理 5 种 action（retry / resume / cancel / operator_attention / terminal_failed），但当前仅 scheduler 中 `applyGraphCompletionRunSpecTransition` 调用。多个 failure → recovery 路径未经过端到端测试。

**修复**：
1. 写 `tool-call-recovery.test.ts` 覆盖 5 种 action x 4 种 entity 类型的矩阵
2. 确认 operator_attention 路径接通 Telegram/WeChat handoff

---

### P1-3 Provider policy enforcement 不一致

**问题**：`provider-policy.ts`（或 `scheduler/provider-selection.ts`）的 provider 选择在 gateway chat（`setup.ts`）和 scheduler graph（`scheduler.ts`）走不同路径，可能导致同一 task 在不同 dispatch 路径选不同 provider。

**修复**：
1. 统一 provider selection 入口：gateway chat + scheduler graph → 同一 `resolveProvider` 函数
2. 写 test：同 task 在 chat vs scheduler 模式下选到同一 provider

---

### P1-4 Identity injection 6 条路径一致性验证

**问题**：ADR 0023 定义了 6 条路径各不同的 identity level（none/minimal/standard/full），但 `resolveAgentIdentity()` 实现（`identity-loader.ts`）未经验证覆盖所有 6 条路径。

**修复**：
1. 写 `identity-loader.test.ts`：对每条路径验证 identity level 匹配 ADR 0023 的决策矩阵
2. 确认 scheduler verifier 路径确实是 `none`（当前代码在上层判断）

---

### P1-5 输入预处理器性能基线 + P1/P2 待办清理

**问题**：`@los/input-preprocessor` 的 P0 完成（21 file, 76 tests），但 `los-input-preprocessor-2026-06-18.md` 列出 14 项 P1/P2 待办（log denoiser 的 token reduction ratio、detector 正则性能、多模态检测器等）。

**修复**：
1. Benchmark：100KB log → preprocessor output token count reduction
2. 完成 P1: code/config/error/mixed denoisers 的 standalone tests
3. 确认 preprocessing 已接入 agent loop 主路径（`preprocessInput` 是否在 `setup.ts` 的消息构建前调用）

---

### P1-6 Memory retrieval 无 EXPLAIN ANALYZE 基线

**问题**：`memory/core/store.ts` 的 FTS 查询（tsvector + GIN index + JSONB 多 facet）无性能基线。600 行的实现复杂度暗示多次子查询组合，但无优化依据。

**修复**：
1. 在 1000 / 10000 / 100000 行 observations 规模下运行 EXPLAIN ANALYZE
2. 根据分析添加覆盖索引或 query rewrite
3. 在 `memory/store.test.ts` 添加性能 regression test（简单上限断言）

---

### P1-7 WeChat Bot / Telegram Bot 生产就绪

**问题**：两者均为独立进程，依赖 SSE + HTTP callback。失败模式无文档（WxPusher token 过期 / WeClaw API 地址变更 / Telegram Bot token revoked 后需手动重启）。

**修复**：
1. 添加 health endpoint 到 bot 进程
2. 添加重连/重试循环（当前仅依赖外部 SSE reconnect）
3. 添加 `tools/check-bot-health.sh` 或纳入 `pnpm doctor`

---

### P1-8 Deadline-letter 与 governance sweep 的交接

**问题**：`dead_letter_events` 表写入后，仅被 gateway startup recovery（`server.ts:322-333`）消费。operator 通过 CLI `los dead-letter` 查看，但无定期的 dead-letter 分类、告警、或自动 re-queue。

**修复**：
1. 在 governance sweep 中添加 dead-letter 分类统计（按 reason 分桶）
2. 对可重试的 dead-letter（reason='lease_expired'）添加自动 re-queue 机制
3. `los dead-letter` CLI 增加 `--ack` 和 `--retry` 子命令

---

### P1-9 File-sync mtime settle 逻辑验证

**问题**：`ae62b94 fix(executor): report file sync folders and settle by mtime` 是 30 天内最大改动之一，但 file-sync 的 settle 算法（`sync-runner.ts` + `scanner.ts`）无独立测试覆盖多节点并发写入场景。

**修复**：
1. 写 `scanner.test.ts`：并发写入 → 两次 scan 间 diff 正确
2. `sync-runner.test.ts`：跨节点 version vector 收敛

---

### P1-10 OTel bridge 配置不可见

**问题**：`startOtelBridge({source:'gateway'})` 自动拉起，但端口（**信息不足**）、协议、目标 collector URL 无文档。

**修复**：
1. 在 `.env.example` 补充 `OTEL_EXPORTER_OTLP_ENDPOINT` 和 `OTEL_SERVICE_NAME` 说明
2. 暴露 OTel bridge health（当前无 route）
3. 添加 `tools/check-otel.sh`

---

### P1-11 Test coverage 盲区

**问题**：100 个测试文件 / 17k 行测试代码，但整体覆盖率未知。高风险盲区：`governance-sweeper.ts` / `governance-drift-sweeper.ts` / `wechat-bot` / `telegram-bot` / `media` 包可能无测试。

**修复**：
1. 运行 `node --test --experimental-test-coverage` 收集各包覆盖率基线
2. 为覆盖 < 30% 的模块写 focused tests

---

### P1-12 Turbo pipeline cache 行为不明

**问题**：`turbo.json` 控制构建依赖，但 CI 中可能存在 cache miss 导致重构建（影响 `pnpm check` 执行时间）。

**修复**：
1. 在 CI 中启用 turbo remote cache 或显式声明 `--force` 策略
2. 文档化期望的 cache hit behavior

---

## 四、P2 级别：计划中（9 项）

### P2-1 架构图生成
- 基于 contracts/*.yaml + server.ts route 注册 + KG → 自动生成系统拓扑图（Mermaid/PlantUML）

### P2-2 ER 图生成
- 基于 12 迁移 + ensure*Store() DDL → 自动生成 ER 图

### P2-3 Chat / Scheduler / Recovery 时序图
- 3 个核心链路的时序图（可从 §3.1 文本描述升级）

### P2-4 OpenAPI 文档渲染
- 11 个 contracts/*.yaml → Swagger UI / Scalar UI 渲染

### P2-5 生产监控基线
- 接入 Prometheus metrics exporter（task_runs 延迟 / tool 成功率 / provider latency / cache hit rate）

### P2-6 性能压测
- 对 `/chat` SSE 流 和 `GET /memory?q=...` FTS 查询做并发压测

### P2-7 容量规划
- DAU/QPS 估算 + 存储成长率建模

### P2-8 CI/CD 流程文档
- 当前 CI gate（`ci-gate.sh` 包含哪些检查，顺序，退出码语义）

### P2-9 灾备 / RTO / RPO
- PostgreSQL backup 策略 / 恢复时间估算

---

## 五、修复优先级与依赖图

```
P0-1 (file size gate)
 ├─ 阻塞：无（可独立修复）
 └─ 产物：grandfathered baseline list + 3 个专项拆解 PR

P0-2 (DB schema DDL)
 ├─ 阻塞：无
 └─ 产物：迁移 013-020 + check-migrations.sh

P0-3 (unwired exports CI gate)
 ├─ 阻塞：P0-2（需要完整 schema 才能 detect unwired）
 ├─ 产物：扩展 check-unwired-exports.sh + CI integration

P0-4 (memory production wiring)
 ├─ 阻塞：P0-2（需确认 observations/memory_compactions 表完整）
 └─ 产物：chat complete auto-extract + maxObservations enforce + procedural_candidates seed

P0-5 (governance sweeper schedule)
 ├─ 依赖：P0-2（governance_jobs schema 完整）
 └─ 产物：periodic_sweeper implementation + seed jobs

P0-6 (eval probe coverage)
 ├─ 阻塞：无
 └─ 产物：≥8 个自动化 eval probes

P0-7 (AP6 child contract)
 ├─ 依赖：P0-2（run_specs 表完整）
 └─ 产物：child run-spec lineage

P0-8 (MCP connection leak)
 ├─ 阻塞：无
 └─ 产物：MCP lifecycle review + test

P1-1 ~ P1-12:
 ├─ 依赖：P0-1~P0-8 全部（修复过程可能发现新 gap）
 └─ 可并行：P1-1/provider || P1-2/recovery || P1-4/identity || P1-5/preprocessor || P1-6/memory-perf
    P1-3/provider-policy → P1-1 后做
    P1-8/dead-letter → P0-5 后做
    P1-9/file-sync → P0-1 后做
    P1-10/otel → P1-7/bots 后做
    P1-11/coverage → P0-6 后做
```

---

## 六、TODO 记录（写入 los planning todos）

基于上述分析，以下 TODO 项应写入 `packages/agent/src/todo-seeds.ts` 或作为独立 Todo 记录。

| ID | 标题 | P | 依赖 | 验证 |
|---|---|---|---|---|
| `todo-los-p0-file-size-gate` | 升级 file-size 门禁：新文件 >400 行 block | P0 | — | `pnpm check` 新文件 >400 行 error |
| `todo-los-p0-db-schema-ddl` | 补全 DB schema DDL（15+ 缺失表 → 迁移） | P0 | — | `grep "CREATE TABLE IF NOT EXISTS" packages/*/src/` 空 |
| `todo-los-p0-unwired-exports-ci` | "Implemented but not wired" CI gate | P0 | p0-db-schema-ddl | `pnpm check` 检测 unwired |
| `todo-los-p0-memory-production` | Memory module production wiring | P0 | p0-db-schema-ddl | Chat 后 observations > 0 |
| `todo-los-p0-governance-sweeper` | Governance periodic sweeper implementation + seed jobs | P0 | p0-db-schema-ddl | `governance_jobs.last_run_at` 有值 |
| `todo-los-p0-eval-probes` | Eval probes 扩展至 ≥8 个 case | P0 | — | `eval-probes.test.ts` 8+ cases |
| `todo-los-p0-ap6-child-contract` | AP6 修复：child agent run contract 完整继承 | P0 | p0-db-schema-ddl | `spawn_agent` 测试含 parent ref |
| `todo-los-p0-mcp-connection-leak` | MCP 连接生命周期 audit & 防泄漏 | P0 | — | 30min gateway 运行无僵尸进程 |
| `todo-los-p1-provider-promotion-docs` | Provider promotion decision matrix 文档 + 测试 | P1 | — | ADR 0017 补充 + test coverage |
| `todo-los-p1-tool-recovery-matrix` | Tool-call recovery 完整矩阵测试 | P1 | — | 5 actions × 4 entities 测试 |
| `todo-los-p1-provider-policy-unify` | 统一 provider selection 入口 (chat + scheduler) | P1 | p1-provider-promotion-docs | 同 task 同 provider |
| `todo-los-p1-identity-consistency` | Identity injection 6 路径一致性验证 | P1 | — | `identity-loader.test.ts` |
| `todo-los-p1-preprocessor-bench` | Input preprocessor benchmark + P1/P2 清理 | P1 | — | token reduction ratio > 50% |
| `todo-los-p1-memory-perf-baseline` | Memory FTS EXPLAIN ANALYZE + 性能 baseline | P1 | p0-memory-production | 回归断言 |
| `todo-los-p1-bot-production` | WeChat/Telegram bot 生产就绪（health/retry/docs） | P1 | — | 重连自愈 |
| `todo-los-p1-dead-letter-classify` | Dead-letter 分类 + 自动 re-queue | P1 | p0-governance-sweeper | reason 分桶 + retry 可用 |
| `todo-los-p1-file-sync-mtime-test` | File-sync mtime settle 算法测试 | P1 | — | 并发写入 diff 正确 |
| `todo-los-p1-otel-docs` | OTel bridge 配置文档 + health endpoint | P1 | — | `.env.example` 补充 |
| `todo-los-p1-test-coverage` | Test coverage baseline + 低覆盖模块补充 | P1 | — | coverage report |
| `todo-los-p1-turbo-cache` | Turbo cache behavior 文档与 CI 策略 | P1 | — | CI cache hit rate |
| `todo-los-p2-architecture-diagrams` | 架构图自动生成 | P2 | — | Mermaid/PlantUML |
| `todo-los-p2-er-diagram` | ER 图自动生成 | P2 | p0-db-schema-ddl | — |
| `todo-los-p2-sequence-diagrams` | Chat/Scheduler/Recovery 时序图 | P2 | — | — |
| `todo-los-p2-openapi-docs` | OpenAPI 文档渲染 | P2 | — | Swagger UI |
| `todo-los-p2-production-monitoring` | Prometheus metrics exporter | P2 | — | `/metrics` endpoint |
| `todo-los-p2-performance-bench` | Chat + Memory 并发压测 | P2 | p1-memory-perf-baseline | — |
| `todo-los-p2-capacity-planning` | 容量规划文档 | P2 | — | — |
| `todo-los-p2-ci-cd-docs` | CI/CD 流程文档 | P2 | — | — |
| `todo-los-p2-dr-docs` | 灾备/RTO/RPO 文档 | P2 | — | — |

---

## 七、调研分析：哪些问题需要外部信息才能修复

以下 6 项标记为 "需补充外部信息"（对应 baseline §9.1/§9.2 信息缺口）：

### R1：生产环境 PostgreSQL 数据规模
**需要**：`pg_stat_user_tables` 行数、索引大小、长事务频率
**影响**：P0-4 Memory governance 参数（maxObservations / retention 阈值）、P1-6 FTS 性能优化

### R2：Provider 兼容探测的真实命中率
**需要**：`provider_compat_evidence` 表过去 30 天的 pass/fail 分布
**影响**：P1-1 promotion decision 阈值设定

### R3：30 天 chat 请求量 / token 消耗分布
**需要**：`task_runs` 或 gateway log 统计
**影响**：P2-5 Prometheus metrics 指标选择、P2-7 容量规划

### R4：当前多节点部署拓扑（gateway+executor 数量/分布）
**需要**：`executor_nodes` 表 active node 数量 + 网络拓扑
**影响**：P1-9 file-sync 算法设计、P0-4 memory production scope

### R5：OTel collector 配置 / 是否有现成 collector
**需要**：用户环境中 OTEL 配置
**影响**：P1-10 OTel bridge 配置指南

### R6：团队规模 / 多 reviewer 流程
**需要**：git author 分布 + 是否有 CODEOWNERS
**影响**：P2-8 CI/CD 流程文档

---

## 八、执行建议

### 第 1 周（P0 全部 8 项）
| 天 | 任务 | 预计耗时 |
|---|---|---|
| 1-2 | P0-2 DB schema DDL 补全 | 4h |
| 2-3 | P0-1 File size gate 升级 | 2h |
| 3 | P0-3 Unwired exports CI gate | 2h |
| 4 | P0-4 Memory production wiring | 3h |
| 4-5 | P0-5 Governance sweeper schedule | 3h |
| 5 | P0-6 Eval probes 扩展 | 2h |
| 6 | P0-7 AP6 child contract | 2h |
| 6-7 | P0-8 MCP connection leak | 1h |

### 第 2-3 周（P1 前 8 项，可并行）
P1-1/2/4/5/6 可并行（不同子模块），P1-3 在 P1-1 后做，P1-7/8/9/10/11/12 可穿插。

### 第 4 周（P1 剩余 + P2 基线）
完成 P1 剩余 4 项，启动 P2-1/2/3（架构/ER/时序图，可自动化生成）。

---

**关联文档**：
- `docs/architecture/2026-06-21-project-context-baseline.md` — 基线盘点
- `docs/governance/anti-patterns.md` — AP1-AP8 活跃约束
- `docs/governance/eval-backlog.md` — E01-E20 eval cases
- `docs/governance/governance-module-boundary.md` — 治理三层模型
- `docs/governance/agent-workflow-roadmap.md` — Stage A-E 路线图