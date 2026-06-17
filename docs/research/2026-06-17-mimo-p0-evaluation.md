# MiMo P0 评估报告 — 2026-06-17

> 对 `docs/research/2026-06-11-mimo-code-analysis-todos.md` P0 三项的评估结论。
> 评估截止: 2026-06-18。 结论: 启动 / 推迟 / 放弃。

---

## TODO-P0-1: Checkpoint-Writer 自动快照

**结论: ✅ 启动**

### 现状

| 已有能力 | 位置 |
|---------|------|
| `memory_compactions` 表 + `compactSession()` pipeline | `packages/memory/src/compaction.ts` |
| `session_events` ledger (append-only event source) | `packages/agent/src/session-events.ts` |
| Session replay via SSE `?since=` cursor | `packages/gateway/src/routes/sse-routes.ts` |
| Compaction dedup guard + advisory lock | compaction.ts (今日提交) |
| Session event hook in chat-service | `packages/gateway/src/chat-service.ts` |
| `return null` for empty sessions | compaction.ts (今日提交) |

### 缺口

1. 无增量 checkpoint — `compactSession()` 是全量 session 快照
2. 无 `autoTrigger` 字段区分手动/自动
3. 无触发条件: event count 阈值、tool call state change、time-based fallback
4. 无 `getLatestCheckpoint(sessionId)` 恢复接口
5. 无 mid-session checkpoint（compaction 仅在 session 结束后触发）

### 评估

**可行性: HIGH**。基础设施完备，纯增量开发。`session_events` 表天然支持 event-count 触发。不需要新建表（复用 `memory_compactions` 加 `auto_trigger` 字段即可）。

**风险: LOW**。不修改核心 loop，不引入新依赖。

### 实施计划 (2-3天)

1. `packages/agent/src/checkpoint-writer.ts` —
   `ensureCheckpointStore()` (复用 memory_compactions)、
   `writeCheckpoint(sessionId, trigger)` (调 compactSession)、
   `getLatestCheckpoint(sessionId)`
2. 扩展 `memory_compactions` DDL — 加 `auto_trigger TEXT` 列
3. Session event hook — 在 `chat-service.ts` 的 `onSessionEvent` 中检查触发条件:
   - 每 N 个 events (默认 20)
   - 每个 tool call state 变为 `succeeded`/`failed`
   - 每 M 分钟 fallback (默认 10)
4. 不建 ADR — 补充 ADR 0020 即可

---

## TODO-P0-2: 独立 Judge Model 停止条件评估

**结论: ✅ 启动（缩小范围）**

### 现状

| 已有能力 | 位置 |
|---------|------|
| B0 post-execution goal self-check | `self-check.ts` + `scheduler/goal-self-check-runner.ts` |
| Self-check 评估 goal + stop conditions | `runPostExecutionSelfCheck()` |
| 失败时 block task (不静默通过) | `transitionExecutionState(→blocked)` |
| Run contract 中声明 goal/stopConditions | `run-contract.ts` |
| `shouldRunSelfCheck()` 门控 | `self-check.ts:228` |

### 缺口

1. **Judge 使用 SAME provider/model** — `goal-self-check-runner.ts:25`: `createProvider(input.provider, { model: input.model })`。不是独立 judge。
2. **只在 post-execution 运行** — 不参与 loop 层 stop decision。Agent 可以无限循环直到 token 耗尽。
3. 无 `judge_provider` / `judge_model` 配置
4. 无 mid-loop stop evaluation

### 评估

**可行性: MEDIUM**。self-check 基础设施已存在。MiMo 的核心洞察是: agent 用 model A 执行，用 model B 判断是否停止 — 避免同 model 自我肯定偏差。

**关键架构决策**: los 的 stop 逻辑在 `loop.ts` 的 ReAct 循环中（stop conditions + max loops + token budget）。加入 judge model 需要在不破坏现有 stop logic 的前提下增加一个评估层。

### 实施计划 (缩小范围, 2-3天)

**本轮只做**:
1. `packages/agent/src/goal-evaluator.ts` —
   `evaluateGoal(sessionId, goalCondition)` 用独立 provider/model
2. 扩展 `config.ts` Zod schema — 加 `judge` section:
   ```ts
   judge: z.object({
     provider: z.string().optional(),
     model: z.string().optional(),
   }).optional()
   ```
3. 修改 `goal-self-check-runner.ts` — 优先用 `judge.provider`/`judge.model`

**本轮不做** (留给 P1-4 context reconstruction):
- Mid-loop stop evaluation (需要与 loop.ts 深度集成)
- Agent 主动提出停止 → judge 评估 → 允许/拒绝的双向交互

---

## TODO-P0-3: 自动触发 Compaction (Dream 对标)

**结论: ⚠️ 推迟（核心已满足, 降为 P1）**

### 现状

| 已有能力 | 位置 |
|---------|------|
| Session 结束自动 compact | `chat-service.ts` → `session.completed`/`session.error` hook |
| 定期扫描未 compacted session | `POST /memory/auto-compact` route |
| Governance sweeper 检测未 compacted | `memory_integrity` audit (daily) |
| `compactSession` dedup + advisory lock | compaction.ts |
| Candidate lifecycle (draft→review→approved→active) | compaction.ts |
| Operator gate — 永不自推为 rule | ADR 0020 |

### 缺口 (MiMo Dream 对标)

1. `/dream` CLI 命令 — 扫描所有 session 批量提取 pattern
2. **过时记忆检测** — evidence_count 时间衰减
3. **Stale candidate 自动标记** — `approved` 但 7 天未 promote → 标记
4. **Pattern 聚合** — 跨 session 的同类 pattern 合并去重

### 评估

**核心功能已覆盖**: Session 结束自动 compact + 定期 sweep + operator gate 三项是 MiMo Dream 的核心。`auto-compact` route + governance sweeper `memory_integrity` 提供了和 MiMo Dream 等效的自动化覆盖。

**差距分析**:
- Stale detection → `memory_integrity` audit 的 `candidate-status-consistency` check 已检测 approved>7天的候选。降级到 Todo 提醒即可。
- Pattern 聚合 → 需要跨 compaction 的去重逻辑，工作量中等。当前每个 session 独立 compact 已足够。
- `/dream` CLI → 低优先级，`POST /memory/auto-compact` 提供等效功能。

### 降级理由

1. Auto-compact **已实现**（今日提交的 chat-service hook + memory-routes）
2. Stale detection **部分覆盖**（integrity audit 检测但有 false positive）
3. 剩余 gap（pattern 聚合、evidence decay）是优化而非阻塞
4. P0-1 (checkpoint) 和 P0-2 (judge model) 有更高的差异化价值

**建议**: 将 TODO-P0-3 降为 P1，聚焦于:
- P1-a: 完善 stale candidate 自动标记（基于 evidence decay）
- P1-b: 聚合跨 session 的同类 pattern（dedup + merge）

---

## 总结

| TODO | 结论 | 范围 | 预估 |
|------|:---:|------|------|
| P0-1 Checkpoint-Writer | ✅ 启动 | checkpoint-writer.ts + auto-trigger hook | 2-3天 |
| P0-2 Judge Model | ✅ 启动 | config judge section + independent provider | 2-3天 |
| P0-3 Auto Compaction | ⚠️ 推迟→P1 | 核心已实现，降级到 stale detection + pattern 聚合 | P1 |

**累计 P0 工作量**: 4-6 天
**阻塞前提**: 无 — 两项都可独立启动
