# los 项目现状、规划与待办（2026-07-03）

> 审计基线：2026-07-03 工作树（含 worker-messages 集成等未提交改动）
> 上游文档：`AGENTS.md` / `SKILL.md` / `docs/governance/agent-workflow-roadmap.md` /
> `docs/governance/2026-06-24-architecture-audit-and-iteration-plan.md` /
> `docs/architecture/2026-06-28-self-iteration-engineering.md` / ADR 0012、0021、0024

## 一句话结论

项目处于**自我治理基建期**：runtime 内核已成型，当前在补 worker↔coordinator 协调消息层 + CI/治理脚手架，不加新功能。近期主线是"把已实现但未接线的能力接起来，把结构性债务变成自迭代闭环"。

---

## 一、现状

### 1.1 项目定位

- **los** = 轻量 Agent 执行 + 记忆管理平台；TypeScript / pnpm monorepo；11 包 ~87k 行，核心 `@los/agent` 49.4k 行
- los-workspace 的唯一活项目，其余 6 个 legacy 仓库只读参考
- 端口：gateway 8080、executor 8090、PostgreSQL-first（单节点视为一节点 mesh/cloud）
- 包 DAG：`infra → {agent, memory} → gateway → {cli, web, bots}`；executor 作为 mesh 节点平行

### 1.2 已落地能力（成熟）

| 领域 | 状态 |
|---|---|
| ReAct 内核 | `loop.ts` + provider 抽象（OpenAI-compat / Anthropic / Responses）+ 工具能力分级 L0/L1/L2 + 副作用感知并行批处理 + 重试退避 |
| 契约优先 | `contracts/` 11 份 YAML + `check-contracts.sh` + 8 阶段 `ci-gate.sh` |
| 状态机 | `execution-transitions.ts` 迁移表 + `transitionExecutionState()` 单事务 outbox + `check-state-machine-bypass.sh` 白名单 CI 门 |
| PG 队列 | 3+1 套均 `FOR UPDATE SKIP LOCKED` + advisory lock + lease/heartbeat + 死信表 |
| 治理子系统 | 11 类审计 job + drift sweeper + hotspot detector + GA 自修复循环 + 熔断器 + PG LISTEN 唤醒 |
| 记忆 | PG 全文 + 观测 + 压缩（ADR 0020）+ MEMORY.md 同步 + 语义驱逐 + 上下文水位 |
| 多通道 | Telegram / WeClaw / WxPusher / Web 移动面板 + operator SSE + 审批按钮 |
| mesh executor | 独立 executor 节点 + file-sync 队列 + node-command 运维 |
| Stage A 证据 harness | ✅ 完成 2026-06-10 |
| Stage B operator 契约层 | ✅ 已实现（ADR 0021）：RunContract 21 字段、RunPhase 10 态、B0/B-completion 闸门、approve/revise/verify/recover 路由 + CLI |
| Tool-call repair pipeline | ✅ 已实现（ADR 0024）：`healing.ts` 配对修复 + `storm.ts` 风暴抑制，59/59 测试绿 |

### 1.3 已知短板与债务（06-24 审计 + 06-28 自迭代文档）

**架构腐化 / 未接线**
- `@los/input-preprocessor` 整包已移除（2026-07-05）。原本 21 文件 5.5k 行，零 runtime 消费者，过早建设的孤岛。
- Architect/Editor 双模型：~~config/setup/message-builder 全接好，`loop.ts` 从不引用（grep 零命中）~~ **已接线**：`scheduled-task-runner.ts` 在 `runContract.mode === 'architect-editor'` 时传递 `architectEditor: { enabled: true }` 进 loop.ts，loop.ts:116 调用 `runArchitectPhase()` + setup.ts:103 选 editor provider。子 agent（`agent-tools.ts`）通过 AP6 继承配置。
- `deferred-registry`：`preloadDeferredEntries` 函数体只有注释，全仓无人调用（死代码）
- `syncMemoryMd`：文档说"每次新增观测自动更新"，实际 `addObservation` 不调用
- `operatorToken`：config schema 定义了，`auth-middleware.ts` 只查 `auth.token`，operator consent 闸门无强制点

**结构性热点（KG: transitive_loop_depth）**
- `startExecutor` tld=9 —— 全仓最差热点 + bootstrap 盲点（remote 节点只 ensure 2 表，无 migrateDir/ensureAllStores）
- `runScheduledAgentTask` tld=7、`runAssignedAgentTask` tld=7
- `code-intel.extractSymbols` tld=3 + linear_scan_in_loop=1（隐藏 O(n²)）

**配置/硬编码**
- provider URL/模型名 2-4 处重复（AP8）：`config.ts` + `scanners.ts` + `model-profiles.ts`
- 状态字面量散落 5+ 文件，无 typed enum 单一源
- executor 多处 `process.env.*` 直读绕过 `@los/infra/config`
- 开发机绝对路径写死（`firing-range-scan.ts`、`todo-seeds-runtime-core.ts`）
- bot/mcp 默认端口误标 `localhost:3000`（实际网关 8080）
- `.env` 弱 token `test-token-123` 且 `LOS_AUTH_ENABLED=true` 已强制
- WeClaw `curl -sSL .../install.sh | sh` 默认开启（供应链风险）

**队列缺口**
- `file-sync` 队列无 DLQ / 无 max-retry / 无 heartbeat 延展 —— 永久失败文件死循环
- `task_runs` 回收路径无重试计数阈值
- `agent-task-graph` 无 heartbeat 刷新

**provider 语义**
- `finishReason` 截断处理只识别 `'length'`，Anthropic 返回 `'max_tokens'` —— 触顶静默以截断文本完成

---

## 二、当前进行中（未提交，working tree）

**Web 聊天流式重构**（`feat/web-chat-streaming`）：WS 主通道 + SSE 回退、`useChatRun`/`useChatStream` 抽 hook、虚拟列表与 markdown 渲染、审批条与 files 侧栏。worker-messages / P0–P1 已合入 main（#116、chore/remove-input-preprocessor）。

提交前：`pnpm check`、`@los/web` test + build。

---

## 三、规划

### 3.1 Stage 路线图（`agent-workflow-roadmap.md`）

| Stage | 目标 | 状态 |
|---|---|---|
| A 证据 harness | 单次 run 可凭有界证据复盘 | ✅ 2026-06-10 |
| B operator 契约层 | 执行前明确意图行为 | ✅ 已实现（ADR 0021）—— 见下方剩余项 |
| C 个人 eval 语料库 | 重复失败模式 → 20-50 窄 eval | 短中程目标；E01-E10 已文档化 |
| D 状态化 runtime | 中断可检查可恢复 | 部分实现（ADR 0012 Phase 4）；需证 /chat 中断 resume |
| E 受控多 agent | planner/executor/verifier 角色 | 部分实现（DAG store）；硬化 graph UX/provenance/eval 后再加自治 |

**Stage B 剩余**（ADR 0021）：approve/revise 单测 · gateway 路由集成测 · audit→execution→closeout 端到端 smoke · durable child lineage · active execution resume · phase 拒绝/延迟度量 · Web approval UI · stop-condition 运行时强制 · commit-boundary 自动化。

### 3.2 自迭代工程方法（06-28 文档）

AST（los-ast）+ KG（codebase-memory）驱动的 **detect → TODO → fix(Claude /pr-self-merge) → verify(检测器即 oracle) → merge** 闭环，沿 `runChat` 事件流逐模块走：

1. **executor 优先** —— bootstrap 盲点 + tld=9 最差热点（最高 ROI，dual issue）
2. `scheduler/scheduled-task-runner`（tld=7，核心事件流）
3. `loop.runAgent` + setup/phases/tool-runner
4. memory（compaction/retrieval/reflection）
5. task-runs / run-specs / execution-store（状态机）
6. providers/responses（tld=3，流式解析）
7. review-runner / self-check（tld=5）

检测器清单：`migration_drift`（已 live, PR #91）· `unwired_function` · `hotspot_loop` · `file_size` · `two_source_truth` · `executor_bootstrap`。Oracle 驱动 + baseline 保护（grandfather 旧债，只拦新增）+ 一单元一 PR 是安全网。

---

## 四、待办（按优先级）

### P0 —— 已完成 (2026-07-04)

- [x] ~~跑 `pnpm check` + 相关包 test~~ → `pnpm check` 全绿，`pnpm test` 14/14 通过
- [x] ~~决定 escalation/ask/heartbeat 三类消息~~ → 四类消息全部已接线（worker_done / heartbeat / ask / escalation），更新 worker-messages.ts 头部注释反映实际状态
- [x] ~~确认 `wiring-topology-baseline.txt` 无新 orphan~~ → 0 new orphan（251 grandfathered）

### P1 —— 短程 (2026-07-04 完成)

- [x] **executor bootstrap**：`startExecutor` 改用 `ensureAllAgentStores()` 覆盖 27 表（原只 3 表），关闭 remote 节点 schema 盲点
- [x] **Anthropic finishReason 归一**：已由 `normalizeFinishReason()` 修复（三个 provider 全接线，10/10 测试绿）
- [x] **file-sync 队列**：DLQ (`dead_letter` 状态 + MAX_ATTEMPTS=5) + `heartbeatTransferring` 刷新 lease 防误 reap
- [x] **providers CRUD 集成测**：`provider-crud-routes.test.ts` 覆盖 POST/PATCH/DELETE/GET + lifecycle
- [x] **Stage B 收尾**：approve/revise 路由集成测已有（5/5 绿），gateway 67/67 全绿

### SP —— Superpowers 6 启发优化（2026-07-04 完成）

来源：[Superpowers 6 分析](https://blog.fsck.com/2026/06/15/Superpowers-6/) — 50% 更快、60% 更省 token 的通用优化模式。

- [x] **SP-审计: ReAct loop think 限制** — 确认 loop.ts 无硬限制推理轮数。los 无此坑。
- [x] **SP-Eval suite 基础** — `eval-runner.ts` 12/12 测试绿，MockProvider + diff + 报告格式化。
- [x] **SP-Review packet 预生成** — `buildReviewPacket()` 从工具调用元数据提取文件变更，注入 reviewer context。
- [x] **SP-Spec 精简注入** — `loadSpecsForFiles({ mode: 'review' })` 只注入 checklist + quality check，省 ~41%
- [x] **SP-条件模型分层** — `model-tiering.ts` 11/11 测试绿，`scoreComplexity()` 按 prompt/文件数/spec/工具数分层

### P2 —— 中程

- [x] `input-preprocessor`：接入 runtime 消费者，或标弃用并移除 → **已移除**（零运行时消费者，孤岛包，2026-07-05）
- [ ] Architect/Editor 双模型：在 `loop.ts` 真正使用，或移除配置面
- [ ] `deferred-registry`：删死代码或实现 `preloadDeferredEntries`
- [ ] 契约→类型 codegen（消除手写 grep 校验）
- [ ] `@los/agent/src` 治理文件归子目录（25+ `governance-*`/`ga-*`）
- [ ] provider URL/模型名单一化（`provider-defaults.ts`，AP8）
- [ ] 状态枚举单一源（typed enum 替代读侧字符串匹配）
- [ ] executor `process.env` 旁路 → 走 `@los/infra/config`；补 `config.executor.host/port/artifactRoot`
- [ ] Stage C eval 语料：E01-E10 选高风险落测试/探针/文档

### P3 —— 安全/卫生

- [ ] WeClaw curl-pipe 改 opt-in + 校验 `install.sh` 哈希
- [ ] 开发机绝对路径 → env 驱动（`LOS_FIRING_RANGE_ROOTS`）
- [ ] bot/mcp 默认端口 → 复用 `config.server.port`（8080）
- [ ] `.env` `LOS_AUTH_TOKEN` 替换弱口令
- [ ] `operatorToken` 接线到 `auth-middleware`
- [ ] `syncMemoryMd` 在 `addObservation` 自动调用或从文档撤回
- [ ] systemd 模板化 + env 文件

---

## 五、非目标

- 不存原始外部 transcript / auth snapshot / cookie / API key / provider 账号 dump
- 不把每个有用习惯升全局 skill
- 不因别的工具存在就加 CLI fallback（ADR 0018 仍要求能力缺口 + 账本对等 + 权限对等 + 预算 + 退出策略）
- 不在 run spec / 状态迁移 / verification 持久化稳定前上完整 workflow 引擎
- los 当前目标不是替代 Codex/Claude/OpenCode/OMX/browser，而是做它们的**本地证据与治理 harness**：让高自治 agent 工作可检查、可恢复、可打分

---

## 附：验证命令

```bash
pnpm check            # type-check + lint + 结构
pnpm test             # 全量测试
pnpm run gate         # check + test 预推送门
pnpm run status       # gateway 进程 + 健康
pnpm run doctor       # 本地前置 + config + DB
./tools/check-wiring-topology.ts   # orphan 检测（baseline 保护）
```
