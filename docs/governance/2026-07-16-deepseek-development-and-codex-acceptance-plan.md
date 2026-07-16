# DeepSeek 开发交接与 Codex 验收计划（2026-07-16）

## 1. 目的

本文给 DeepSeek 提供分批开发合同，并给 Codex 提供逐批验收标准。它不替代
`todos`、`task_runs`、`session_events`、verification records、CI 或运行时服务状态。

执行规则：DeepSeek 每次只实现一个批次，提交 diff 和检查证据后停止；Codex 验收
通过后，操作者再决定是否进入下一批。不要把本文全部任务一次性实现。

## 2. TL;DR

1. 当前 gateway 和 executor 健康，但运行进程仍是已发布版本，工作区另有 32 个文件、
   1939 行新增的未提交“执行可观测性 + 上下文工程”改动；该改动已在本次分析中通过
   `pnpm gate` 9/9 阶段，但尚未证明已提交、合并或部署。
2. 当前产品队列把 Execution Lab、恢复、实验和性能工作排在前面，但计划账本存在更早的
   真实性问题：`CONTEXT_ENGINEERING_TODO_SEED` 被导入却没有合并进
   `LOS_PLANNING_TODO_SEED`；运行中 PostgreSQL 的 local/los 项目有 29 个活动 P0/P1，
   其中包含重复治理告警和未纳入产品队列的 schema drift 待办。
3. 新优先级先修计划账本和治理待办投影，再恢复本地 schema drift 验证能力和双 gateway
   恢复证据；compaction、execution experiment、pairwise eval 和性能功能随后推进。

## 3. 证据快照

置信标记：`[E]` 为本次命令或源码直接验证；`[I]` 为基于已有持久证据的推断；
`[U]` 为尚未验证。

| 观察 | 证据 | 判断 |
| --- | --- | --- |
| gateway 与 executor 均为 running、health ok | `pnpm run status` | `[E]` 当前本机服务可用，不等于工作区改动已部署 |
| 工作区基于 `feat/execution-observability-projection`，有 32 个修改/新增文件 | `jj status`、`jj diff --stat` | `[E]` DeepSeek 不得在同一脏工作区继续叠加新任务 |
| 当前脏改动通过完整 gate | `pnpm gate`：9 phases、0 failures、273s | `[E]` 可作为待验收基线，不等于已合并 |
| 当前源码 seed 共 123 项；源码过滤后有 1 个活动 P0 phase 和 13 个活动 P1 task | 直接导入 `LOS_PLANNING_TODO_SEED` 后过滤 | `[E]` phase 不是可直接 dispatch 的开发任务 |
| `CONTEXT_ENGINEERING_TODO_SEED` 只 import、未 spread | `packages/agent/src/todo-seeds.ts` | `[E]` 当前源码会漏掉整组 context-engineering seeds |
| PostgreSQL local/los 当前有 164 个非归档 todo，29 个活动 P0/P1 | authenticated `GET /todos`、`los governance todo-reconcile` | `[E]` DB 队列大于产品队列，需区分种子任务、运行时任务和治理投影 |
| reconcile 显示 41 个 DB-only todo | `los governance todo-reconcile --json` | `[E]` 不得把 DB-only 项直接删除；先判断独立运行时所有权 |
| reflection、status drift、branch cleanup 存在重复 P1 告警 | PostgreSQL todo rows；`governance-sweep-todos.ts` | `[E]` 通用 findings 投影缺稳定 dedupe/update/archive 规则 |
| `mcp_servers`、`tool_call_states`、`todo_dependencies` 有 P1 migration-drift todos | PostgreSQL todo metadata | `[I]` 持久审计记录了 drift，但本次无法重新计算完整 diff |
| 本地 migration drift gate要求 `CREATEDB` | `pnpm check:migration-drift` 返回 PostgreSQL `42501` | `[E]` 当前普通开发角色不能独立验收 drift |
| 39 个源码文件仍超过 400 行警戒线 | `pnpm gate` structure phase | `[E]` 属于历史 baseline；新任务不得扩大，触及近 600 行文件时先拆分 |

## 4. 新优先级

### P0：先恢复开发与计划真实性

| 顺序 | 批次 | 目标 | 为什么先做 |
| --- | --- | --- | --- |
| P0-0 | 当前基线验收 | 先由 Codex/操作者处理现有 execution-observability/context-engineering 脏改动 | 避免 DeepSeek 覆盖或混入另一意图 |
| P0-1 | Seed 汇总完整性 | 让所有声明为 canonical 的 seed group 都进入 `LOS_PLANNING_TODO_SEED` | 否则 reconcile、队列统计和状态更新基于不完整输入 |
| P0-2 | 治理 todo 去重与消退 | 同一项目、job type、audit type 只保留一个活动 finding todo；发现消失后归档 | 当前重复告警挤占 P1，计数变化会生成新条目 |
| P0-3 | 队列重新校准 | 用修复后的 source + DB dry-run 生成新的可执行任务表 | 阶段容器、产品任务、运行时发现和治理告警必须分栏 |

### P1：恢复与数据验证优先于新实验

| 顺序 | 批次 | 目标 | 依赖/说明 |
| --- | --- | --- | --- |
| P1-1 | Migration drift 本地可验 | 普通开发角色可用预创建 scratch DB 或等价隔离方式运行 fresh/ensure 对比 | 先修验证入口，再判断三个 drift todo 的真实剩余量 |
| P1-2 | Migration drift 清理 | 对 `tool_call_states`、`todo_dependencies`、`mcp_servers` 逐表修复并缩小 baseline | 一表一批；禁止未验证地重写 live DB |
| P1-3 | 双 gateway 恢复 smoke | 完成 `todo-los-multi-gateway-entry`，再完成 stream replay smoke | 先证明恢复，再扩展实验生命周期 |
| P1-4 | Compaction 生命周期 | 实现 PreCompact/PostCompact、checkpoint、重建和效果指标 | 在 context fill、semantic eviction、pre-action gate 当前改动验收后开始 |
| P1-5 | Execution experiment contract | contract → generated types → migration → store → API → harness | 依赖 observability projection 和现有 AP2/AP3 gate |
| P1-6 | Pairwise rubric eval | immutable rubric revision、baseline/candidate pair、分离 judge/human/deterministic evidence | 依赖 P1-5 |

### P2：有基准后再做的优化

1. OTel 文档、完整 metrics、coverage baseline、Turbo cache 文档可并行准备，但不得抢占
   P0/P1 的真实性与恢复工作。
2. CBM A/B、input preprocessor benchmark、stale detection 在 execution projection 和
   experiment contract 可用后执行。
3. Architect/Editor 双模型、Deferred Tool Loading、双路径 compaction 先保留为候选。
   没有当前 token、延迟、质量基准前，不改变默认执行路径。
4. 39 个历史大文件按“触及即拆分”和 baseline 单调下降处理，不建立一个跨包大重构批次。
5. migration 成为唯一 schema 真相属于独立 ADR/架构任务，不与三张表的 drift 修复混写。

## 5. DeepSeek 第一阶段开发合同

DeepSeek 首次只执行 P0-1。P0-2 必须等待 Codex 验收 P0-1 后再开始。

### 5.1 P0-1：Seed 汇总完整性

**目标**

修复 canonical seed group 被 import 但未进入最终 planning seed 的问题，并让测试能阻止
同类回归。

**允许修改**

- `packages/agent/src/todo-seeds.ts`
- `packages/agent/src/todo-seeds.test.ts`
- 如确需抽取测试 helper，可在 `packages/agent/src/` 增加一个小文件；不得新增 infra 文件

**实现要点**

1. 把 `CONTEXT_ENGINEERING_TODO_SEED` 明确合并进 `LOS_PLANNING_TODO_SEED`。
2. 测试必须证明 context-engineering 的关键 ids 存在于最终 seed，而不是只测试子数组本身。
3. 最终 seed 的 `id` 和非空 `dedupeKey` 必须唯一。
4. 测试应覆盖活动 P0/P1 的分类：phase 容器不能被当作 dispatchable task。
5. 不在本批修改 todo status，不调用 live `/todos/seed`，不改 PostgreSQL。

**非目标**

- 不更新 P0/P1 排序文档。
- 不清理 DB-only todos。
- 不修改 governance sweeper。
- 不处理 migration drift。

**最小检查**

```bash
pnpm --filter @los/agent exec node --import tsx --test src/todo-seeds.test.ts
pnpm --filter @los/agent check
pnpm check
```

**验收条件**

1. 直接导入 `LOS_PLANNING_TODO_SEED` 可找到所有 context-engineering ids。
2. 重复 id 或 dedupeKey 会使测试失败。
3. focused test、agent check、root check 全部通过。
4. `jj diff` 只包含本批允许文件，没有覆盖 P0-0 的脏改动。

### 5.2 P0-2：治理 finding todo 去重与消退

仅在 P0-1 验收通过后执行，单独 change/bookmark。

**目标**

让周期性 finding 以稳定身份更新，而不是按每次 count 或 job id 追加 todo；finding 消失后
归档，重新出现时恢复同一 todo。

**允许修改**

- `packages/agent/src/governance-sweep-todos.ts`
- 对应 focused test；优先新增/扩展 `governance-sweep-todos.test.ts`
- 必要时抽取 package-local helper；不得修改公共 API 合同

**实现要点**

1. 稳定键至少包含 tenant/project、`jobType`、`auditType`；不能包含本次 finding count。
2. 采用现有 migration/file-size sweeper 的 update-or-create、unarchive、resolve-archive 模式。
3. `missingReflection`、`statusDrift`、`seedOnly`、branch cleanup 等重复来源应各自只有一个
   活动 todo。`ga_loop` 已有按 job type dedupe，需补历史重复项的安全归档策略。
4. count、最近 job id 和最新描述更新到现有 todo；不要丢失首次发现时间。
5. audit 查询失败时不得把全部 finding todo 当作 resolved 归档。
6. 不 hard-delete；历史清理只能生成 dry-run 报告，实际 archive 需要操作者批准。

**最小检查**

```bash
pnpm --filter @los/agent exec node --import tsx --test src/governance-sweep-todos.test.ts
pnpm --filter @los/agent check
pnpm check
```

**验收反例**

1. 同一 finding 连续运行三次，只存在一个活动 todo，描述更新为最新计数。
2. finding 消失后归档；再次出现时恢复原 todo，不创建新 id。
3. 两个 tenant/project 的同类 finding 不能互相覆盖。
4. audit 抛错时原活动 todo 保持不变。

### 5.3 P0-3：队列重新校准

本批以文档和 dry-run 为主，不直接修改 live todo 状态。

1. 运行 source seed 统计与 `los governance todo-reconcile --json`。
2. 把结果分成 phase、seed task、DB-only runtime task、governance finding 四类。
3. 对重复历史 governance todo 输出 archive 候选和保留理由。
4. 只有具备实现/测试/运行证据的 seed status 才能更新。
5. Codex 验收清单确认后，再由操作者批准 `/todos/seed` 或 archive 动作。

## 6. P1 开发要点

### 6.1 Migration drift

1. 先给 `tools/check-migration-drift.ts` 增加普通开发角色可执行的隔离模式，同时保留 CI 的
   双 fresh DB 语义；不能把两边指到同一 DB，也不能用当前 live DB 做 destructive recreate。
2. 优先方案是显式接收两个预创建 scratch database URL，并校验 database name 不同、
   不是配置中的 live database。若选择 schema 隔离，必须先写 ADR 说明与双 DB 语义等价。
3. 工具可运行后，重新生成真实 diff，再按一张表一个 change 修复 migration/ensure 差异。
4. 每张表都要验证 fresh migration、ensure bootstrap、legacy upgrade 和 baseline 单调缩小。
5. `tool_call_states` 涉及 AP1/AP3/recovery，`todo_dependencies` 涉及 dispatch gate，
   `mcp_servers` 涉及工具配置；不得只改 SQL 字符串扫描测试。

### 6.2 双 gateway 恢复

1. 启动两个 gateway 共享 PostgreSQL，使用不同 service id/port。
2. 验证 ready routing、drain 后不接新请求、另一个实例继续 ready。
3. 固定 run id、session id、cursor、`Last-Event-ID` 和 idempotency key。
4. 中断原 gateway 后，从第二个 gateway 读取 persisted session events 与 stream checkpoint。
5. operation smoke 必须记录进程、API、DB 三类证据，不能用单进程 route test 代替。

### 6.3 Compaction 生命周期

1. 先读取 ADR 0020 和 memory spec；不得自动 promote procedural candidate。
2. PreCompact 写 checkpoint、context snapshot 和事件；PostCompact 重建引用、工具定义和
   指标。所有状态写入走现有 store/transition 边界。
3. 用 golden interrupted session 验证可重建性；保留 source event 与 observation references。
4. `packages/memory/src/core/compaction.ts` 已接近 600 行，新增行为前必须抽取内聚子模块。

### 6.4 Execution experiment 与 pairwise eval

1. 公共字段先改 `contracts/`，再生成类型、migration、store、route、UI。
2. experiment provenance 不可变：baseline/candidate、source run、prompt/spec/memory/tool
   fingerprints、provider/model profile revision 必须可追溯。
3. human、judge model、deterministic check 分开存储，禁止合并成一个未标来源的分数。
4. `plan_approved` 前仍由 AP2 保证计划持久化；成功前仍由 AP3 验证记录 gate。
5. 每个批次需要 focused harness；跨 package 交付运行 `pnpm gate`。

## 7. DeepSeek 每批交付格式

DeepSeek 完成一个批次后必须停止并提供：

```text
Batch:
Goal:
Changed files:
Behavior changed:
Behavior intentionally unchanged:
Checks run:
- command:
- result:
Checks not run:
- command and reason:
DB/API/runtime mutations:
Residual risks:
jj status:
jj diff --stat:
```

禁止事项：

1. 不提交、push、开 PR、merge 或清理 bookmark，除非操作者另行授权。
2. 不在当前 32 文件脏改动上继续开发；使用验收后的 clean base 或独立 jj workspace。
3. 不执行 live todo overwrite、批量 status 更新、archive、数据库 migration 或服务切流。
4. 不修改与当前批次无关的文档、研究记录、provider 配置或全局 Codex 规则。
5. 不以“测试代码存在”代替生产入口接线；运行 `pnpm check:wiring` 或 `pnpm check`。

## 8. Codex 验收协议

Codex 对每批按以下顺序验收：

1. **范围**：`jj status`、`jj diff --stat`、逐文件 diff；确认 one change one intent。
2. **规则**：重新加载受影响 `.los/spec/`，检查 AP1/AP2/AP3/AP5/AP7/AP10。
3. **源码**：从真实 entrypoint 检查接线；API 变更先核对 contract/generated types。
4. **反例**：先运行批次定义的 focused negative tests，再运行 package check/test。
5. **广域门槛**：跨包、DB、gateway、scheduler 或交付批次运行 `pnpm gate`。
6. **运行证据**：只有涉及运行时行为时才做 authenticated API/DB/operation smoke；配置、
   health、持久状态分别报告。
7. **结论**：输出 accepted / changes required / blocked，并列出文件、命令、未跑检查、
   残余风险、change/bookmark 状态。

任何批次只要出现以下情况即拒收：

1. 直接写 execution status，绕过 `transitionExecutionState()`。
2. 未持久化 plan 就进入 `plan_approved`，或未通过 verification 就标记 succeeded。
3. 新增 exported function 只在测试中被调用。
4. 新增 >400 行文件，或把现有文件推过 600 行阻断线。
5. 用 live DB 执行 destructive scratch/migration 检查。
6. 把 DB todo status、UI 状态或 agent 总结单独当作完成证据。

## 9. 本次未验证项

1. migration drift 的当前完整 diff未重新生成：本机 PostgreSQL 角色缺少 `CREATEDB`。
2. 当前脏改动虽通过 gate，但未检查远端 PR、CI、merge 或部署状态。
3. 未执行 live DB seed、archive 或 status 更新。
4. 未执行双 gateway process-kill/failover smoke。
5. `loadSpecsForFiles` 本轮工具未暴露；分析按规则降级为直接读取相关 `.los/spec/` 文件。

