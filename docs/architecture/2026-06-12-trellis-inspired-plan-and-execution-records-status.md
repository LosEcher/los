# Trellis- Inspired Design for los + Execution Records Refactoring Status — Task Breakdown

Date: 2026-06-12

## Part 1: Execution Records Refactoring — Current State Assessment

### 已完成 (Complete)

ADR 0021 (`docs/adr/0021-stage-b-operator-contract-implemented-state.md`) 是 Stage B 的权威当前状态声明。以下是逐项核实：

| # | Capability | Source | Lines | Test Evidence |
|---|-----------|--------|-------|---------------|
| 1 | 4-entity state machine (run_spec, task_run, tool_call_state, verification_record) | `execution-transitions.ts` | 152 | 6 tests |
| 2 | Atomic transition store (state + event + outbox) | `execution-store.ts` | 507 | 6 tests |
| 3 | `execution_outbox` table with PG notify | `execution-store.ts:59-77` | — | Schema in store |
| 4 | 10-state `RunPhase` lifecycle + transition map | `run-contract.ts:14-41` | 397 | 16 tests |
| 5 | `PlanStep` / `VerificationRequirement` separated types | `run-contract.ts:48-73` | — | Type-level |
| 6 | `canStartExecution()` B0 pre-exec gate | `run-contract.ts:130-137` | — | Via scheduler.test.ts |
| 7 | `canMarkSucceeded()` pre-completion gate | `run-contract.ts:142-162` | — | Via verification-records |
| 8 | `validatePhaseStatusConsistency()` cross-machine drift detect | `run-contract.ts:174-202` | — | Warning-only |
| 9 | Scheduler B0 enforcement (pre-exec + pre-completion) | `scheduled-task-runner.ts:105-115` | — | 27 tests in scheduler |
| 10 | `approveRunSpecPhase()` operator approval | `run-specs.ts:240+` | 466 | **NO direct test** |
| 11 | `reviseRunSpecPlan()` plan revision + lineage | `run-specs.ts` | — | **NO direct test** |
| 12 | `RunStateProjection` aggregate view | `run-state-vocabulary.ts` | ~150 | 6 tests |
| 13 | Gateway routes: approve, revise-plan, verify, recover, state, events | `run-routes.ts` | — | Partial (events/state only) |
| 14 | CLI: `los run approve/revise-plan/inspect/state/verify/recover` | `run-operations.ts` | — | Wired, not E2E tested |
| 15 | `run_contract_json` JSONB in run_specs + task_runs + todos | `run-specs.ts` | — | Round-trip tests |

**总代码量**: ~2,288 lines (6 core files) + ~500 lines execution-store + ~400 lines run-contract + supporting files = **estimated 3,500+ lines of execution records infrastructure**.

### 未完成 (Gaps)

#### P0 — 架构风险 (from Codex review 2026-06-10)

| Gap | Severity | Detail |
|-----|----------|--------|
| **状态转换绕过路径** | Critical | `scheduler/tool-call-state-persistence.ts:69` 在 transition 被拒时 fallback 到未验证的 `updateToolCallState()`；`scheduler.ts:61,111,142` 直接调用 `updateRunSpecStatus()`；`verification-runner.ts:132,162` 直接调用 `updateRunSpecStatus()`；`tool-call-recovery.ts:182,203,217,248` 直接调用三个低层 API |
| **低层 API 公开导出** | High | `updateTaskRun`, `updateRunSpecStatus`, `updateToolCallState` 全部在 `index.ts` barrel export 中，任何调用方都可以绕过 `transitionExecutionState` |

#### P1 — 测试覆盖缺口 (from ADR 0021)

| Gap | Impact |
|-----|--------|
| `approveRunSpecPhase()` 无单元测试 | Operator 审批流程无回归保护 |
| `reviseRunSpecPlan()` 无单元测试 | Plan 版本管理和 lineage 无回归保护 |
| `POST /runs/:id/approve` 无 gateway 集成测试 | API 契约未验证 |
| `POST /runs/:id/revise-plan` 无 gateway 集成测试 | API 契约未验证 |
| `operator_review` verification kind 路由无测试 | 人工审批类 verification 未覆盖 |

#### P2 — 设计意图未实现 (from roadmap)

| Gap | Detail |
|-----|--------|
| 跨进程 phase 传播 | child agent 和 executor node 不继承 run contract |
| Active execution resume | 无 attempt/retry contract |
| Phase latency/rejection metrics | 无可观测性 |
| Operator approval UI | Web console 无审批界面 |
| Stop-condition runtime enforcement | 类型定义存在，运行时不强制执行 |
| Commit-boundary automation | 未实现 |

---

## Part 2: Trellis 可借鉴方案设计

### 2.1 Spec-by-Package 规范组织

**Trellis 模式**：`.trellis/spec/<package>/<layer>/index.md`，按包组织编码规范，session 启动时自动注入相关 spec。

**los 适配方案**：

```
los/
├── .los/
│   └── spec/
│       ├── infra/index.md        # DB, config, logger 规范
│       ├── agent/
│       │   ├── loop/index.md     # ReAct loop 规范
│       │   ├── provider/index.md # Provider 抽象规范
│       │   └── tool/index.md     # Tool 策略规范
│       ├── memory/index.md       # Memory 检索规范
│       ├── gateway/
│       │   ├── route/index.md    # 路由规范
│       │   └── web/index.md      # React 组件规范
│       └── executor/index.md     # Go sandbox 规范
```

**与 los AGENTS.md 的关系**：`AGENTS.md` 保留为入口 + 架构原则，`.los/spec/` 作为按包的详细规范。Agent session 启动时，根据 task 涉及的包自动加载对应 spec。

### 2.2 Task Context JSONL 注入

**Trellis 模式**：`implement.jsonl` 和 `check.jsonl` 列出需要注入到 sub-agent 的上下文文件。

**los 适配方案**：

利用 los 已有的 `run_contract_json` JSONB 字段，添加 `contextFiles` 数组：

```typescript
// 扩展 RunContractMetadata
interface RunContractMetadata {
  // ... existing fields
  contextFiles?: Array<{
    path: string;       // repo-relative path
    reason: string;     // why this file is relevant
    phase: 'plan' | 'implement' | 'verify';  // which phase needs it
  }>;
}
```

在 `/chat` 创建 run spec 时自动扫描相关 ADR、contract、spec 文件并填充 `contextFiles`。Agent 执行时由 scheduler 按 phase 过滤并注入。

### 2.3 Agent Loop Phase 路由

**Trellis 模式**：`[workflow-state:STATUS]` 面包屑驱动 per-turn 路由决策。

**los 适配方案**：

los 已有 `RunPhase` (10 states)。将 phase 用作 agent loop 中的显式路由信号：

```typescript
// 在 loop.ts 或 agent 主循环中
function routeByPhase(phase: RunPhase): AgentBehavior {
  switch (phase) {
    case 'discovering':  return { allowedTools: ['read', 'search', 'glob'], canWrite: false };
    case 'planning':     return { allowedTools: ['read', 'search', 'glob', 'write'], canWrite: true, targetFiles: ['prd.md'] };
    case 'executing':    return { allowedTools: ['all'], canWrite: true };
    case 'verifying':    return { allowedTools: ['read', 'bash'], canWrite: false, readOnlyDiff: true };
  }
}
```

### 2.4 Lifecycle Hooks

**Trellis 模式**：`config.yaml` 中的 `after_create / after_start / after_finish / after_archive` hooks。

**los 适配方案**：

```typescript
// 在 run_specs 或 task_runs 生命周期中
interface TaskLifecycleHooks {
  afterCreate?: string[];   // scripts to run
  afterStart?: string[];
  afterFinish?: string[];
  afterArchive?: string[];
}
```

每个 hook 接收 `TASK_JSON_PATH` 或 `RUN_SPEC_ID` 环境变量。Hook 失败打印警告但不阻塞主操作。

### 2.5 Anti-Pattern Documentation

**Trellis 模式**：workflow.md 中显式列出 DO NOT SKIP 反模式。

**los 适配方案**：在 `AGENTS.md` 中增加 "Anti-Patterns" section：

| 反模式 | 后果 | 预防 |
|--------|------|------|
| 跳过 phase gate 直接执行 tool call | 未审批的 plan 被执行 | Scheduler B0 gate (已实现) |
| 低层 API 绕过 transitionExecutionState | 状态变更无 event/outbox | 收窄 API 可见性 (待实现) |
| Plan 输出仅在 chat memory 中 | Session 关闭后丢失 | 持久化到 run_contract_json (已实现) |
| Verification 未完成就标记 succeeded | 未验证的代码合入 | canMarkSucceeded gate (已实现) |
| Child agent 不继承 run contract | 子任务无 phase 约束 | 跨进程 propagation (待实现) |

---

## Part 3: Task Breakdown

### 优先级说明

- **P0** — 架构 invariant 修复，不修复则所有上层保证都有已知绕过路径
- **P1** — 证据覆盖补齐，让已完成实现有回归保护
- **P2** — Trellis 模式迁移，增强 agent 行为可控性
- **P3** — 远期能力，Roadmap 已规划但非阻塞

---

### T1 [P0] 收窄低层状态 API 的绕过路径

**当前状态**：`updateTaskRun()`, `updateRunSpecStatus()`, `updateToolCallState()` 公开导出，被 scheduler、verification-runner、tool-call-recovery 等多个调用方直接使用，绕过 `transitionExecutionState` 的事务性保证。

**任务内容**：
1. 审计所有 3 个低层 API 的调用方（`scheduler.ts`, `verification-runner.ts`, `tool-call-recovery.ts`, `tool-call-state-persistence.ts` fallback path）
2. 将可以迁移到 `transitionExecutionState` 的调用方迁移
3. 对**必须**绕过验证的路径（如 recovery 修复损坏状态、executor NDJSON 流跳过中间态），加上 explicit audited exception marker：调用 `appendSessionEvent('low_level_update', {reason, caller, entityType, entityId})` 记录绕过事件
4. 将 `updateTaskRun` 的状态变更能力拆分为两个函数：`updateTaskRunMetadata()`（允许非状态字段更新）和内部使用的状态变更（不公开导出）
5. `tool-call-state-persistence.ts` 的 catch fallback 路径（line 69）添加 `tool_call_state.fallback_update` session event（已部分实现），并确保该 event 包含足够的调用栈信息用于审计

**收益**：
- 消除 Codex 评审指出的 #1 架构风险
- 确保所有状态变更要么通过验证、要么产生显式的审计记录
- 为 Phase C（compaction）和 Phase D（multi-gateway replay）提供可靠的事件基础

**成功标准**：
- `grep -rn "updateTaskRun\b\|updateRunSpecStatus\b\|updateToolCallState\b" packages/agent/src/ --include='*.ts' | grep -v test | grep -v '.d.ts'` 只剩 audited exception 路径
- `pnpm check` 通过
- `pnpm test` 全部通过
- 新增 test：验证每个绕过路径都发出了 audit event

**改动范围**：`packages/agent/src/` (execution-store, task-runs, run-specs, tool-call-states, scheduler, verification-runner, tool-call-recovery, tool-call-state-persistence, index.ts)

**估计工作量**：2-3 天

---

### T2 [P1] 补齐 Stage B 测试覆盖

**当前状态**：ADR 0021 列出了 9 个测试覆盖缺口，其中 `approveRunSpecPhase` 和 `reviseRunSpecPlan` 无任何测试。

**任务内容**：
1. `approveRunSpecPhase()` 单元测试：正常审批、非法 phase 转换被拒、重复审批幂等
2. `reviseRunSpecPlan()` 单元测试：正常修订、planRevision 递增、planParentRunSpecId lineage、phase 重置为 planning
3. `POST /runs/:id/approve` gateway 集成测试
4. `POST /runs/:id/revise-plan` gateway 集成测试
5. `operator_review` verification kind 的路由测试
6. Plan revision lineage 的端到端测试

**收益**：
- 让 ~3,500 行 execution records 代码获得回归保护
- 消除 ADR 0021 的 "Gaps — Capabilities Without Test or Smoke Evidence" 整节
- Operator 审批流程可安全迭代

**成功标准**：
- 上述 6 项各有至少 2 个 test case
- `pnpm test` 全部通过，新增 test 数 ≥ 12
- ADR 0021 的 gaps 表可更新为 "Covered"

**改动范围**：`packages/agent/src/run-specs.test.ts`, `run-contract.test.ts`, `packages/gateway/src/routes/run-routes.test.ts`

**估计工作量**：1-2 天

---

### T3 [P1] Spec-by-Package 结构初始化

**当前状态**：los 只有单文件 `AGENTS.md` + `SKILL.md` + `docs/adr/`。缺少按包组织的编码规范，agent session 无法按涉及包自动注入相关规范。

**任务内容**：
1. 创建 `.los/spec/` 目录结构（infra, agent/loop, agent/provider, agent/tool, memory, gateway/route, gateway/web, executor）
2. 从现有 `AGENTS.md` 提取包级规则，写入对应 `index.md`
3. 每个 `index.md` 遵循 Trellis 的三段式：Pre-Development Checklist + Coding Guidelines + Quality Check
4. 在 `packages/agent/src/` 中添加 `spec-loader.ts`：根据 run contract 的 `editableSurfaces` 或 task 涉及的包，自动加载相关 spec 文件内容
5. 在 session 启动时（`/chat` 或 scheduler），将匹配的 spec 注入到 system prompt 或 context

**收益**：
- 解决 AGENTS.md 信息密度过高的问题（当前单文件承载所有规则）
- Agent session 获得精准的上下文注入，减少规则遗漏
- 新增包时只需添加对应 spec 文件，不影响全局

**成功标准**：
- `.los/spec/` 下每个包的 `index.md` 非空
- `spec-loader.ts` 能根据 `editableSurfaces: ['packages/agent/src/loop.ts']` 正确加载 `agent/loop/index.md`
- `pnpm check` 通过
- 不破坏现有 `AGENTS.md` 的入口角色

**改动范围**：新增 `.los/spec/` 目录 + `packages/agent/src/spec-loader.ts`，微调 `packages/agent/src/loop.ts` 或 scheduler 的 context 组装逻辑

**估计工作量**：1-2 天

---

### T4 [P2] Task Context JSONL 注入机制

**当前状态**：run contract 有 `requiredChecks`, `editableSurfaces`, `evidenceRequired` 等字段，但缺少结构化的"注入哪些文件到 agent context"的机制。

**任务内容**：
1. 扩展 `RunContractMetadata` 添加 `contextFiles` 字段（`Array<{path, reason, phase}>`）
2. 在 `normalizeRunContractMetadata()` 中添加 `contextFiles` 的 normalization
3. 更新 `contracts/run-spec.yaml` 的 `runContract` schema
4. 在 scheduler 的 pre-exec 阶段，根据当前 phase 过滤 `contextFiles` 并注入到 agent context
5. 在 `/chat` 创建 run spec 时自动扫描涉及的 ADR 和 spec 文件，填充初始 `contextFiles`

**收益**：
- 让 task 执行更精准：实现阶段注入参考实现，审查阶段注入质量标准
- 减少 agent "忘记"项目约定的概率
- 为未来的 context window 预算管理提供结构化输入

**成功标准**：
- `contextFiles` 在 run_contract_json 中正确序列化/反序列化
- Scheduler 在 `executing` phase 注入了 `phase: 'implement'` 的文件，在 `verifying` phase 注入了 `phase: 'verify'` 的文件
- `pnpm check && pnpm test` 通过

**改动范围**：`run-contract.ts`, `contracts/run-spec.yaml`, `scheduled-task-runner.ts`, `/chat` 创建逻辑

**估计工作量**：1-2 天

---

### T5 [P2] Agent Loop Phase 路由

**当前状态**：`RunPhase` 定义了 10 个 phase，scheduler 的 B0 gate 强制了 pre-exec 和 pre-completion 检查，但 agent 主循环（`loop.ts`）不感知当前 phase。

**任务内容**：
1. 在 agent loop 中读取当前 `runContract.phase`
2. 按 phase 限制可用工具：
   - `discovering/planning`: 只读工具 + write（仅限于 plan 文件）
   - `executing`: 全部工具
   - `verifying`: 只读工具 + bash（lint/test）
3. Phase 不匹配时拒绝 tool call 并记录 `tool_call_state.fallback_update` 事件
4. Phase 自动推进：当 plan 写入完成 → 自动推进到 `plan_approved`（或等待 operator approval），执行完成 → 自动推进到 `verifying`

**收益**：
- Agent 行为与 phase 契约一致，不会在 planning 阶段执行破坏性操作
- 为 Fleet Loop（多 agent 协作）提供 phase-aware 基础
- 减少 agent "跳步"导致的质量问题

**成功标准**：
- Agent 在 `planning` phase 拒绝执行 `bash rm -rf` 类破坏性工具
- Agent 在 `verifying` phase 只能运行检查和读文件
- `pnpm check && pnpm test` 通过
- 新增 focused harness：phase-tool-gate.test.ts

**改动范围**：`packages/agent/src/loop.ts`（或 tool policy 层），`run-contract.ts`（phase 推进逻辑）

**估计工作量**：2-3 天

---

### T6 [P2] Lifecycle Hooks 机制

**当前状态**：无 task/run 生命周期的可扩展 hook 机制。

**任务内容**：
1. 在 `run-specs.ts` 中添加 `TaskLifecycleHooks` 类型
2. 在 `run_contract_json` 中支持 `hooks` 字段
3. 在 `createRunSpec()`, scheduler task start, scheduler task finish, `archiveRunSpec()` 等生命周期点调用对应 hook
4. Hook 执行：`child_process.spawn` 运行脚本，接收 `RUN_SPEC_ID` / `TASK_RUN_ID` 环境变量
5. Hook 失败打印 warning + 记录 session event，不阻塞主操作

**收益**：
- 自动化 task 前后的健康检查、资源清理、通知
- 可扩展 — 用户可自定义 hook 脚本而不修改 los 核心代码

**成功标准**：
- `afterCreate` hook 在 run spec 创建后执行
- Hook 失败时 task 仍然正常完成，warning 出现在日志中
- `pnpm check && pnpm test` 通过

**改动范围**：`run-specs.ts`, `run-contract.ts`, `scheduled-task-runner.ts`

**估计工作量**：1-2 天

---

### T7 [P3] 跨进程 Phase 传播

**当前状态**：child agent（`agent-tools.ts` 中的 `spawn_agent`）和 executor node 不继承 parent 的 run contract。

**任务内容**：
1. Child agent 创建时从 parent task run 继承 `runContract`（phase, plan, verifications）
2. Executor node 通过 NDJSON stream 或 HTTP header 接收 `runContract`
3. Child agent 的 tool policy 同样受 phase gate 约束
4. Child agent 的状态变更回传播到 parent 的 `task_runs` 和 `session_events`

**收益**：
- Fleet Loop 的基础 — 所有 agent（parent + child）共享同一 phase 契约
- 递归 agent 调用的行为可控

**成功标准**：
- Child agent 在 `planning` phase 时不能执行非 plan 写入
- Child 的 tool call state 记录在 parent 的 `run_spec` 下
- `pnpm check && pnpm test` 通过

**改动范围**：`agent-tools.ts`, `executor/` (Go), `scheduled-task-runner.ts`, `run-contract.ts`

**估计工作量**：3-5 天

---

### T8 [P3] Anti-Pattern 文档化

**当前状态**：反模式分散在 Codex 评审和 ADR 中，未集中在 AGENTS.md。

**任务内容**：
1. 在 `AGENTS.md` 中新增 "Anti-Patterns" section
2. 汇总 Codex 评审发现的 5 个反模式 + Trellis workflow.md 中的 4 个反模式 + los 实践经验
3. 每个反模式包含：症状、后果、预防机制、相关代码位置

**收益**：
- 低投入（纯文档），高参考价值
- 新贡献者和 AI agent 都能快速了解已知陷阱

**成功标准**：
- `AGENTS.md` 中有 ≥ 8 个反模式条目
- 每个条目有代码位置引用

**改动范围**：`AGENTS.md` only

**估计工作量**：0.5 天

---

## Part 4: 执行顺序建议

```
Week 1-2 (立即):
  T1 [P0] 收窄低层 API 绕过路径        ← 架构 invariant 修复
  T2 [P1] 补齐 Stage B 测试覆盖        ← 与 T1 并行，不同文件
  T8 [P3] Anti-Pattern 文档化          ← 低投入，穿插完成

Week 2-3:
  T3 [P1] Spec-by-Package 结构初始化   ← 依赖 T1/T2 的代码稳定
  T4 [P2] Task Context JSONL 注入      ← 依赖 T3 的 spec 结构

Week 3-4:
  T5 [P2] Agent Loop Phase 路由        ← 依赖 T1 的 API 收窄
  T6 [P2] Lifecycle Hooks              ← 独立，可与 T5 并行

Future:
  T7 [P3] 跨进程 Phase 传播            ← 依赖 T5 的 loop phase 路由成熟
```

### 为什么 T1 必须最先做

Codex 2026-06-10 评审的结论是明确的：

> "Without this, every durability claim (B0 enforcement, cross-gateway recovery, compaction evidence) sits on a foundation with known bypass paths."

T1 修复后，T2-T7 的所有测试和功能都建立在可靠的状态转换基础上。反过来，如果先做 T3-T6，它们的功能正确性依赖于一个存在已知绕过路径的状态机——测试可能通过但运行时仍会被绕过。

---

## Part 5: 收益矩阵

| Task | 架构风险降低 | 证据/测试覆盖 | Agent 行为可控性 | 迭代速度 | 投入 |
|------|-------------|--------------|-----------------|---------|------|
| T1 收窄绕过路径 | ★★★★★ | ★★★ | ★★★★ | ★★★ | 2-3d |
| T2 测试补齐 | ★★★ | ★★★★★ | ★★ | ★★★★ | 1-2d |
| T3 Spec 组织 | ★★ | ★★★ | ★★★★ | ★★★★ | 1-2d |
| T4 Context 注入 | ★★ | ★★★ | ★★★★★ | ★★★ | 1-2d |
| T5 Phase 路由 | ★★★★ | ★★★ | ★★★★★ | ★★★ | 2-3d |
| T6 Lifecycle Hooks | ★★ | ★★ | ★★★ | ★★★ | 1-2d |
| T7 跨进程传播 | ★★★ | ★★ | ★★★★★ | ★★ | 3-5d |
| T8 反模式文档 | ★ | ★★ | ★★★ | ★★★ | 0.5d |

**最高 ROI 前三**：T1（架构安全）> T5（行为可控）> T3（规范管理）
