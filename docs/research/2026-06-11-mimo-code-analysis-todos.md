# MiMo-Code 分析 TODO 清单

> 来源: `docs/research/2026-06-11-mimo-code-analysis.md`
> 日期: 2026-06-11
> 评估: 2026-06-17 (结论见 `docs/research/2026-06-17-mimo-p0-evaluation.md`)
> 状态: P0 已评估 — P0-1 ✅启动, P0-2 ✅启动(缩小范围), P0-3 ⚠️推迟→P1

---

## P0 — 立即评估 (本周可启动)

### TODO-P0-1: Checkpoint-Writer 自动快照 → **✅ 启动** (2026-06-17 评估通过)

- [ ] **调研**: 阅读 los 的 `memory_compactions` 表结构和 `compactSession()` 实现
- [ ] **设计**: 定义 `auto_checkpoint` 触发条件
  - Session event count 阈值 (每 N 个 events)
  - Tool call state change (tool 完成时)
  - Time-based fallback (每 M 分钟)
- [ ] **实现**: `packages/agent/src/checkpoint-writer.ts`
  - `ensureCheckpointStore()` — 扩展现有 `memory_compactions` 表或新建 `session_checkpoints`
  - `writeCheckpoint(sessionId)` — 增量写当前 session 快照
  - `getLatestCheckpoint(sessionId)` — 恢复时读取
  - `autoTrigger` 字段区分手动/自动
- [ ] **集成**: Session event hook — 在 event 写入后检查触发条件
- [ ] **测试**: checkpoint 写入不丢数据、恢复路径正确
- [ ] **ADR**: 补充 ADR 0020 或新建 ADR 说明自动 checkpoint 决策

**预估**: 2-3 天
**依赖**: 无 (ADR 0020 已有基础设施)

---

### TODO-P0-2: 独立 Judge Model 停止条件评估 → **✅ 启动(缩小范围)** (2026-06-17 评估通过)

- [ ] **调研**: 阅读 ADR 0007 (provider loop) 和 agent 停止逻辑
- [ ] **设计**: `GoalEvaluator` 模块
  - 输入: session messages + goal condition
  - 输出: `{satisfied: boolean, confidence: number, reasoning: string}`
  - Judge 使用不同 provider/model 保证独立性
- [ ] **实现**: `packages/agent/src/goal-evaluator.ts`
  - `evaluateGoal(sessionId, goalCondition)` — 调 judge model
  - 配置: `judge_provider`, `judge_model` in config schema
  - 集成到 agent loop: agent 提出停止 → judge 评估 → 允许/拒绝
- [ ] **测试**: judge 正确识别目标达成/未达成
- [ ] **配置**: 扩展 Zod config schema 加 `judge` section

**预估**: 2-3 天
**依赖**: ADR 0007 (provider loop)

---

### TODO-P0-3: 自动触发 Compaction (Dream 对标) → **⚠️ 推迟→P1** (2026-06-17 核心已满足, 降级)

- [ ] **调研**: 阅读 `packages/memory/src/compaction.ts` 完整实现
- [ ] **设计**: `DreamRunner` 定时任务
  - Session 结束 hook → 自动调 `compactSession()`
  - 过时记忆检测: `evidence_count` 衰减 + 时间衰减
  - 生成 `procedural_candidates` (draft 状态)
  - **保持 operator gate**: 不自动 promote 为 rule
- [ ] **实现**: `packages/agent/src/dream-runner.ts`
  - `runDreamCycle()` — 扫描最近 sessions → compact → 检测过时
  - `markStaleMemories()` — 标记过期候选
  - Session close hook 集成
- [ ] **测试**: auto compact 产生正确候选、过时标记正确
- [ ] **ADR**: 补充 ADR 0020 说明自动发现 vs 人工审批的边界

**预估**: 1-2 天
**依赖**: ADR 0020, `packages/memory/src/compaction.ts`

---

## P1 — 近期评估 (本月可启动)

### TODO-P1-4: 上下文重建协议

- [ ] **调研**: 理解 los 当前 session replay 机制和 token 使用
- [ ] **设计**: `ContextReconstruction` 协议
  - 触发: context window 使用率 > 阈值
  - 输入: checkpoint + MEMORY.md + task progress + retained recent messages
  - 输出: 重建后的 context (token budget 内)
- [ ] **实现**:
  - `packages/agent/src/context-reconstruction.ts`
  - 与 provider loop (ADR 0007) 集成
  - 与 checkpoint-writer (TODO-P0-1) 集成
- [ ] **测试**: 重建后 agent 能正确继续任务
- [ ] **ADR**: 新建 ADR 说明上下文重建决策

**预估**: 4-5 天
**依赖**: TODO-P0-1 (checkpoint-writer), ADR 0007

---

### TODO-P1-5: 动态 Subagent 创建

- [ ] **调研**: 阅读 los DAG task graph 和 run contract 实现
- [ ] **设计**: `SubagentSpawner` 模块
  - Primary agent 在 tool call 中创建 subagent
  - Subagent 共享 session_id，独立 tool_call_states
  - 生命周期: `spawned → running → completed/failed/cancelled`
  - 复用 run contract 状态机
- [ ] **实现**:
  - `packages/agent/src/subagent/spawner.ts`
  - `packages/agent/src/subagent/lifecycle.ts`
  - Tool: `spawn_subagent` (agent 可调用的 tool)
  - Gateway route: `POST /sessions/:id/subagents`
- [ ] **集成**: 第一个内置 subagent = checkpoint-writer (TODO-P0-1)
- [ ] **测试**: spawn、并行执行、取消、失败恢复
- [ ] **ADR**: 新建 ADR 说明 subagent 架构决策
- [ ] **Contracts**: 更新 `contracts/` 添加 subagent API

**预估**: 5-7 天
**依赖**: TODO-P0-1 (checkpoint-writer), run contract (ADR 0012)

---

### TODO-P1-6: 重复工作流发现 (Distill 对标)

- [ ] **调研**: 分析 `tool_call_states` 表结构，确定 pattern 提取可行性
- [ ] **设计**: `WorkflowPatternDetector`
  - Pattern 定义: 同类型 tool call 序列 (如 `read_file → edit → write → test`)
  - 检测: 同 pattern 出现 ≥3 次 → candidate
  - 置信度评分: 基于 frequency + consistency
  - 打包候选: `workflow_template` (可复用的 run contract 模板)
- [ ] **实现**:
  - `packages/agent/src/workflow-pattern-detector.ts`
  - `POST /memory/distill` gateway route
  - `los memory distill` CLI command
- [ ] **审批**: 操作员审批后转为 `skill` 定义 (保持 ADR 0020 审批门)
- [ ] **测试**: pattern 检测准确性、误报率
- [ ] **ADR**: 补充 ADR 0020 说明 distill 流程

**预估**: 5-7 天
**依赖**: ADR 0020, tool_call_states schema

---

## P2 — 远期参考 (下季度)

### TODO-P2-7: Token-Budget 感知记忆注入

- [ ] 在 `packages/memory/src/retrieval.ts` 加 `maxTokens` 参数
- [ ] 按 relevance score 排序截断
- [ ] 与 context reconstruction (TODO-P1-4) 集成

**预估**: 2-3 天
**依赖**: 无直接依赖

---

### TODO-P2-8: Runtime 模式切换 (Web UI)

- [ ] Web UI 加模式选择器: `build` / `plan` / `verify`
- [ ] plan 模式 → 只读 tool permissions
- [ ] 配置持久化到 session

**预估**: 2-3 天
**依赖**: Web UI (`packages/gateway`)

---

### TODO-P2-9: 一键配置迁移工具

- [ ] 读取 `~/.claude/settings.json` → 映射到 `~/.los/config.yaml`
- [ ] 读取 `~/.codex/config.toml` → 映射
- [ ] 支持 `los config import claude-code` / `los config import codex`

**预估**: 1-2 天
**依赖**: 无

---

### TODO-P2-10: Compose Mode 编排模板

- [ ] Run contract 加 `workflow_template` 字段
- [ ] 定义可配置的 phase 序列 (非硬编码 7 阶段)
- [ ] 与 workflow pattern detector (TODO-P1-6) 集成

**预估**: 3-4 天
**依赖**: TODO-P1-6, run contract (ADR 0012)

---

### TODO-P2-11: Nix Flakes 开发环境

- [ ] 评估 los 团队对 Nix 的接受度
- [ ] 创建 `flake.nix` 锁定 Node.js, pnpm, PostgreSQL 版本
- [ ] 文档: 如何用 `nix develop` 进入开发环境

**预估**: 2-3 天
**依赖**: 团队评估

---

### TODO-P2-12: Oxlint 补充检查

- [ ] 评估 oxlint 与现有 `tsc --noEmit` 的互补性
- [ ] 添加 `oxlint` 到 `pnpm check` 流程 (不影响 tsc)
- [ ] CI 集成

**预估**: 1 天
**依赖**: 无

---

## 完成标准

- 每个 TODO 完成后需提供: 代码 PR + 测试通过 + ADR 更新 (如适用) + Operation smoke
- P0 项需在 2026-06-18 前完成评估 (决定启动/推迟/放弃)
- P1 项需在 2026-06-30 前完成评估
- P2 项为持续 backlog，不设截止日期
