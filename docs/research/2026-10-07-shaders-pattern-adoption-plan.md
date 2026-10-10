# los 采纳计划：来自 shaders 模式审计的落点与验收

- 日期：2026-10-07
- 上游调研（跨 7 项目，含全部 `file:line` 证据与证据分级）：[2026-10-07-shaders-patterns-cross-project-optimization.md](./2026-10-07-shaders-patterns-cross-project-optimization.md)
- 通用方法（技能）：`transferable-pattern-audit`；通用纪律：`~/.claude/rules/pattern-transfer-discipline.md`
- 本文只保留**落在本仓**的项。其它项目的项在其各自仓库/`dsfolder` 的 adoption 文档里。

## 0. 本仓的两条线，不要混

调研确认 los 有真实测量管道（cgroup 采样器、CI metrics JSONL、FTS 的 EXPLAIN 门禁、provider 遥测审计），但**已文档化的瓶颈是 CI/构建墙钟，不是运行时**。所以下面的项分两条线，验收口径不同：

- **CI/构建线**：验收 = 墙钟时间与缓存命中率（有量化根因，见 §1）。
- **运行时线**：验收 = 结构性指标（缓存键覆盖输入数、pass 数、往返次数），**不是**端到端性能数字。

los 真正缺的不是治理，而是把治理**机械化**的模式。下面 P0 两项都是「把已有的人工评审变成机器门禁」。

---

## 1. CI/构建线

### P0-1 turbo 任务声明收紧 + 生成物无 diff 门禁

**CONFIRMED 问题**：`docs/governance/2026-08-16-ci-observability-and-bottleneck-review.md` 记录 gate-test 4.2–5.4 min（Forgejo）vs 164–186 s（GitHub），77% 落在 Test root workspace；gate-fast 2.7–4.2 min 里**序列化 turbo typecheck ~100 s**；根因第一条是「Forgejo 上没有 turbo cache」。

**落点**：`turbo.json`、`tools/ci-gate.sh`、`.forgejo/workflows/`。

**做法**（照搬 shaders 的 `turbo.json` + `test.yml:34-62` 形态）：
1. 每个 turbo 任务显式声明 `outputs` / `env` / `inputs`。**关键是 `env: []`** —— 声明「本任务输出不依赖任何环境变量」之后缓存命中的可靠性才成立；未声明等于一律 miss。
2. Forgejo CI 上启用 turbo 缓存并挂持久目录（根因直指此处），另加 `restore-keys` 式前缀回退。
3. gate-test 里的序列化 packages-test 段拆成可并行分片，或至少独立成阶段与 typecheck 并行。
4. 新增门禁：build 之后 `git diff --quiet` 必须成立，否则失败并打印变更文件列表。这条直接服务 `AGENTS.md` 的 "Contract first"（`contracts/` → 生成类型 → 实现），让漏提交在 CI 死掉而不是在别人机器上炸。

**验收**：gate-test / gate-fast 墙钟下降；turbo 缓存命中率可观测；注入一次「改了 contracts 不重新生成」的负向用例，门禁必须红。

**风险**：`env` 声明错会造成**错误的缓存命中**（比 miss 更糟）。所以第 4 条之前先用 P0-2 的差分测试形态验证键的完备性。

### P1-2 命名规则：生成物提交门禁的前置决定

`git diff --quiet` 门禁要求「哪些产物提交进版本库、哪些 gitignore」被明确写下。shaders 的划分是：注册表与 `package.json` 提交，框架侧生成组件 gitignore。los 需要先做出这个划分，否则门禁无法落地。

**落点**：`AGENTS.md` 或 `docs/governance/` 下一个新条目。

---

## 2. 运行时线

### P0-3 把 AP11 的「prompt cache 影响评估」机械化

**CONFIRMED 问题**：`AGENTS.md` AP11 要求 system prompt / 工具定义 / 上下文窗口策略变更必须通过 `docs/governance/code-first-determinism.md` 的「prompt cache 影响评估」+ 聚焦 harness 回归测试 + 版本号提升。其中**「影响评估」目前是人工评审**。

**做法**（照搬 shaders `compileTimeHashCoverage.test.ts` 的三段式）：
1. 产出「进入 prompt 前缀的全部输入」枚举清单（system prompt 片段、工具 schema、模型参数、上下文切点、压缩器版本 …）—— 这份清单本身就是治理资产。
2. 正向：改清单里任一项 ⇒ 前缀哈希**必须变**。
3. 反向：改不该影响前缀的项 ⇒ 哈希**必须不变**且不得触发重编（这一向防止「改个 UI 文案导致 prompt 缓存全线失效」的成本事故）。
4. 自覆盖：断言实际遍历到的项数 == 从真源推导出的项数。
5. 把 AP11 的措辞从「做影响评估」改成「跑这个测试」。

**落点**：新增测试（建议 `packages/agent/src/` 下或 `tools/`），并更新 `docs/governance/code-first-determinism.md` 与 `AGENTS.md` AP11 的措辞。

**验收**：上述四条断言全绿；负向注入（故意从清单里删一项）必须红。

**风险**：清单不完备会让门禁给出虚假安全感。自覆盖断言（第 4 条）是必需品，不是可选项。

### P1-4 缓存键覆盖 + 反向不变式

**落点**：`packages/memory/src/core/retrieval.ts`、`packages/agent/src/providers/{registry,model-routing,provider-health}.ts`、`packages/agent/src/loop/token-utils.ts`。

**做法**：
- memory 检索缓存键 = 「查询结构指纹 + 索引版本 + 过滤条件」的**声明式枚举**（shaders `pipelineCache.ts:24-34` 的 `structuralHash` 形态），并按模式 4 加活跃钉住（活跃条目永不驱逐）与 `dispose` 钩子。
- provider/model 路由决策缓存键 = `(provider, model, capability, health tier)` 的结构哈希 + LRU。

**本仓已有的最好模板**：`packages/memory/src/fts-performance.test.ts` —— 用 EXPLAIN 断言**计划形状与索引名**并带 100/200/500 ms 预算。这是同类门禁里质量最高的一条，建议把它当内部推广模板：**「预算 + 结构化断言」而不是「端到端时间」。**

### P1-5 失效作用域分级的不变式

**相关面（CONFIRMED）**：`packages/infra/src/db.ts`（pg Pool）+ `migrate.ts`（启动时 `migrateDir()`）；`session-recovery.ts` / `stream-checkpoints.ts` / `kernel-event-projection.ts` 之间有派生关系。

**做法**：把模式 3 的不变式写成本仓的显式规则并配测试 —— **任何从资源身份派生的缓存句柄（连接、预处理语句、prepare 计划），必须被重建该资源的同一事件失效。** shaders 为此付了「整个命令缓冲被丢弃 → 画面全黑」的代价（`passManager.ts:399-435`）。los 侧的对应风险是 schema 迁移后陈旧的 prepared statement / 连接。

### P1-6 上下文压缩链：可交换律 + 保守谓词 + 预算 + 保底回退

**INFERRED，需先证明**：`packages/agent/src/loop/compression.ts` + `loop/message-builder.ts` + `packages/memory/src/core/compaction.ts`（624 行）+ `semantic-eviction.ts` 构成一串对历史消息的变换（裁剪 → 摘要 → 截断 → 重排）。

**做法**：按模式 5 处理 ——（a）写出哪些变换彼此**可交换**（纯删除类操作是首选候选）；（b）纯静态谓词判定可融合子序列（谓词必须无副作用）；（c）融合预算上限；（d）保留未融合回退路径；（e）用**结构性断言**测试（融合后 pass 数下降；否定清单形状必须回退），不需要真 LLM。

**前置门槛**：**写不出那条交换律就不要做融合。** 本条的最大价值不在融合本身，而在「用结构性断言替代端到端 LLM 测试」——这是可免 LLM 的测试形态。

### P2-7 文档面与治理形态

- **docs manifest + 覆盖率棘轮**（技能 `transferable-pattern-audit` 模式 7/工具箱）：先只做一个域（治理文档索引或 CLI/API 参考），产出 `docs-manifest.json` + `llms.txt` + `UNDOCUMENTED_BASELINE` 棘轮。不要一次做全量。
- **`docs/governance/conventions.md`**：本仓治理资产是**按时间分散**的（46 篇 ADR + ~50 篇 governance 文档），shaders 是**按规则编号聚合**的（一份 477 行文件覆盖规则、已解决约定、实现中学到的、显式异类清单，且显式区分维护者文档与使用者文档）。建议新增一份编号规则册，把检索成本从「读 46 篇 ADR」降到「查规则表 + 按需跳转」。
  - **注意**：写这份文件需要真读 ADR 内容，不能由本文推断。本次调研**未**读 ADR 正文，所以这份文件是独立任务，不是本计划的产出。

### P2-8 变更等价强度分级（Gate A/B/C）

用于「行为不该变」的大改动：session event 格式迁移（ADR 0002/0015）、事件投影重构、工具定义重构。
- **A 字节/记录等价** · **B 论证等价** · **C 行为变更需签核 + changelog**。
- 陷阱：**浮点/数值重排不是免费的** —— 在 token 计数与成本核算里同样成立。
- 配套 **bail-out 规则**与**显式异类清单**。

---

## 3. 本仓**不采纳**的项（拒绝清单）

| 项 | 理由 |
|---|---|
| swap-when-ready（模式 2） | los 的运行时无「用户可见逐帧连续性」需求；对应场景（SSE 重连、投影缓存）已有 `stream-backoff`/`stream-checkpoints`，引入双缓冲提升门是净复杂度 |
| 专有 ABI/布局类（模式 6 的 `_pad*` workaround 等） | 与图形/TypeGPU 强绑定，`不可迁移`；只取「补大小不补对齐 + 采用前先验证与序列化路径兼容」的方法 |
| shaders 的测试体量（266 文件 / 214 快照 / 2.2 MB） | 抄**结构断言的形状**，不抄体量 |
| shaders 的 `maxSize = 4` 等场景常数 | 编辑场景经验值，必须按 los 的真实工作集重新推导 |

---

## 4. 与 AP 不变式的关系

- **AP11** 被 P0-3 从人工评审升级为机器门禁，措辞需要同步更新（属于 AP 变更，走既有 AP 修订流程）。
- **AP5**（每个任务阶段重新加载 specs）不受影响。
- 本文只登记计划，**不登记执行状态**。按 `AGENTS.md`「Active work and replacement state belong in structured todos」，P0/P1 项落地前应转成结构化 todo，而不是在本文里追踪进度。
