# Research → Todo 分析 & 写入方案

> 日期：2026-06-20
> 输入：`competitive-snapshot-2026-06-20.md`
> 输出：新增 8 个 todo seed entries + 1 个 metadata 更新

---

## 一、Gap 分析

### 已有 todo 覆盖检查

| 调研发现 | 已有 todo | 覆盖状态 | 判断 |
|----------|-----------|:---:|------|
| Context fill 监控 (60/75/85%) | 无 | ❌ | **新增 P0** |
| Semantic eviction Layer 1 (masking) | `todo-los-memory-compression-eval` (P2, backlog) | ❌ 太高层，不具体 | **新增 P0** |
| Pre-action gate (已知失败模式拦截) | 无 | ❌ | **新增 P0** |
| Architect/Editor 双模型分离 | P0-2 Judge Model (仅 MiMo 分析，未入 seed) | ❌ 不在 seed 中 | **新增 P1** |
| PreCompact/PostCompact hooks | 无 | ❌ | **新增 P1** |
| Deferred Tool Loading | 无 | ❌ | **新增 P1** |
| Dual-path compaction (服务端 + 本地) | 无 | ❌ | **新增 P2** |
| 框架复查机制 (reference watch) | `todo-los-framework-reference-watch` | ⚠️ 状态 backlog，metadata 过时 | **更新 metadata** |

### dedupeKey 唯一性检查

所有新增 todo 的 dedupeKey 均不与现有 56 个 `LOS_PLANNING_TODO_SEED` entries 冲突（用新前缀 `los:todo:context-*`）。

---

## 二、写入方案

### 2.1 目标文件

`packages/agent/src/todo-seeds-agent-workflow.ts` — 新增 8 个 todo

### 2.2 新增 stage: `context-engineering`

所有新 todo 挂在 `todo-los-context-engineering-phase` (phase) 下，该 phase 挂在 `todo-los-agent-workflow-harness` 下。

### 2.3 Todo 条目设计

```
todo-los-context-engineering-phase (phase, P0)
  └─ todo-los-context-fill-monitoring (task, P0)
  └─ todo-los-semantic-eviction-layer1 (task, P0)
  └─ todo-los-pre-action-gate (task, P0)
  └─ todo-los-architect-editor-separation (task, P1)
  └─ todo-los-compaction-hooks (task, P1)
  └─ todo-los-deferred-tool-loading (task, P1)
  └─ todo-los-dual-path-compaction (plan, P2)
```

每个 todo 包含完整字段：kind, status, priority, source, stageId, parentId, dependsOnIds, dedupeKey, metadata (problem + solution + evidence/references)。

### 2.4 同步更新

- `todo-los-framework-reference-watch`: 更新 metadata 引用 2026-06-20 snapshot 发现
- `todo-mimo-p0-2-judge-model`: 在 metadata 中增加 architect/editor 扩展方向注释

---

## 三、依赖链设计

```
todo-los-context-engineering-phase
  → dependsOn: [todo-los-agent-workflow-harness]

todo-los-context-fill-monitoring
  → dependsOn: [todo-los-context-engineering-phase]
  → 无代码依赖，纯监控插桩

todo-los-semantic-eviction-layer1
  → dependsOn: [todo-los-context-fill-monitoring]
  → 需要先有填充率数据才能测量 eviction 效果

todo-los-pre-action-gate
  → dependsOn: [todo-los-context-engineering-phase]
  → 独立于 context 管理，可在 compaction 之前实现

todo-los-architect-editor-separation
  → dependsOn: [todo-los-agent-mode-contracts, todo-los-provider-capability-profile]
  → 需要 mode contract 和 capability profile 基础设施

todo-los-compaction-hooks
  → dependsOn: [todo-los-semantic-eviction-layer1]
  → eviction 是 compaction pipeline 的一部分

todo-los-deferred-tool-loading
  → dependsOn: [todo-los-context-engineering-phase]
  → 独立工具加载优化

todo-los-dual-path-compaction
  → dependsOn: [todo-los-semantic-eviction-layer1, todo-los-compaction-hooks]
  → 需要完整的本地 compaction pipeline 稳定后
```

---

## 四、不放入 seed 的项

以下调研发现暂不写入 todo，标记为 observe-only：

| 发现 | 理由 |
|------|------|
| Worktree Isolation (Claude Code) | 依赖 git worktree 支持，los 当前无此基础设施 |
| Adaptive edit formats (Aider) | 依赖 provider 能力 profile 稳定，P2 远期 |
| Skills `paths` + `context:fork` (Claude Code) | 当前 SKILL.md 规模不足以受益 |
| Per-tool-call sandbox (Codex CLI) | 当前 executor-level 隔离已足够 |
| Conditional edge + checkpoint (LangGraph) | agent-task-graph 当前足够，无此升级需求 |
| projectmem Memory-as-Governance | pre-action gate todo 部分覆盖了此方向 |
