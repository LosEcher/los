# los 项目现状、规划与待办

> **基线刷新**：2026-07-09（运行盘点 + AST/KG/wiring 拓扑）
> 历史审计：2026-07-03 工作树；上游 `AGENTS.md` / `SKILL.md` / ADR 0012、0020、0021、0024
>
> 文档结构：**当前基线 → 已完成并接线 → 待验证 → 真实 open backlog**。过期 checklist 不再当活待办。

## 一句话结论

项目处于**自我治理基建期**：runtime 内核已成型。近期主线是压低账本噪声、打通 episodic 记忆输入、收敛 procedural 候选写路径（ADR 0020），而不是再拆 ReAct loop。

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

**架构腐化 / 未接线（仍 open）**
- `@los/input-preprocessor` 整包已移除（2026-07-05）。
- Architect/Editor 双模型：**已接线**（`loop.ts` → `runArchitectPhase`；mode `architect-editor`）。**待验证**：端到端 harness / 调度 run 证据，不是「未实现」。
- 记忆维护：**已接线**（`server-maintenance.ts` 启动 10s + 每日 retention/integrity/auto-compact）。
- `deferred-registry`：`preloadDeferredEntries` 函数体只有注释，全仓无人调用（死代码）
- `syncMemoryMd`：文档曾写「每次新增观测自动更新」，实际 `addObservation` 不调用
- `operatorToken`：config schema 定义了，`auth-middleware.ts` 只查 `auth.token`，operator consent 闸门无强制点
- `memory-lifecycle.ts`（agent）：wiring orphan，**不要**当 P0 接线面

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

### P0 —— 2026-07-09 运行面 / 记忆账本（本轮）

- [x] Governance sweep 空转不写 `session_events`（dueCount=0 / noop）
- [x] `sessionEventVisibility`：`governance.*` → audit；session list 默认隐藏 internal
- [x] `/chat` 默认 `persistChatDefault=true` 写 episodic observation；openai-compat 保持 false
- [x] procedural candidate confidence ≥ 0.5；GA 旁路写显式 confidence + upsert；禁止 conf=0 入库

### P2 —— 中程

- [x] `input-preprocessor`：接入 runtime 消费者，或标弃用并移除 → **已移除**（2026-07-05）
- [x] Architect/Editor 双模型：**已接线** → 剩余项移到「待验证」
- [ ] ~~Architect/Editor：**待验证** mode 端到端 harness / 调度证据（非实现缺口）~~ → harness 测试已添加（`loop/architect-integration.test.ts`），通过 mock 证明 architect → plan-injection → editor 全路径。调度 run 证据仍需一次真实 provider 运行 [I]
- [ ] `deferred-registry`：删死代码或实现 `preloadDeferredEntries`
- [ ] 契约→类型 codegen（消除手写 grep 校验）
- [ ] `@los/agent/src` 治理文件归子目录（25+ `governance-*`/`ga-*`）
- [ ] provider URL/模型名单一化（`provider-defaults.ts`，AP8）
- [ ] 状态枚举单一源（typed enum 替代读侧字符串匹配）
- [ ] executor `process.env` 旁路 → 走 `@los/infra/config`；补 `config.executor.host/port/artifactRoot`
- [ ] Stage C eval 语料：E01-E10 选高风险落测试/探针/文档
- [ ] promote/attest 生产 UI（有 conf≥0.7 跨 session 候选后再做）
- [ ] `loadSpecsForFiles` 包 cwd 短路径（`src/foo.ts`）

### P3 —— 安全/卫生

- [ ] WeClaw curl-pipe 改 opt-in + 校验 `install.sh` 哈希
- [ ] 开发机绝对路径 → env 驱动（`LOS_FIRING_RANGE_ROOTS`）
- [ ] bot/mcp 默认端口 → 复用 `config.server.port`（8080）
- [ ] `.env` `LOS_AUTH_TOKEN` 替换弱口令
- [ ] `operatorToken` 接线到 `auth-middleware`
- [ ] `syncMemoryMd` 在 `addObservation` 自动调用或从文档撤回
- [ ] systemd 模板化 + env 文件

---

## 六、IM + Web 交互设计（2026-07-10）

### 6.1 现状摸底（2026-07-10 运行时核实）

**核心运行时**：
- gateway: pid=73607, port=8080, health=ok, uptime ~20h [E]
- executor: pid=73506, port=8090, health=ok, nodeId=mbp-executor-1, status=online, candidate=true [E]
- executor warning: resource:memory_pressure [E]

**IM 通道运行时状态**：
- WeChat (WeClaw): **installed=true, daemonRunning=false** — 二进制在 `/Users/echerlos/go/bin/weclaw`，账号已绑定（1 个 WeChat 用户），但 daemon 未运行 [E]
- Telegram: planned，未实现 [E]
- Web 移动面板: `live=true`，在 `:8899/m/` 运行 [I]

**Provider 状态**：
- packycode (GPT-5.5)、deepseek-anthropic (v4-pro)、minimax (M3)、custom (GPT-5.5 via Cliproxy)、deepseek (v4-flash)、deepseek (v4-pro) 共 6 个已发现 [E]
- provider health diagnostics: **空**——无 provider 有健康记录，无 repair 计数器 [E]
- 记忆观测: **0 条**——persistChatDefault=true 已配置，但历史 session 未被持久化为 episodic observation [E]
- 最近 session: 2026-07-04 的两次 deepseek run（一次 succeeded, 一次 read-only succeeded），距今 6 天 [E]

**IM 通道**：
- WeChat：WeClaw（主通道，仅出站）+ WxPusher（回调入站，支持 `#approve`/`#deny` 等命令）+ Web 移动面板（只读 + 操作按钮）
- Telegram：SSE 消费 + inline keyboard（Approve/Deny/Escalate 按钮）+ 轮询/Webhook 入站
- 共享 `MessageRouter`（`resolveIntent`），命令词：`#approve` `#deny` `#escalate` `#status` `#task` `#run` `#claude` `#codex` `#jobs` `#sweep` `#governance`
- 共同问题：只有 session 级 tool steering，无 RunContract 阶段审批概念

**Web 面板**：
- 19 个页面（chat/sessions/todos/tasks/memory/providers/skills/mcp/services/artifacts/rules/evals/nodes/run-specs/logs/dead-letter/diagnostics/file-sync/communication-accounts/settings）
- Run Specs 页有 Approve/Reject 按钮（但 payload 与后端期望不匹配：发 `{approved: true}` 但后端期望 `{actor, reason}`）
- Chat 页 ApprovalCard 只读、AbortConfirmation 可交互
- Revise Plan / Worker Answer 只有后端路由，无 UI
- WebSocket operator steering 是占位注释（`ws-routes.ts:182`）
- Web 无 SSE 实时订阅，靠轮询

### 6.2 交互模型

```
┌─────────────┐     SSE/WS      ┌─────────────┐
│  los agent  │ ──operator────▶ │   gateway    │
│  (runtime)  │   attention     │  (hub)       │
└─────────────┘                 └──────┬──────┘
                                       │
              ┌────────────────────────┼────────────────────────┐
              │                        │                        │
              ▼                        ▼                        ▼
        ┌──────────┐           ┌──────────┐            ┌──────────┐
        │  WeChat  │           │ Telegram │            │   Web    │
        │ (via IM) │           │  (bot)   │            │ (panel)  │
        └────┬─────┘           └────┬─────┘            └────┬─────┘
             │                      │                       │
             ▼                      ▼                       ▼
    POST /sessions/:id      POST /sessions/:id      POST /runs/:id
    /operator-events        /operator-events        /approve|revise-plan
    (steering)              (steering)              /verify|recover|answer
```

**三通道分工**：
| 通道 | 适合 | 不适合 |
|------|------|--------|
| WeChat | 快速审批（`#approve abc123`）、告警推送 | 复杂 RunContract 查看、多选操作 |
| Telegram | 同上 + inline button 更精准 | 同上 |
| Web | 深度查看 RunContract 全貌、plan/evidence/verification 对比、批量操作 | 移动端即时审批（需开浏览器） |

### 6.3 需补齐的缺口

**P0 — 纠正已有但错误的部分**：
- [x] Web Run Specs 页审批 payload：`{approved: true, note}` → `{actor: string, reason: string}`（2026-07-10：`buildRunOperatorPayload`；Reject 走 `/recover` cancel）
- [x] Chat 页 ApprovalCard 从只读升级为可交互（调用 `POST /sessions/:id/operator-events`）（2026-07-10）
- [x] WebSocket 实现 operator steering（`ws-routes.ts` steering/cancel + steering.ack）（2026-07-10）

**P1 — 补 RunContract IM 命令**：
- [x] `resolveIntent` 新增：`#approve-phase <runId>` `#revise-plan <runId>` `#verify-run <runId>`（2026-07-10 + handlers-run-contract）
- [ ] `OperatorAlert` 接口增加 `runContract` 字段（phase, plan steps, blockers, verification status）
- [ ] Telegram inline button 增加 "Approve Phase" / "Revise Plan" 按钮
- [ ] SSE `operator_attention` 事件增加 RunContract 阶段变更类型

**P1 — Web 交互补齐**：
- [ ] Run Specs 页增加 Revise Plan 面板（调用 `POST /runs/:id/revise-plan`）
- [x] Run Specs 页增加 Verify 按钮（已有后端路由）（2026-07-10）
- [ ] Worker Answer UI（调用 `POST /runs/:id/answer`）
- [ ] Web 客户端订阅 `/operator/events/live` SSE（实时推送替代轮询）
- [ ] Communication Accounts 页绑定审批权限（哪个 WeChat 用户可审批哪些 run）

**P2 — 深度集成**：
- [ ] RunContract 创建时选通知识别（"审批通知发 WeChat" / "发 Telegram"）
- [ ] 多步骤 DAG 的每步完成/失败 IM 通知
- [ ] IM 内直接查看 run evidence 摘要（不切到 Web）
- [ ] Web 端 RunContract 模板库（常用 contract 一键创建）

### 6.4 判断指标

每个 Stage 完成后检查：

| 指标 | Stage B（当前） | Stage C | Stage D | Stage E |
|------|----------------|---------|---------|---------|
| 能否通过 IM 审批一次 run？ | 部分（tool 级可，phase 级不可） | ✅ | ✅ | ✅ |
| 能否在 Web 查看完整 RunContract？ | ✅（Run Specs 页） | ✅ | ✅ | ✅ |
| 能否在 Web 审批/修订/验证？ | 部分（approve 可但 payload 错） | ✅ | ✅ | ✅ |
| Agent 中断后能否从 Web 恢复？ | ❌ | ❌ | ✅ | ✅ |
| 能否在 Web 查看 DAG 依赖图？ | 部分（Agent Graph 页） | 部分 | 部分 | ✅ |
| 多 agent 结果能否在 Web 对比？ | ❌ | ❌ | ❌ | ✅ |

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
