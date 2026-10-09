# Shaders 仓库可迁移优化模式调研 —— 对 dsh / los / cantool / cankey / lot2extension / rustopt / ComfyUI 的落地分析

- 调研日期：2026-10-07
- 被调研仓库：`/Users/echerlos/syncfolder/project/shaders`（HEAD `935f71a7789f0e07811dfe6fd0d8f707e9848238`，2026-10-05）
- 对照项目：`deepseek-harness`(dsh)、`los-workspace/projects/los`、`cantool`、`cankey`、`lot2extension`、`dsfolder/rustopt`、`ComfyUI`
- 证据纪律：本文所有机制都给出 `文件:行` 证据；无法核实的项显式标注「未核实」或「NOT PRESENT」。项目现状数字来自 2026-10-07 的只读勘察。

---

## 0. 结论摘要（TL;DR）

**一句话结论**：`shaders` 表面上是一个 WebGPU 着色器特效库，但它的核心（`packages/core`，约 12.8 万行 TS）实际上是一个 **「声明式 DSL → 规范 IR → 后端代码」的编译器 + 一个带资源生命周期管理的运行时调度与缓存引擎**。它与图形语义强绑定的部分不到三分之一；**其余约 70% 是通用软件工程模式**，而且这套模式有完整的测试与门禁把它钉住，这一点比模式本身更值钱。

**最值得迁移的 10 个机制（按跨项目杠杆排序）**：

| # | 机制 | 核心价值 | 首选落地项目 |
|---|---|---|---|
| M1 | **缓存键覆盖率差分门禁**（`compileTimeHashCoverage.test.ts`） | 把「某个输入改了但缓存键没变 → 陈旧结果」这一类系统性 bug 变成不可发布的 | ComfyUI、los(AP11)、cankey、dsh |
| M2 | **显式结构性哈希 + LRU + 活跃态钉住 + dispose 钩子**（`pipelineCache.ts`） | 缓存键来自「声明式枚举的失效触发集」，而不是对象身份比较 | ComfyUI、lot2extension、cantool |
| M3 | **swap-when-ready（先证明再提升）**（`pipelineCache.ts:49-76`+`frame.ts:248-284`） | 重配置永不产生可见退化；等价于蓝绿/金丝雀，但用在配置与缓存层 | lot2extension(队列)、ComfyUI、los |
| M4 | **算子代数融合：保守静态谓词 + 预算上限 + 保底回退**（`composer.ts:1170-1427`） | 「能融合就融合、不能就物化」的完整判定骨架，可直接套到查询规划/上下文压缩 | los、ComfyUI |
| M5 | **dirty 集合 + 每 tick 一次批量提交**（`uniformStore.ts:642-912`） | 细粒度脏标记、粗粒度写；且必须知道序列化器的真实更新粒度 | rustopt(ledger)、cantool、los、lot2extension |
| M6 | **失效作用域分级：patch → 重建句柄 → 重建产物 → 重建全部**（`passManager.ts:41-43,328-343,399-435`） | 按「被破坏的不变式」选最小作用域，用廉价比较检测而非通知管道 | ComfyUI、rustopt、los |
| M7 | **单一真源 codegen + 生成物必须提交的 CI 门禁 + 标记区重写**（`generate-components.ts`、`.github/workflows/test.yml:54-62`） | 一核多目标不漂移；CI 证明「重新生成是 no-op」 | los(contracts)、dsh、lot2extension |
| M8 | **docs-as-code → 单一 manifest → llms.txt/MCP + 覆盖率棘轮**（`scripts/docsManifest.ts`、`UNDOCUMENTED_BASELINE`） | 文档面与 AI 面从类型与注释生成，漂移变成单调数值门禁 | dsh、los、shaders 自身 |
| M9 | **变更分级门禁 Gate A/B/C + 显式豁免清单**（`gpu/kit/PRIMITIVES.md:100-146`） | 字节等价 / 论证等价 / 行为变更 三档，各自要求不同证据 | rustopt、cankey、ComfyUI、los |
| M10 | **无基质测试编译器**（mock 只包住资源分配边界，断言 IR 结构而非像素）（`_patternHarness.ts`、`analyticPushdown.test.ts:157-179`） | 把 GPU/LLM/外部依赖昂贵的测试变成廉价的结构性断言 | los(压缩链)、dsh、ComfyUI |

**每个项目的最高杠杆单点**（详见第 4 节）：

- **ComfyUI**：缓存键覆盖率差分测试 + 消除 `to_hashable` 的 `Unhashable` 静默降级（`comfy_execution/caching.py:50-65`）。
- **dsh**：`buildRequest` 中 `deepFreeze` 占 132.9/211.3 ms 自时间 → 用「结构性 revision + WeakSet」替代重复冻结遍历。
- **los**：把 AP11「prompt cache 影响评估」从人工评审变成 M1 式的**机器化差分不变式**。
- **cantool**：`command_system/search.rs:26,135` 每次调用新建 `SkimMatcherV2`，而 `mixer.rs:15-31,40-44` 已有线程局部 + 结果缓存 —— 直接复用。
- **cankey**：`PreparedUser` 首次学习复制整个 user HashMap（p95 4.763 ms / 8 ms 预算）→ 稀疏 patch + 写时复制。
- **lot2extension**：声明了却没有消费者的 page-snapshot 队列（`TODO.md:118`）→ 借用 `composedNodeIds` 的「声明 vs 实际执行」不变式把它变成启动期 fail-closed。
- **rustopt**：variant 矩阵并行（已实测 2.24× 空间）+ ledger 从 `2+2N` 次 open 改成一次合并写。

---

## 1. 调研对象与方法

### 1.1 方法与判据

1. **事实基线**：读源码、测试、CI、设计文档，所有结论带 `文件:行`。
2. **模式抽取**：把一个机制表述为**领域无关**的形式（去掉 GPU/着色器词汇），再看它对应哪一类软件问题。
3. **可迁移性判据**（三项全过才算「建议迁移」）：
   - **语义无关**：模式的正确性论证不依赖图形语义；
   - **问题同构**：目标项目存在结构相同的问题（不是「听起来像」）；
   - **边际收益 > 成本**：有可指认的落点文件与可度量指标。
4. **反例纪律**：明确列出**不该抄**的部分（第 6 节），避免把 shaders 的场景特有常数当普适经验。

### 1.2 shaders 事实基线

| 项 | 值 | 证据 |
|---|---|---|
| 定位 | WebGPU 特效组件库；React/Vue/Svelte/Solid/JS 五套入口 | `README.md:1-40` |
| 工作区 | 8 个包：core / js / react / vue / svelte / solid / partner / shaders(CLI+发布) | `pnpm-workspace.yaml`、`packages/*/package.json` |
| core 规模 | 639 个 TS 文件 / 128,054 行 | `find src -name '*.ts'` |
| 效果数 | 199 个 shader 目录 | `packages/core/src/shaders/` |
| 测试 | 266 个测试文件；214 个快照文件 / 2.2 MB | `src/__tests__/gpu/` |
| 覆盖率门禁 | functions 70 / lines 70 / branches 60 | `vitest.config.ts:16-25` |
| 构建 | turbo（仅 build 任务）+ rolldown-vite；Node 22.20.x | `turbo.json`、`package.json:50-57` |
| 发布 | merge 即发布；OIDC trusted publisher；幂等 publish | `.github/workflows/release.yml`、`scripts/release.mjs` |
| 治理文档 | `gpu/kit/PRIMITIVES.md`(477 行, C1–C9 + D-1/D-2/D-6)、`CATALOG.md`(2348 行)、`docs/std/STYLE.md` | 见上 |

**架构分层**（这是理解一切迁移关系的前提）：

```
作者面   std DSL (defineShader / paint / effect / map / shape / gpu)
   │      packages/core/src/std/**
   ▼
降低层   lower.ts: StdDefinition ──► GpuShaderDefinition（引擎既有契约）
   │
   ▼
规划层   composer.ts: 节点树 ──► CompositionIR
   │      · 结构性哈希输入 collectStructuralHashInputs (1668-1737)
   │      · 点态融合 push-down (1170-1427)
   │      · RTT 物化边界决策 / 死代码消除
   ▼
执行层   passManager.ts  计算 dispatch → RTT passes(叶→根) → 最终 pass
         pipelineCache.ts  结构哈希 → LRU(4) + swap-when-ready
         uniformStore.ts   打包 uniform + dirty 合并 flush
         textures.ts       纹理/采样器生命周期 + 按身份失效
         compute.ts        ping-pong / guarded dispatch / 有序混合步骤
```

**关键观察**：`composer.ts` 是**规划器**，`passManager.ts` 是**执行器**，`pipelineCache.ts` 是**计划缓存**，`uniformStore.ts` 是**状态提交层**。这四者构成了一个教科书式的「编译 + 执行 + 缓存」三件套。**几乎所有可迁移模式都落在这四层里，而不在 `src/shaders/**` 的那 199 个特效里。**

### 1.3 对照项目事实基线

| 项目 | 栈 | 规模 | 性能治理现状 | 文档化瓶颈 |
|---|---|---|---|---|
| **dsh** | TS，Cordis 全插件；319 包 / 60 组 | 7,423 TS 文件 / ~1.19M 行；1,514 spec | **最强**：8 条按用户路径的 CI 性能门禁；`benchmarks/AGENTS.md` 禁止 env 覆盖；prompt cache 是契约（`request-cache.e2e.ts`） | `buildRequest` 的 `deepFreeze` 占 132.876/211.300 ms 自时间（未结） |
| **los** | TS 模块化单体；12 包 | 1,083 源文件 / ~158k 行（含测试 213k）；330 测试 | 中上：cgroup 采样器、CI metrics JSONL、FTS 的 EXPLAIN 门禁、provider 遥测审计 | **CI/构建墙钟时间**：gate-test 4.2–5.4 min，序列化 typecheck ~100 s，40 次运行 38% 失败 |
| **ComfyUI**（M1 实例） | Python 节点图扩散引擎；v0.24.0 | 673 py / ~227k 行 | **运行时机器最多、护栏最弱**：分层缓存 + CacheProvider + pin 预算 + 预取 + 量化核；但 timing 测试 `continue-on-error` | ~17 处 `memory_usage_factor` 是猜的；`patches_uuid` 触发全模型重载未解 |
| **cantool** | Tauri 2 + Rust + React | 719 `.rs` / 232,609 行；310 `.ts` / 48,585 | 中：thread-local matcher + 结果缓存；hotpath 0.28 探针；size-gate 31 MiB | 单 crate `cantool_lib`（338 文件）改一行全量重编；rustopt 口径差 1.44 MB 未结 |
| **cankey** | Rust IMK 输入法；5 crate + 3 app | 62 `.rs` / 33,212 行 | 高：热路径 p95 < 8 ms 预算；`check-hotpath-no-io.sh` fail-closed；bounded lexicon（37.18 ms → 56 µs） | 首次学习复制整个 user HashMap（p95 4.763 ms）；61.1% 失败是「候选里根本没答案」 |
| **lot2extension** | WXT MV3 扩展 + Go 后端；170,650 行 ts/tsx + 89,109 行 Go | ~35 个机械门禁脚本 | 中低：Redis DLQ+reclaim；028 覆盖索引；rAF 合并；规则事件批量 | page-snapshot 队列**没有消费者**；过滤规则线性扫描 + 每规则 new RegExp |
| **rustopt** | Rust 单二进制；13 `.rs` / 3,871 行；依赖只有 serde | 61 测试；3 OS CI 矩阵 | 高（自审有实测 delta）：guard 7.5×、measure 2.4×、preflight 1.82× | variant 矩阵串行（实测 2.24× 空间）；ledger `2+2N` 次 open + 无界 |

**一个横向判断**：这七个项目的性能治理成熟度与 shaders 的**正好互补**。
- dsh/los/rustopt 有**测量与门禁**，缺的是 shaders 那种**「把某一类 bug 变成结构性不可表示」的差分不变式**；
- ComfyUI/cantool/lot2extension 有**运行时机制**，缺的是 shaders 那种**缓存键与失效作用域的完备性证明**；
- cankey 两边都不缺，缺的是**把缓存/复制的粒度从「整份」降到「脏项」**。

---

## 2. Shaders 可迁移机制清单（模式卡）

每条模式卡给：**机制 → 证据 → 领域无关表述 → 适用问题类 → 边界/反例**。

### M1 缓存键覆盖率差分门禁 ★最高杠杆

**机制**。`compileTimeHashCoverage.test.ts` 把「某个会影响生成代码的 prop 没有进入结构性哈希 → 缓存返回陈旧流水线 → 控件看起来失效」这一类 bug 编码成对整个 199 个 shader 的**双向差分不变式**：
- 正向：对每个 `compileTime: true` prop，跨边界改动后哈希**必须变**（`:104-140`）；
- 反向：对每个 `compileTimeWhen` prop，跨桶改动哈希**必须变**，同桶微调哈希**必须不变**且**不得触发重编**（`:142-215`）；
- **自覆盖交叉校验**：断言「实际测到的 prop 数」等于「从注册表推导出的 prop 数」，这样一个被循环静默跳过的 prop 仍然会让测试失败（`:228-233`）。

**证据**：`packages/core/src/__tests__/gpu/compileTimeHashCoverage.test.ts`；被验证的键生成在 `packages/core/src/gpu/composer.ts:1668-1737`（`collectStructuralHashInputs`）与 `packages/core/src/gpu/index.ts:1369-1422`（`extraHashInputs`）。

**领域无关表述**：「对任一内容寻址缓存，从真理源枚举出全部影响输出的输入，逐项验证：改变它必须改变键，不改变它必须不改变键；并且验证这个枚举本身覆盖了真理源的全部条目。」

**适用问题类**：构建系统增量重建判定、查询规划器指纹、ORM 语句缓存、HTTP `Vary`/ETag、LLM prompt 前缀缓存键、**任何「改了配置但结果没变」的 bug 类**。

**边界**：反向断言（同桶不变）是这套测试真正的价值所在，只做正向会产生「过度失效」——性能问题而非正确性问题，所以很容易被忽略。shaders 的注释明确记录了它的二级哈希设计（纯模型哈希 + 宿主状态哈希）以及为什么**动画中的字符串谓词必须指纹其规范化投影**而不能逐字折叠（`index.ts:1395-1399`，否则每帧换键 → swap 抖动）。

**真问题**：它要求有「真理源枚举」的能力。shaders 能这么做是因为定义是数据（`GpuShaderDefinition.props`）。**迁移前提是目标项目的缓存输入也能被机械枚举**——这点在 ComfyUI、cankey、los 都成立，在 lot2extension 部分成立。

---

### M2 显式结构性哈希 + LRU + 活跃态钉住 + dispose 钩子

**机制**（`packages/core/src/gpu/pipelineCache.ts`，全文 173 行，是整个仓库最干净的模块）：
- **键**：FNV-1a 32 位摘要 + 长度消歧（`:24-34`）。触发集是**枚举出来的、写在代码里的**（`pipelineCache.ts:1-16` 头部注释列出全部触发项）；
- **钉住**：`evictIfNeeded` 显式跳过 active 与 pending 条目，找不到可驱逐对象就**放弃驱逐**而不是驱逐活跃项（`:78-102`）；测试覆盖 `maxSize:1` 且两个活跃条目时**不驱逐**（`pipelineCache.test.ts:114-140`）；
- **dispose 钩子**：驱逐时调用调用方的 `dispose(value, hash)`（`:36-40`），把独占资源（RTT 纹理）的释放责任交回所有者；
- **泛型化**：`createPipelineCache<V>` 对 GPU 零耦合，可以用普通对象 + spy disposer 单测。

**领域无关表述**：「缓存键来自声明式枚举的失效触发集；驱逐策略必须尊重活跃性钉住（它是工作集而不是纯缓存）；驱逐必须提供所有权/释放钩子，而不是假定 GC 或手工拆除。」

**适用问题类**：连接池、预处理语句缓存、页缓存（pinned pages）、推理服务的 KV cache 驱逐、构建产物缓存。

**边界**：`maxSize = 4` 是**场景经验值**（编辑时来回切换），不是普适常数（`pipelineCache.ts:36-40` 注释说明了理由）。迁移时必须重新推导容量。

---

### M3 swap-when-ready（先证明再提升）

**机制**。组合变化时**立即构建**新组合，但**旧的继续渲染**，直到新的成功画出第一帧（`markReady`）；如果渲染返回 `false`（组合是坏的），**跳过** `markReady`，最后一帧好画面保留（`pipelineCache.ts:49-76,104-143`；`frame.ts:248-284` 显式在 `drew === false` 时跳过提升；`index.ts:2416-2421`）。

**领域无关表述**：「像双缓冲帧缓冲一样双缓冲**配置变更**——只有在替代品自我证明之后才提升它，于是重配置永不产生可见退化。」

**适用问题类**：蓝绿/金丝雀部署、原子配置切换、影子流量验证、LLM 模型切换、schema 迁移的兼容窗口、**任何「重配置期间服务旧结果」的场景**。

**边界**：这是**有用户可见连续性要求**时才值得。对批处理任务（rustopt 的 variant 矩阵）没有意义，那里正确的东西是 M6 的并行调度。

**组合价值**：M2 + M3 合起来才是「缓存三件套」——键、驱逐、提升门。很多项目只做了键和驱逐。

---

### M4 算子代数融合：保守谓词 + 预算 + 保底回退

**机制**（`packages/core/src/gpu/composer.ts:1170-1427`）。核心是**一条交换律**：

> UV 重映射与点态合成可交换：`blend(cᵢ)(f(uv)) ≡ blend(cᵢ(f(uv)))`

于是可以把一串坐标重映射**折叠**成一个坐标，并**下推**到每个子节点直接求值，从而完全消除中间光栅化（少一个 RTT pass，且放大时不再损失分辨率）。整套判定骨架：

1. **纯静态谓词** `pushdownEligible`，**必须无副作用**（`:1193-1221` 明确注释 "PURE — it must not compose anything"，理由：部分合成的副作用会留下已注册的 RTT 边界/计算步骤/媒体纹理，而这条路径随后被放弃）；
2. **否定清单** `analyticHasFallbackTriggers`（`:1129-1137`）：mask、opacity<1、非 normal 混合、活跃变换、任何 box —— 任一命中即不合格；
3. **预算上限**：`PUSHDOWN_MAX_NODES = 24`（`:1189-1191`），嵌套链 `MAX = 8`（`:1372-1373`），「防止病态树生成巨大折叠」；
4. **保底回退**：不合格就走 RTT 物化路径，永远存在；
5. **结果可结构性断言**：`analyticPushdown.test.ts:172` 断言 `ir.rttPasses.length === 0`；`:175-179` 断言 4 个叶子的折叠只产生 1 次坐标计算 + 4 次体调用；`:211-243` 断言三个**反例**必须回退到 RTT。

**同时存在的另一种融合更简单**：`pointwiseFilter` —— 一个「需要 child 但不需要 RTT」的算子接收到已合成的颜色表达式并内联返回，**贡献零个 GPU pass**（`scaffolds/pointwiseFilter.ts:1-33`）。判定就是定义上的一个静态标志。

**领域无关表述**：「用一个可证明安全的代数定律做融合；用纯静态谓词把合法性子集界定出来；用显式预算封住搜索；永远保留物化回退路径。并提出结构性指标（pass 数、调用点数）而不是端到端质量指标来测试它。」

**适用问题类**：SQL 谓词/投影下推与循环融合、DataFrame/RDD 融合、张量编译器算子融合、流处理链融合、**以及任何「一串可交换的变换步骤」——比如 LLM 上下文压缩链（prune → summarize → truncate → reorder）**。

**边界**：「可交换」的证明是这里唯一不能打折的部分。shaders 花了大量注释解释**为什么**每个否定项不合格（例如 `requiresChild` 叶子消耗前序兄弟，不是点态操作）。迁移时如果写不出这条交换律，就不要做融合。

---

### M5 dirty 集合 + 每 tick 一次批量提交

**机制**（`packages/core/src/gpu/uniformStore.ts:642-663,879-912`）：
- 写入落进 `dirtyScalars: Set<FieldHandle>` 与 `dirtyArrays: Map<handle, Set<index>|'all'>`；
- `flush()` 每帧一次，合并成**一次** `buffer.patch({n_x3:{speed}})`；
- `writeAll()` 是全缓冲回退路径（`:917-918`）；
- **粒度匹配**：单元素写发送稀疏 `{3: v}` map；整数组写按**元素**分块；vec 元素数组把扁平分量下标翻译成**元素级**元组，因为序列化器只 patch 整个元素（`:502-524`）。注释明确记录：用错粒度会静默污染兄弟数据。

**领域无关表述**：「细粒度累积脏标记、粗粒度每 tick 提交一次；**并且在宣称『稀疏』之前先确知序列化器的真实更新粒度**。」

**适用问题类**：write-behind DB 批、脏页刷写、React 提交批处理、WAL group commit、事件循环合并、**ledger/日志的文件 open 次数**。

**边界**：注释里的两条教训值得单独记住：
1. 第二处 flush 的必要性（`passManager.ts:364-382`）：计算节点在收集阶段写了 uniform，若不在计算后、pass 前再 flush 一次，fragment 会用**上一帧的域参数**去采样刚重算完的场 —— 一帧的错误缩放闪烁。**生产者与消费者之间需要有显式 flush 点。**
2. 帧序：driver 写入必须在 flush **之前**（`frame.ts:274-284` + `frame.test.ts:165-171`）。

---

### M6 失效作用域分级

**机制**（`passManager.ts`）。四级失效，最便宜的先行：

| 级别 | 触发 | 动作 | 证据 |
|---|---|---|---|
| 1 | prop 值变化 | 一次 patch（<1 帧） | `uniformStore.ts:879-912` |
| 2 | 媒体纹理身份变化 | **只重建该 pass 的 bind group**（比较 backing texture 身份 vs 每 pass 的 `mediaSnapshot`） | `passManager.ts:41-43,328-343` |
| 3 | 结构变化 | 新哈希 → 新组合 | `pipelineCache.ts` |
| 4 | 设备丢失 | 全部重建 | `root.ts:57-72,310-330` |

**级别 2 有一个极好的反例教训**（`passManager.ts:399-435`）：`RenderTexture.resize` 是**销毁+重建**（新身份），而 bind group 捕获的是旧身份 → 复用即触发 WebGPU 校验错误 → 整个命令缓冲被丢弃 → **画面全黑**。修法是显式地在 resize 之后重建所有受影响句柄，并且 `resize` 返回「是否真的重建过」让调用方决定要不要做。

**领域无关表述**：「被缓存句柄所引用的底层对象如果被**替换**而不是被**修改**，必须显式传播失效（重建句柄，而不是重建产物）；检测用廉价的身份/值比较，而不是通知管道。」

**适用问题类**：重连后的 HTTP/DB 连接池、文件替换后的 mmap、模块热重载、ORM identity map 在重新取数之后、**任何「stale handle after reallocation」bug 类**。

**边界**：shaders 的注释也承认**这仍然是一个 bug 的多发区**（注释直接写了「这正是 'Destroyed texture used in a submit' 校验错误」）。迁移价值在于那个**不变式**（「任何从资源身份派生的缓存句柄，必须被重建该资源的同一事件失效」）以及一条对应测试。

---

### M7 单一真源 codegen + 生成物提交门禁 + 标记区重写

**机制**（三层，缺一不可）：
1. **生成**：`FRAMEWORK_CONFIGS` 声明表（`generate-components.ts:17-53`）+ 每框架模板 + 占位符替换；`generateRegistry.ts` 扫描 `src/shaders/*/index.ts` 生成排序后的注册表，**并重写 `package.json` 的 `exports` map**（`generateRegistry.ts:28-62`）；已废弃名字生成**指向规范产物的别名条目**（零文件重复）。
2. **重写手写文件中的标记区**：`// <<< SHADERS_PREVIEW_MAP:START >>>` / `:END >>>`（`generate-components.ts:394-484`，落在手写的 `packages/react/src/engine/Preview.tsx:139,342`）—— 生成器只碰标记之间，其余手写内容不受影响。
3. **CI 门禁证明「重新生成是 no-op」**：build 之后 `git diff --quiet` 必须成立，否则 PR 被拒并打印文件列表（`.github/workflows/test.yml:54-62`）。这能成立是因为注册表和 `package.json` 是**提交进版本库的**，而框架侧组件是 gitignore 的。

**其他两个细节**：
- **打破生成器 ↔ 生成物循环**：`readDeprecatedNames` 用**文本扫描**而不是 import 模块，因为重命名后陈旧注册表仍会 import 旧目录并加载失败（`generateRegistry.ts:9-21`）。
- **类型从运行时注册表派生**：`loadMappableProps` import **已构建的** `core/dist/registry.js`，用 `Omit<ComponentProps, __OMIT_TYPE__>` 把可驱动 prop 拉出来再叠加 `| PropDriver`（`generate-components.ts:55-87,146-155`）。

**领域无关表述**：「多目标发布 = 一个真源 + 声明式目标表 + 模板 + 手写文件内的标记区重写；**绝不 fork 产物**。用 CI 的『生成后无 diff』来证明生成是幂等的。用文本扫描打断生成器与生成物之间的 import 循环。」

**适用问题类**：多语言 SDK 生成、protobuf/OpenAPI 多语言客户端、跨编辑器扩展构建、monorepo 入口生成、i18n 命名空间发现、**契约优先项目里的「contracts/ → 生成类型 → 实现」链**。

---

### M8 docs-as-code → 单一 manifest → llms.txt/MCP + 覆盖率棘轮

**机制**。`scripts/docsManifest.ts`（1047 行）同时是可 import 的库和 CLI：
- **来源优先级**：① 签名与类型（**TypeScript 编译器 API**，`createProgram`，`:277-291`）→ ② 文档注释 + 标签集（`@example`/`@tip`/`@see`/`@category`/`@internal`）→ ③ 按类别的策展 markdown；
- **派生事实而非人工编写**：`usedBy`（哪些库内 shader import 了这个词，穿过 barrel 解析，`:874-917`）、`@see` 交叉链接（`:934-950`）；
- **策展按标题约定解析，且拼错就硬失败**：`## Order` 里的未知名字抛异常（`:850`），reach 表里反引号名字未知也抛（`:858`）；
- **渲染器分离**：站点 / `renderLlmsText`（`:968-995`）/ 每类别 markdown（`:998-1033`）；
- **覆盖率棘轮**：`docsManifest.test.ts:19-24` 的 `UNDOCUMENTED_BASELINE = 0`，注释写明「提高这个数字是 review-blocking regression」；
- **配套的 AI 面**：`npx shaders install-mcp` 用 `add-mcp` 给各家 agent 写配置（`packages/shaders/src/cli/installMcp.ts`），并且**只给支持 http transport 的 agent 装**（`:27-37`）。

**领域无关表述**：「从代码自己的类型与注释生成每个文档域一份 JSON manifest，所有面向（站点、llms.txt、分类 markdown、agent skill）都从它渲染；手写内容仅限**被生成的词表校验过的**编辑性策展；把文档漂移变成一个单调的数值门禁。」

**适用问题类**：docs-as-code、API reference 站点、LLM 上下文文件、SDK README 生成、i18n 术语表、**插件目录 / 工具清单的 agent 可读面**。

**成本提示**：`docsManifest.ts` 是 1047 行 + 一个 299 行的 JSDoc 注入器 + 一个 2348 行的手工 catalog。这是**中大型项目的投入**，不是小项目的第一优先级。

---

### M9 变更分级门禁 Gate A/B/C + 显式豁免清单

**机制**（`packages/core/src/gpu/kit/PRIMITIVES.md:100-146`）。每个抽取/迁移**事先分类**，类别决定所需证据，「大概没问题」不是选项：

- **Gate A — 字节等价**：前后生成的 WGSL 必须字节相同，由现有 `tgpu.resolve` 快照测试验证，**快照不许移动**。无需人眼检查。这是机械抽取的目标。
- **Gate B — 论证上像素中性**：WGSL 文本变了（重命名、声明重排、`$name` 前缀不同）但数学可证相同。需要更新快照 + reviewer 阅读 diff。
- **Gate C — 会改变像素**：需要**逐 shader 视觉签核** + 记录进 Gate C changelog。

**两个看起来像 Gate A 但不是的陷阱**（`:120-131`）：
- **浮点运算重排序**：把表达式重构成「同一个」原语可能改变加法/乘法顺序。**浮点下结合律不是免费的。** 任何非字节等价的 WGSL 至少是 Gate B —— 在 HDR 辐射模型和 fbm 循环上最容易踩。
- **重命名**：函数名出现在生成的 WGSL 里，所以改名会移动快照。要求**改名提交与逻辑提交分开**，让 diff 可读。

**配套的 bail-out 规则**（`:140-146`）：「如果 Gate A 迁移无法在合理工作量内达到字节等价，**跳过那个消费者并记录原因**。原语不得为了让某个异类收敛而扭曲自己 —— 永久异类是完全合法的结果，每个类别维护一份显式的异类清单。」

**领域无关表述**：「把变更按『可验证等价强度』分成三档，每档要求不同的证据；把浮点/数值重排显式划出『看起来等价』的陷阱；给迁移一条合法的退出路径，并要求记录异类清单。」

**适用问题类**：编译器/codegen 重构、数值库迁移、采样/注意力核替换、序列化格式迁移、**任何「重构但行为不该变」的大规模机械改动**。

**注意**：这条与 M1 互补。M1 管「缓存键是否完备」，M9 管「这次改动是否真的等价」。

---

### M10 无基质测试编译器

**机制**（`packages/core/src/__tests__/gpu/`）。266 个测试文件全部**不需要 GPU**，靠三个可组合的假件：
1. **mock store root**：只提供 `createBuffer`/`createBindGroup` 的 `vi.fn`（`_patternHarness.ts:17-27`）；
2. **真实的 prop→GPU 桥**：`buildRegistry`（`_patternHarness.ts:58-104`）调用**真的** `createGpuUniformsMap`、**真的** `SystemUniforms` schema，并**手工重新注册渲染器的合成字段**（`_opacity`、`_animTime`、`_animTime_<key>`、`extraFields`）—— 让假件**忠实**而不是**方便**；
3. **`tgpu.resolve([...], {names:'strict'})`** 生成断言文本。

然后断言的是**结构性属性**而非像素：`ir.rttPasses.length === 0`、某函数调用点计数（排除 `fn name(` 定义行）、`calls(wgsl,'genBody') === 4 && bulgeUV === 1`，以及**必须回退**的负例。

另外两个测试层级也值得注意：
- **CPU golden 参照**：`helpers/shapeGolden.ts:1-6` 手抄 v1 的 fragment 数学，用来验证导出的 DualFn 是**数学等价**而不仅仅是**自洽**；
- **跨产物一致性扫描**：`enumPropSweep.test.ts:38-65` 对每个 shader，若某个 `select` prop 在**源码文本**里被读作 `uniforms.<prop>`（先剥注释，`:31-33`，正是为了防止 v1 参考注释造成假阴性），则它的 `transform` 必须是已注册的数值变换 —— 否则原始字符串会落进 `f32` 变成 NaN。**这类 bug 类型系统和单测都看不见。**

**领域无关表述**：「要测试一个编译器，你不需要执行基质。只 mock 分配资源的那条边界，保留真实的代码生成路径，断言 IR 的结构性指标 + 快照。测试输出的**形状**，不是像素。」

**适用问题类**：查询规划器测试、编译器测试、Terraform plan 断言、`EXPLAIN` 断言、CI 流水线 lint、prompt 模板快照、**LLM 上下文压缩链的结构断言**。

---

### M11 契约、边界与决策登记

三条小而硬的模式：

1. **单规则 facade lint**（`packages/core/eslint.config.mjs`）：整个文件只有一个目的 —— `no-restricted-imports` 禁止 `src/**` 里 import `typegpu`/`unplugin-typegpu`，唯一豁免是 facade `src/gpu/**`。**但 CI 没跑它**（只出现在 PR 模板的 checklist 里）。**机制值得抄，执行力度的反面教材同样值得抄。**
2. **scaffold 承担重复决策**：`definePointwiseFilter` 拥有「identity 旁路」模式（缺 child 守卫、编译期 identity 绕过、map-driver 守卫），文档明确写了「scaffold 拥有 `compileTimeWhen` identity-bypass 模式，所以它被统一应用。strength 为 0 的 filter 应该原样返回 child，这个决定属于 scaffold，不属于每个 shader」（`PRIMITIVES.md:88-92`）。**把重复的工程决策从 N 个实现上移到 1 个工厂。**
3. **决策登记册**：`PRIMITIVES.md` 不是目录而是**规则册**：C1–C9（调用约定、双形态、高阶原语、字段需求导出、编译期/运行期轴、纹理 fn-arg 规则、验证门禁、每模块测试、命名与放置）+ 「已解决的约定」D-1/D-2/D-6 + 「实现中学到的」章节。它显式服务两类读者：「本文档写给**修改 kit 的人**……如果你是**写 shader 的人**，读 `CATALOG.md`」（`PRIMITIVES.md:3-7`）。配套的 `CATALOG.md` 开头有一条 review-blocking 规则：「**写内联数学之前先查这里**……在这个目录里手写已有原语是 review-blocking 缺陷。」（`CATALOG.md:7-9`）

**领域无关表述**：「用一条 lint 规则表达包边界；把重复的工程决策上移到工厂；维护一份带编号的规则册 + 已解决约定 + 『实现中学到的』，并显式区分维护者文档与使用者文档。」

---

### M12 性能预算与作者/宿主分级诊断

**机制**：
- **性能追踪器**（`packages/core/src/performanceTracker.ts`）：60 样本环形缓冲、p99、jank 计数与百分比、`budgetUsed`（相对 16.67 ms 预算）、复杂度分（nodeCount / rttNodeCount）、内存增长速率、CPU/GPU 拆分、并归一化成 0–100 的 intensity score + label。遥测类型（`src/telemetry/types.ts`）把它作为结构化 payload 上报。
- **诊断按受众分级**（`support.ts:79-143`）：默认静默（页面跑不了 WebGPU 时画布透明、控制台干净）；但一旦用了自定义 WGSL，编译失败就升级为**无条件 `console.error`** —— 因为写 WGSL 的作者需要编译器消息。重复告警按作用域**闩锁一次**（`externalSkipLogged`、`warnedNonPackableTransforms`）。
- **失败原因机器可读 + 结构检测**：`GpuFailureReason` 联合类型；`isGpuUnavailableError` 用**形状检查而非 `instanceof`**，因为同一份源码在打包/别名下可能产生两个模块记录，把确定结论变成重试（`support.ts:18-73`）。
- **按爆炸半径分类的失败**：页面级原因（unsupported / no-adapter / no-device / out-of-memory / gpu-error）**闩锁到页面级**，防止一个页面上多个 shader 各自独立耗尽同一个 GPU（「一个特效没加载」→「标签页卡死」）；渲染器级（init-failed / render-failed / device-lost）不闩锁；`limit-exceeded` 因为属于**组合**而非 GPU，也不闩锁（`support.ts:204-247`）。
- **错误作用域隔离 + 粘性放弃**：带用户 WGSL 的组合在 `pushErrorScope('validation')` 内渲染前 3 帧（`finally` 里 pop，防止抛异常留下开口作用域吞掉后续错误）；错误只标记**那个组合**坏掉。渲染器级阈值：连续 5 次渲染错误放弃、32 次未捕获校验错误放弃、OOM 立即关闭；**「放弃」是粘性的，没有重试风暴**（`index.ts:1441-1486,2416-2440`）。
- **能力分层**：可选 feature（`float32-filterable`、`timestamp-query`）缺失也能初始化；缺失时走**静态声明的保守 ABI**（float32 纹理在 group-1 layout 里声明 `sampleType:'unfilterable-float'`，因为只用 `textureLoad` 读、永不滤波）；device limit **读取而非假定**，带规范最小值回退，软限制**只断言不抛**（`root.ts:41-48`、`composer.ts:399-406,1569-1578`、`passManager.ts:107-112`、`uniformStore.ts:846-861`）。
- **单例 + 缓存承载**：一个页面一个 `GPUDevice`，**故意不销毁** —— 因为 device 拥有浏览器的编译流水线缓存，per-renderer device 会让 SPA 每次路由切换重编译所有 shader；默认 root 缓存的是**承诺**而不是已解析值，所以同 tick 的 N 次挂载共享一次在途请求（`root.ts:5-25,87,181-205`；测试 `deviceLostFanout.test.ts:201-218` 验证 4 个并发挂载 → 1 次请求）。

**领域无关表述**：「性能预算是产品的一等公民（p99/预算占用/卡顿率）；诊断按**受众**分级并按键闩锁；失败按**爆炸半径**分类闩锁；可选能力缺失走保守 ABI；昂贵的、可共享的、承载缓存的资源做成进程单例，且缓存**在途承诺**而不是已解析值以压平惊群。」

---

### M13 资源生命周期与两阶段绑定

**机制**（`passManager.ts:148-174`、`gpu/scaffolds/lateBoundChild.ts:70-89`、`gpu/compute.ts:135-271`）：

1. **按稳定逻辑键的资源池 + 对账式清扫**：`allocateRttTextures` 复用仍需要的键（原地 resize）、只为新键创建、然后销毁新组合不再需要的键。**是「对账」而不是「在拆除时分配」。**
2. **两阶段（延迟绑定）**：计算节点可以在物理纹理存在之前就引用子 RTT 边界。composer 记录一个 `bindInputs(resolve)` 回调，passManager 在分配**之后**调用它（并在每次重合成/resize 时再调用）。把「解析键 → 未分配则退出 → 建组」这套写法收进一个 `createLateBoundChildInput`。
3. **ping-pong 对：预先构建两个朝向的 bind group**，于是 `swap()` 只是翻转一个标志、零分配；同时提供 `perSide(make)` 让消费者说「刚写入的那一侧」而不是自己跟踪标志（`compute.ts:135-220`）。被弃用的旧 API 附了三段式事后分析，说明为什么「一个 bind group 家族 + 没有朝向查询 + 只能急切构建」不匹配任何真实消费者。
4. **反馈模拟 scaffold**：把「两个状态纹理 + 一个显示副本 + 生命周期 + 时钟 + 延迟绑定的 child」封装在一个构造函数后面，返回一个 `tick`；**只有 step 回调真的返回了步骤才 swap**（空闲帧不改变朝向）（`scaffolds/feedbackSim.ts:1-34,141-217`）。
5. **预热重绘与帧内顺序修复**：`resize` 会重建**归零**的 RTT，所以读子 RTT 的计算步骤会黑一帧；渲染器在 `resize` 报告真的重建过时调用 `repaintRtt()`（**只重绘 RTT，不跑 compute** —— 否则 ping-pong 模拟会双步进）。

**领域无关表述**：「资源池按稳定逻辑键寻址 + 对账式期望/实际集合差清扫；把构造拆成『声明依赖』与『依赖可用后解析』；双缓冲做成零分配的一等抽象并暴露**朝向角色**；重新分配后确定性地重导依赖状态再让消费者运行。」

**适用问题类**：媒体管线的 arena/buffer 池、连接池、流式算子的检查点、双缓冲 ETL 暂存表、DI 容器的惰性绑定、查询规划器物化 CTE、构建系统解析产物路径。

---

### M14 数据布局 / 打包 / 确定性标识

**机制**（`uniformStore.ts`）：
- **一个组合一个打包 uniform buffer**，每次节点结构是 `n_<sanitizedId>`，加上 `_sys`。
- **按 ABI 补 struct 的「大小」而不是对齐成员**：严格 WGSL uniform 布局要求结构体成员落在 16 字节对齐偏移；修法是给每个节点结构体**补隐藏 `_pad*: f32` 把大小凑成 16 的倍数**，而**故意不用** `d.align(16,…)` —— 因为 TypeGPU 的部分写路径不展开 Decorated 成员，那会把结构体降级成「叶子」，让稀疏 patch 用 NaN 覆盖兄弟字段（`:795-844`，理由写在 `:801-815`）。
- **粒度匹配的 patch 载荷**（`{3: v}` 稀疏、按元素分块、vec 元素下标翻译）。
- **uniform 地址空间的数组打包**：`array<f32, N>` 在 uniform 地址空间非法（元素步长需 16 字节），所以多色标打包成 `array<vec4f, 8>` 等；并在类型映射处留下给下一位作者的警告（`:132-166`，CAUTION at `:139-145`）。
- **确定性、命名空间安全的标识符派生**：`sanitizeId` → `sanitizeFieldId`（本地复制 WGSL 保留字集合，不依赖 TypeGPU 内部路径）→ 节点键加 `n_` 前缀；定义期校验拒绝与 layer prop / 渲染器合成前缀冲突的 prop 名；kernel `$name` 内嵌结构键（`waveFieldPropagate_${resolution}`），因为**名字会进生成的 WGSL 与快照**（`:55-106`、`lower.ts:352-383`、`waves.ts:106,122`）。

**领域无关表述**：「硬件/ABI 的打包约束应该编码进类型映射本身，并把约束留在代码里（下一位作者必须满足它）；遵守内存布局 ABI 时优先补**大小**而非对齐成员，并在采用某个 workaround 之前先验证它与序列化/部分更新路径兼容；从结构键确定性派生标识符，并把生成的标识符当作 ABI（快照稳定）。」

**适用问题类**：C struct 布局/SIMD 对齐、protobuf/flatbuffer padding、DB 行列/page 布局、列式缓冲对齐、网络包分帧、**任何 codegen 的符号名稳定性**。

---

### M15 静止即不做（quiescence）

**机制**：
- 波场模拟从阻尼参数推导**稳定时间**（`log(1e-6)/log(dampFactor) * 16.67`，上限 30 s），指针空闲超过该时间后 `getComputeNodes` 返回 `null` —— **完全不 dispatch**（`std/sim/waves.ts:204-231`）；流体发射器有带 `fadeSeconds` 策略的空闲门（`std/sim/fluids.ts:418-436`）；
- 帧门：离屏节流到 1 FPS，可被 per-renderer 旁路（`frame.ts:163-215`）；
- **「无工作」以 `null` 步骤列表向上传播**，而不是靠轮询判断。

**领域无关表述**：「从系统自身动力学推导静止期限，而不是轮询；让『无工作』作为一种可传播的值而不是一个被检查的状态。」

**适用问题类**：CDC 空闲检测、轮询→事件驱动改造、autoscaling 缩到零、GC 静止、后台任务节流。

---

### M16 降低层：声明式前端 + 角色推断 + 矛盾即错误

**机制**（`packages/core/src/std/lower.ts`）。作者写一个 `StdDefinition`，恰好带 `paint:`/`effect:`/`map:`/`shape:`/`gpu:` 之一。`inferRole` 从「哪个字段存在」推导角色，**并拒绝与之矛盾的显式 `role` 声明**；`inferSpecies` 区分点态与聚集；`lowerProps` 把 `recompile: crosses(v)` / `custom` 翻译成 `compileTimeWhen` 谓词；`lowerIdentityRule` 把 `isZero`/`isValue`/`allOf` 编译成 scaffold 的 `FilterIdentity`。输出是**普通的 `GpuShaderDefinition`**，所以注册表、框架组件、编辑器元数据、preset 全部不需要知道这个新作者面存在（维护者注释 `lower.ts:11-17`）。

配套两条：
- **用闭代数替换用户回调**：`StdPropConfig = Omit<PropConfig<V>,'compileTimeWhen'> & {recompile?: RecompileRule}` —— **在类型上删掉了函数式逃生口**，换成声明式规则联合（`std/types.ts:31-43`）。注释写明不变式：「recompile 行为是**声明的**，从来不是一个函数」（`types.ts:14-17`）。收益：可序列化、可分析、可生成文档、行为集有界因此可穷举测试。
- **内容指纹穿过降低层**：`wgslRevision` 对作者写的 body 文本 + 显式输入的稳定序列化（键排序、含值**与声明类型**、signal 图按 kind 序列化）做 FNV-1a，盖到降低后的定义上，于是**同名不同内容**的实时编辑仍会重合成（`lower.ts:304-350`）。

**领域无关表述**：「作者面 = 到既有内部契约的**纯降低**，这样下游消费者完全不需要学习新面，DSL 永不成为第二真源；角色由判别字段**推断**并拒绝矛盾声明；用闭代数替代用户回调以获得可序列化与可穷举测试；同名可变内容的产物携带确定性内容摘要。」

**适用问题类**：protobuf/IDL → 运行时绑定、ORM DSL → SQL、Terraform HCL → provider 调用、SDK 流式构建器、CEL/Rego 规则、CI 的 `paths`/`if` 条件、特性开关定向规则。

---

### M17 规格性规划必须无副作用 / 结果从产物反推依赖

两条容易被忽略但很硬的模式：

1. **规格性探针必须纯**（`composer.ts:1193-1221`）。`pushdownEligible` 被文档明确要求「PURE —— 它不得合成任何东西」，因为部分合成会把 RTT 边界/计算步骤/媒体纹理留给一条随后被放弃的路径。有副作用的 `composeAtUV` 只在**整棵子树**的合格性判定完成之后才跑。
   - 泛化：查询规划器（EXPLAIN vs 执行）、事务性 dry-run 校验、特性开关求值、构建图的「会重建什么」查询。
2. **依赖从生成的产物里反推**（`composer.ts:1551-1608`）。序列化完 fragment body 之后，用正则提取**实际出现**的 `tex.$.<key>` / `ext.$.<key>` / `samp.$.` 引用，**只按这些键**构建该 pass 的 bind group layout —— 于是 RTT pass 从结构上**不可能**绑定自己的输出，读/写冒险不是靠纪律避免，而是构造上不存在。
   - 泛化：链接器符号解析、构建产物依赖扫描、基于 trace 的依赖图、LLM 工具调用图恢复。
3. **代码生成边界上的 CSE 与语句提升**：`EmitContext.external()` 按对象身份去重（一个 blend fn 用 20 次只声明一次）；`memo(key, factory)` 每个 fragment 作用域最多跑一次；`asLocal` 的存在是因为 `member()` 没有 CSE、会重复发出整棵子树 —— 不提升的下推会发出深度为 2^depth 的生成器体（`composer.ts:106-122,1263-1269,1294`）。
   - 泛化：SQL AST → SQL 渲染、protobuf codegen、模板/AST 编译器、**带共享前缀的 LLM prompt 组装**。

---

### 2.18 补充：四条值得单独记住的小机制

这四条粒度小、但可以独立迁移。

**S1 有界突发合并（bounded burst coalescing）**。一次指针笔画被转成一条「邮票带」：在上一帧位置与当前位置之间做插值，带 `stepSize` 与**硬上限 `maxSteps = 64`**「这样一次快速甩动不会失控」，每个邮票的参数由 thunk 在它的 dispatch 前立即写入（`std/sim/fluids.ts:381-398,439-452`）。
- **领域无关表述**：「把可变速率的事件流合并成每 tick 有界的离散工作项，用插值避免断点，并加失控上限。」
- **适用**：鼠标/遥测事件合并、流式微批大小、限速出网、音频采样块调度。
- **判定**：小机制，但「上限 + 插值 + 合并」三件套是任何事件驱动管道的标准配置。

**S2 显式空闲栅栏 + 已测量代价的旁路**。`awaitGpuIdle` 用 `queue.onSubmittedWorkDone()`，带 16 ms 超时回退供 mock 用；捕获/导出路径可以跳过栅栏，并且**把代价写在文档里**（Firefox 152 约 104 ms/次 vs Chromium 约 1 ms；600 帧导出从 12 s 变成 60 s）（`frame.ts:221-238`、`index.ts:2489-2519`）。
- **领域无关表述**：「把同步栅栏暴露为调用方可控的选项，附上实测代价；并为缺少该 API 的环境保留不挂起的回退。」
- **适用**：`fsync`/持久化的选择性放弃、HTTP flush/Expect-100 控制、checkpoint 屏障、管道里 `await`-all vs fire-and-forget。
- **价值**：这条把「性能开关」和「代价证据」绑在一起 —— 大多数项目只有开关没有代价数字。

**S3 依赖底层 FIFO 保证来保持混合步骤的总序，而不是自建屏障**。一个计算程序是**管道与内联 thunk 的混合数组**；thunk 在它的位置执行，而因为 `device.queue` 保证提交顺序，每个 thunk 就是一个隐式顺序屏障（在 thunk 里的写入对后续 dispatch 可见）。dispatcher **故意不**合并进共享编码器，并把这件事**明确记为「帧循环层的、可分离的后续优化」**（`compute.ts:101-133`，尤其 `:108-115`；测试 `compute.test.ts:42-55` 断言交错顺序）。
- **领域无关表述**：「靠底层队列已文档化的 FIFO 保证来保持异构工作的总序；把吞吐批处理作为一个显式的、可分离的优化层，而不是顺手实现。」
- **适用**：带有序副作用步骤的作业调度器、write-ahead log、事务性 outbox 顺序、actor 邮箱。

**S4 前序遍历 + 父链接（一个真实 bug 类的修复）**。结构性哈希必须显式包含 `parent:${node.parentId ?? ''}`，因为**光靠前序遍历顺序不足以标识一棵树**：注释记录了这个真实 bug —— 把一个图层重新父化到它现有子节点**下方**的那个 filter 里时，缓存不认为有变化（`composer.ts:1673-1679`）。
- **领域无关表述**：「树形结构的结构哈希必须包含父链接，不能只靠遍历顺序。」
- **适用**：AST/文档树的缓存键、DOM diff、树形配置的变更检测、任何依赖「结构相同」判定的缓存。

### 2.19 明确 NOT PRESENT 的项（避免过度归因）

调研中确认 shaders **没有**做以下事情，因此不能作为「可迁移经验」引用：

- **没有通用 DAG 调度器**：pass 顺序固定为 compute → RTT（创建顺序）→ final，没有重排、没有关键路径/并行调度、没有多队列提交（`passManager.ts:364-391`）。
- **没有活跃性/引用计数式的死 pass 消除**：头部明写「每个已注册的 RTT 边界都被显式渲染」（`passManager.ts:9-10`），`repaintRtt` 无条件执行每一个 RTT pass。
- **没有受影响范围（affected-only）构建**：`turbo.json` 没有 `test` 任务、没有 `--affected`；测试跑整个 core 包。任务是缓存的，测试不是。
- **CI 不跑 lint**：`lint:facade` 只出现在 PR 模板 checklist（`eslint.config.mjs` vs `.github/`）。
- **没有真实 GPU / 像素 / 视觉回归测试**：整套测试构造上是 GPU-free 的。
- **没有 CI matrix**：单一 OS、单一 Node 22.20.x。
- **框架包没有测试**：`packages/{react,vue,svelte,solid,js}` 没有测试文件或 runner 配置。
- **没有 IR 层优化 pass 流水线或验证器**：正确性靠生成的 WGSL 文本扫描 + 快照/resolve 门禁；只有发射边界的 CSE/提升。
- **没有多后端 IR**：只有 WGSL，没有 SPIR-V/MSL/HLSL emitter。
- **没有内存压力驱动的驱逐**：uniform 总量改为**事先封顶并拒绝**（`uniformStore.ts:846-861`），而不是事后驱逐。

---

## 3. 从 shaders 到「编程开发的优化」：一张映射表

把上面 17 条按**通用软件工程问题类**重新索引（这张表是本报告对「哪些可以适用编程开发的优化」的直接回答）：

| 通用问题类 | shaders 的对应机制 | 关键证据 |
|---|---|---|
| 增量构建 / 缓存失效判定 | M1 差分不变式 + M2 显式结构哈希 + M6 失效作用域分级 | `compileTimeHashCoverage.test.ts`、`pipelineCache.ts:24-34`、`passManager.ts:41-43` |
| 查询/算子融合 | M4 可交换律 + 纯谓词 + 预算 + 保底回退 | `composer.ts:1170-1427,1129-1137,1189-1191` |
| 编译器 / DSL 设计 | M16 纯降低 + 角色推断 + 矛盾即错误 + 闭代数替代回调 | `lower.ts:399-457`、`types.ts:14-43` |
| 代码生成与「一源多目标」 | M7 声明式目标表 + 模板 + 标记区 + CI 无 diff 门禁 | `generate-components.ts:17-53,394-484`、`test.yml:54-62` |
| 数值/行为等价重构 | M9 Gate A/B/C + 浮点重排陷阱 + bail-out 与异类清单 | `PRIMITIVES.md:100-146` |
| 昂贵基质的测试策略 | M10 只 mock 资源边界 + 断言 IR 结构 + CPU golden + 跨产物一致性扫描 | `_patternHarness.ts:58-104`、`analyticPushdown.test.ts:157-179`、`enumPropSweep.test.ts:38-65` |
| 写入批处理 / 组提交 | M5 脏集合 + 每 tick 一次提交 + 生产者消费者之间的显式 flush 点 | `uniformStore.ts:879-912`、`passManager.ts:364-382` |
| 事件流合并 / 背压 | S1 有界突发合并（插值 + 硬上限 64） | `std/sim/fluids.ts:381-398,439-452` |
| 异构有序工作流 | S3 靠底层 FIFO 保证总序 + 把批处理记为可分离优化层 | `compute.ts:101-133`、`compute.test.ts:42-55` |
| 树形结构的缓存键 | S4 结构哈希必须含父链接（遍历顺序不足） | `composer.ts:1673-1679` |
| 资源池 / 句柄生命周期 | M13 稳定键对账式清扫 + 两阶段绑定 + 零分配双缓冲 | `passManager.ts:148-174`、`lateBoundChild.ts:70-89`、`compute.ts:135-220` |
| 重配置的可观测连续性 | M3 swap-when-ready（先证明再提升） | `pipelineCache.ts:49-76`、`frame.ts:248-284` |
| 故障隔离与降级 | M12 失败分类带爆炸半径 + 粘性放弃 + 错误作用域隔离 + 可选能力保守 ABI | `support.ts:18-73,204-247`、`index.ts:1441-1486` |
| 可观测性与性能预算 | M12 p99/预算占用/卡顿 + 按受众分级诊断 + 按键闩锁告警 | `performanceTracker.ts:1-50`、`support.ts:79-143` |
| 文档与 agent 可读面 | M8 单一 manifest → 多渲染器 + 覆盖率棘轮 + MCP + llms.txt | `docsManifest.ts:202-273,968-1047`、`docsManifest.test.ts:19-24` |
| 边界与治理 | M11 单规则 facade lint + scaffold 上移重复决策 + 决策登记册 + 目录的 review-blocking 规则 | `eslint.config.mjs`、`pointwiseFilter.ts:1-33`、`PRIMITIVES.md:3-7`、`CATALOG.md:7-9` |
| 内存布局 / ABI | M14 补大小不补对齐 + 粒度匹配载荷 + 约束编码进类型映射 + 确定性标识符 | `uniformStore.ts:795-844,502-524,132-166,55-106` |
| 空闲检测 / 省电 | M15 从动力学推导稳定期 + `null` 传播无工作 | `waves.ts:204-231`、`frame.ts:163-215` |
| 单例与惊群 | M12 进程单例 + 缓存**在途承诺** | `root.ts:87,181-205` |
| 规格性规划 | M17 纯探针 + 从产物反推依赖 + 发射边界 CSE | `composer.ts:1193-1221,1551-1608,106-122` |
| 发布工程 | M7 版本即产物（无 tag 即发布信号）+ 幂等 publish + 生成物提交门禁 | `scripts/release.mjs`、`release.yml:117-127` |

---

## 4. 逐项目落地分析

每项给：**现状与热点 → 建议迁移的机制 → 具体落点 → 预期收益 → 成本/风险 → 优先级**。

优先级定义：**P0** = 有明确同构问题、落点单一文件、可在一两个工作日内验证；**P1** = 需要小重构或新增测试基建；**P2** = 需要设计决策或跨模块协调。

---

### 4.1 ComfyUI —— 最高价值目标

**为什么它排第一**：ComfyUI 已经**独立演化出了与 shaders 几乎同构的机制**（结构哈希缓存、分层缓存、LRU、压力驱逐、provider 钩子、失效钩子），但因为缺少 shaders 那套**完备性证明**，它的护栏是七个项目里最弱的。

> **本节证据只来自 M1 实例（v0.24.0，无版本库）。** 复核发现 M3 实例是 **v0.37.0，且有 `.git`/`.jj` 与自己的 `AGENTS.md` 和 `benchmarks/`**——两机相差 13 个小版本，缺陷存在性、`file:line`、有无版本库全部不同。本节所有行号**不可套用到 M3**；按双实例逐机复核后的方案见 §9.2 与其两机树内文档。另：M3 正在把图执行核心移植到 Rust（`rust/crates/graph_core`），触及缓存键/图前沿的改动须经该边界。

**已有的同构机制（说明迁移不是引入新概念，而是补证明）**：

| ComfyUI | shaders 对应 | 证据 |
|---|---|---|
| `CacheKeySetInputSignature`：递归输入签名 + 依赖祖先哈希 | `collectStructuralHashInputs`：前序遍历 + 父链接 | `comfy_execution/caching.py:82-149` vs `composer.ts:1668-1737` |
| `HierarchicalCache`：子缓存树 | per-composition store（缓存命中时复用整份产物） | `caching.py:361-408` vs `index.ts:1512-1550` |
| `LRUCache(max_size=100)` / `RAMPressureCache`（psutil 余量） | `pipelineCache` LRU(4) + 活跃钉住 | `caching.py:439-506` vs `pipelineCache.ts:78-102` |
| `CacheProvider.on_lookup/on_store/should_cache` 可插拔 | `dispose` 钩子（所有权交回调用方） | `caching.py`/`cache_provider.py` vs `pipelineCache.ts:36-40` |
| 节点级 `IS_CHANGED` / `VALIDATE_INPUTS` | `compileTime` / `compileTimeWhen(prev,next)` | `nodes.py:555,1757,1812` vs `contract/index.ts:131-132` |

**建议迁移**：

**P0-1 缓存键覆盖率差分测试（M1）** ★最高杠杆
- **问题**：`to_hashable` 遇到 tensor 之类的不可哈希对象时返回 `Unhashable()`（`caching.py:50-65`）。它带着 `float("NaN")` 且没有自定义 `__eq__`/`__hash__`（已核实：文件中除类定义外无 `__eq__`/`__hash__`），因此**改变这样一个输入不会改变缓存键** —— 这正是 shaders 的 `compileTimeHashCoverage.test.ts:8-29` 用散文描述的那一类陈旧缓存 bug。
- **落点**：新增 `tests-unit/execution/test_cache_key_coverage.py`（或 `tests/execution/`，注意这两个目录的 CI 都是 `continue-on-error`，需要把这个新测试**移出** `continue-on-error` 或单独加 job）。
- **做法**：对注册表里每个 node class，逐输入做「改一点点 → 断言键必须变」；对 `IS_CHANGED` 返回 False 的输入做「同桶微调 → 断言键必须不变且不得触发重执行」；最后断言「实际遍历到的 (class, input) 对数」等于「从 `NODE_CLASS_MAPPINGS` 推导出的对数」——自覆盖交叉校验。
- **收益**：一次性消灭一整类「改了参数但输出没变」的用户可见 bug。也会立即暴露 `Unhashable` 路径的实际覆盖面。
- **成本/风险**：中。需要处理节点实例化的副作用与需要权重/模型的节点（用 mock 的 `INPUT_TYPES`，不要真加载）。
- **优先级**：**P0**。

**P0-2 `/history` 与 `jobs.get_all_jobs` 的全量扫描改为版本戳 + 合并（M5）**
- **问题**：`comfy_execution/jobs.py` 的 `get_all_jobs`/`apply_sorting` 每次请求扫描 running + queued + history 三份集合；`folder_paths.py` 的 `filename_list_cache`/`CacheHelper` 是另一处。
- **落点**：`comfy_execution/jobs.py`、`folder_paths.py`。
- **做法**：维护一个单调递增的 `generation` 版本号 + 脏集合，把「扫描」换成「命中版本号就返回缓存快照」；排序在写入时归并，而不是每次请求重排。
- **收益**：`/history` 与 queue stats 的延迟从 O(历史长度) 降到 O(变化量)。这与 lot2extension 的 `/api/admin/queue/stats` 返回恒 0 是同一类「统计口径没跟上」的问题。
- **成本/风险**：低—中；风险是版本号漏增导致陈旧视图，所以**必须**配一个 P0-1 风格的键覆盖测试。
- **优先级**：**P0**。

**P1-3 用「测量 + 分层回退」替换 17 处猜测的 `memory_usage_factor`（M9 + M12）**
- **问题**：`comfy/supported_models.py` 有约 17 处 `memory_usage_factor = X # TODO` 注释（`:740`「debug why flux mem usage is so weird on windows」、`:891`、`:919`「img2vid is about 2x vs txt2vid」、`:1203`、`:1904` …），这些常数直接驱动 VRAM 调度决策。另有 `comfy/model_base.py:416` 认为 sub-quad/split 的内存公式「might be too aggressive」。
- **落点**：`comfy/supported_models.py`、`comfy/model_base.py`、`comfy/model_management.py`。
- **做法**：（a）把每个 factor 标注为 **measured / estimated / unknown** 三档（这是 Gate A/B/C 的轻量版）；（b）unknown 档取**保守上界**并在日志里标注来源；（c）加一个需要真实权重才能跑（因此不进默认 CI）的测量脚本，把测出的值写回带 `measured_at` 与 `device` 的证据文件；（d）调度决策记录「用了哪个 factor 的哪个档」。
- **收益**：把「猜的常数」变成「有出处、有档位、有回退」的输入。shaders 的 `PRIMITIVES.md:12-25`（C1）与 `D-1/D-2/D-6` 就是同一件事的成熟形态：**约定必须写下来并给出为什么不能用另一种**。
- **成本/风险**：中；需要真实 GPU 时间做测量，但测量是离线一次性的。
- **优先级**：**P1**。

**P1-4 时序测试从「一律跳过」改为「分类 + 记录豁免」（M9）**
- **问题**：`.github/workflows/test-unit.yml` 与 `test-execution.yml` 都是 `continue-on-error: true`；`tests/conftest.py` 的 `--skip-timing-checks` 描述为「for CI environments with variable performance」。结果是**时序回归无法阻断合并**。
- **做法**：借用 Gate A/B/C 的骨架 —— 把每个时序断言标成 `gate_a`（严格上界，必须过）/ `gate_b`（宽上界，告警）/ `gate_c`（仅记录）。只有 A 档阻断合并；`--skip-timing-checks` 变成「只跳过 B/C」而不是「跳过全部」。shaders 的 `compileTimeHashCoverage` 与 `performanceTracker` 的 `budgetUsed` 是同一个思路的具体实现。
- **收益**：在不引入 CI 抖动的前提下重新获得时序护栏。
- **成本/风险**：低—中。
- **优先级**：**P1**。

**P1-5 关掉 `patches_uuid` 触发的全模型重载（M13 + M6）**
- **问题**：`comfy/model_patcher.py:691` 有 `#TODO: optimize by preventing a full model reload for this`（LoRA/patch 变化触发权重全量重载）。
- **做法**：shaders 的答案是**按稳定逻辑键的资源池 + 对账式增量**（`passManager.ts:148-174`：复用仍需要的键、只为新键创建、销毁不再需要的键），以及**粒度匹配的 patch**（`uniformStore.ts:502-524`：只 patch 变化的那一层，而不是整份）。把它套过来：把 patch 的键从「整个 patch 集合的 uuid」降到「单个 patch 的 identity」，只重算受影响的层。
- **收益**：LoRA 切换延迟直接下降。
- **成本/风险**：中高；涉及权重内存布局。
- **优先级**：**P1**（但值得单独立项）。

**P2-6 用 swap-when-ready 保证重执行期间的可观测连续性（M3）**
- **问题**：全图重执行期间前端只有进度条，没有「上一次成功的输出」可用。
- **做法**：像 shaders 保留旧组合直到新组合画出第一帧那样（`frame.ts:248-284`），让 `/history` 与预览继续服务**上一次成功的执行结果**，直到新执行的第一个节点成功产出并通过校验 —— 且新执行**失败时永不提升**。
- **注意**：ComfyUI 的**前端是 pip 包**（`comfyui-frontend-package==1.45.15`，`app/frontend_management.py` 管理），所以这条要么落在后端 API（`server.py` 的 `/history`、`/view`），要么需要同步改前端包。**这是本项成本最高的建议。**
- **优先级**：**P2**。

**P2-7 死代码消除的构造期化（M17.2 + 死代码节）**
- 当节点被绕过（`mode=4` bypass）或输出未被消费时，理想的动作是**在构造期就不生成它的执行项**，而不是生成了再跳过。shaders 的 `composedNodeIds` 集合（`composer.ts:390,1536`）由 composer 返回、由渲染器用来判断这一帧是否完整（`gpu/index.ts:1549`）—— 这个「**声明 vs 实际执行**」的不变式可以直接套到 ComfyUI 的执行列表上，也可以套到 lot2extension 的孤儿队列（见 4.6）。
- **优先级**：**P2**。

---

### 4.2 dsh（deepseek-harness）

**为什么重要**：dsh 是七个项目里**性能治理最强**的（8 条按用户路径的 CI 门禁、`benchmarks/AGENTS.md` 禁止 env 覆盖、prompt cache 是契约）。它需要的不是「测量」，而是 shaders 那种**结构性不可表示**的证明。

**P0-1 用「结构性 revision」替换重复的 `deepFreeze` 遍历（对应 M1/M2/M16 的内容指纹）** ★最高杠杆
- **问题**：`2026-09-06-backend-continuation-performance.md` 记录 CPU profile 把 **211.300 ms 中的 132.876 ms 自时间归给 `buildRequest` 调用的 `deepFreeze`**，原因是「对已经冻结的历史做重复遍历」。
- **shaders 的答案**：`Object.freeze` 本身是幂等的，**遍历不是**。shaders 用**内容指纹作为显式 revision**来替代「重新遍历确认」：`wgslRevision` 对 body 文本 + 显式输入的稳定序列化（键排序、含值**与声明类型**）做 FNV-1a，盖到定义上（`lower.ts:304-350`），于是「同名不同内容」可检测而无需遍历比对。另外 `EmitContext.external` 用**对象身份 + 作用域**做去重（`composer.ts:305-346`）。
- **落点**：`core/agent-loop/src/*`（`buildRequest` 路径）。
- **做法**：三选一或组合 ——（a）用一个 `WeakSet<object>` 记录已冻结对象，跳过重复遍历；（b）为每个 session 事件/请求片段维护一个**结构性 revision**（事件数 + 尾部哈希 + 压缩代次），`buildRequest` 只在 revision 变化时重建冻结树；（c）把冻结改为**写时复制 + 共享冻结前缀**（与 shaders 的「per-composition store 缓存命中时复用整份产物」同构，`index.ts:1512-1550`）。
- **收益**：profile 显示这占自时间 63%，是 dsh 已文档化的最大单点。
- **成本/风险**：中；必须配一个「冻结不变式」回归测试（否则会引入可变共享 bug）。
- **优先级**：**P0**。

**P0-2 为 session projection cache 与 prompt cache 加缓存键覆盖率门禁（M1）**
- **问题**：dsh 有 `session/session-projection-cache`（持久化 fold 捷径）与作为契约的 provider prompt cache（`core/agent-loop/tests/request-cache.e2e.ts` 证明首次之后 `cacheReadTokens > 0`）。`request-cache.e2e.ts` 证明的是**缓存真的命中**，但**不证明键是完备的**。
- **做法**：直接照搬 `compileTimeHashCoverage.test.ts` 的三段结构。对投影缓存：枚举所有能影响投影状态的字段（事件类型、format 版本、压缩代次、tool-result pruner 状态、spill 状态），逐项断言「改它 → 键必须变」，并断言「不改 → 键必须不变且不触发重算」；对请求缓存：枚举所有影响请求前缀的字段（system prompt 片段、工具 schema、模型/温度、历史切点），逐项同样处理；两者都做**自覆盖交叉校验**（测到的字段数 == 从真理源推导的数量）。
- **特别价值**：这正好把 **AP11 从人工评审变成机器门禁**（AP11 要求 system prompt / 工具定义 / 上下文窗口策略变更必须做 prompt cache 影响评估）。shaders 的模式提供了「评估」的机械化形式。
- **收益**：把 prompt cache 从「我们测过它命中过」升级为「我们证明键覆盖了所有会破坏它的输入」。
- **成本/风险**：中；需要把「影响请求前缀的字段」枚举出来 —— 这本身就是有价值的产物。
- **优先级**：**P0**。

**P1-3 生成物提交门禁（M7.3）**
- **问题**：dsh 有双面构建（`build:lib:host` / `build:lib:client`，`tsc -b` + tsdown）和约 80 个 `verify-*` 脚本，但没有「build 之后 `git diff --quiet` 必须成立」这一条。
- **落点**：`.github/workflows/ci.yml`（或 `scripts/run-gates.ts`）。
- **做法**：在 CI 里 build 之后断言工作区无 diff，否则失败并打印变更文件。前提是生成物**提交进版本库**（shaders 的做法：注册表与 `package.json` 提交，框架侧组件 gitignore）。
- **收益**：消灭「本地生成了但忘记提交」这类只在别人机器上炸的问题。
- **成本/风险**：低；需要先决定哪些产物入版本库。
- **优先级**：**P1**。

**P1-4 用 M16（纯降低 + 角色推断）重构插件/工具契约**
- **问题**：dsh 的 `core/tools/src/{schema,json-schema,presentation}.ts` 与 `core/system-prompt` 的 `assemble` waterfall 是「声明式工具定义 → 呈现/schema」的链路。
- **做法**：套 M16 ——（a）用**判别字段推断角色**而不是显式 tag，并拒绝矛盾声明；（b）把函数式谓词换成**闭代数**（`recompile: crosses(v)` 那种），以获得可序列化、可生成文档、行为集有界可穷举测试；（c）内容指纹穿过降低层。
- **特别相关**：dsh 有 `pnpm duplication`（jscpd）—— shaders 的 scaffold 模式（把重复决策上移到工厂，`pointwiseFilter.ts:1-33`）是比「检测重复」更前置的解法。
- **收益**：工具定义的行为集变得可穷举，prompt cache 影响面变得可静态分析（与 P0-2 协同）。
- **成本/风险**：中高；会影响 `core/tools` 与 `core/system-prompt` 两个契约面。
- **优先级**：**P1**。

**P1-5 docs manifest + llms.txt + 覆盖率棘轮（M8）**
- **问题**：dsh 有 `docs/`（77 项）、`~80` 个 `verify-*` 脚本、大量插件卡片；文档面与 AI 面（若存在）大概率是多份手工维护。
- **做法**：（a）建一个 `docs-manifest.json`，来源优先级 = TS 编译器 API 读签名 → 注释标签（`@example`/`@tip`/`@see`/`@category`）→ 按类别的策展 markdown；（b）从它渲染站点 / `llms.txt` / 每类别 markdown / agent skill；（c）**策展拼错就硬失败**；（d）覆盖率棘轮 `UNDOCUMENTED_BASELINE`。
- **收益**：文档漂移变成单调数值门禁；agent 面从同一真源渲染。
- **成本/风险**：中高（`docsManifest.ts` 是 1047 行）；建议先只做「插件目录 + 工具清单」一个域。
- **优先级**：**P1**（限缩范围的话可以是 P0）。

**P2-6 分层失效作用域（M6）与两阶段绑定（M13.2）**
- dsh 的 `jobs/jobs-local/src/{ring,pump,events}.ts` 有界 ring + 头部驱逐，与 shaders 的 LRU + dispose 同构；`session-query-sqlite` 的投影与 `session-persistence` 之间有派生关系。
- **做法**：（a）把「从资源身份派生的缓存句柄必须被重建该资源的同一事件失效」（M5/M6 的不变式）写成 dsh 的一条显式不变量，并配测试；（b）对 SQLite 投影/索引，套 M13.2 的「声明依赖 → 依赖可用后解析」（增量索引构建先声明再解析）。
- **优先级**：**P2**。

---

### 4.3 los

**关键判断**：los 有 46 个 ADR、~50 个治理文档、330 个测试、真实的测量管道（cgroup 采样器、CI metrics JSONL、FTS 的 EXPLAIN 门禁、provider 遥测审计）。它**缺的不是治理，而是把治理机械化的模式**。同时 los 已文档化的瓶颈是 **CI/构建墙钟**，不是运行时 —— 所以建议里要明确区分这两条线。

**CI/构建线（针对已文档化瓶颈）**

**P0-1 turbo 任务声明收紧 + 生成物无 diff 门禁（M7 + M2 的「键必须声明」思想）** ★
- **问题**：`docs/governance/2026-08-16-ci-observability-and-bottleneck-review.md` 记录：gate-test 4.2–5.4 min（Forgejo）vs 164–186 s（GitHub），77% 在 Test root workspace；gate-fast 2.7–4.2 min 中**序列化 turbo typecheck ~100 s**；40 次运行 38% run-level 失败；根因包括「Forgejo 上没有 turbo cache」与「gate-test 里有一段序列化的 packages-test」。
- **shaders 的做法**（`turbo.json`）：每个任务**精确声明** `dependsOn` / `outputs` / **`env: []`** / `cache: true` / `outputLogs: "errors-only"`。**`env: []` 是这里最值钱的一行** —— 声明「这个任务的输出不依赖任何环境变量」，缓存命中的可靠性才成立。再配 CI 里的 `restore-keys` 前缀回退（`.github/workflows/test.yml:34-40`）。
- **落点**：`turbo.json`、`tools/ci-gate.sh`、`.forgejo/workflows/`。
- **做法**：（a）为每个 turbo 任务显式声明 `env`（把「未声明 = 一律 miss」变成「声明为空 = 可缓存」）与 `inputs`；（b）在 Forgejo CI 上启用 turbo 本地/远端缓存并挂载持久目录（根因直指这一点）；（c）把 gate-test 里那段序列化 packages-test 拆成可并行的分片，或至少移到 typecheck 之后独立阶段；（d）加「build 之后 `git diff --quiet`」门禁，让 `contracts/ → 生成类型` 链的漏提交在 CI 就死掉（直接服务 AGENTS.md 的 "Contract first" 不变式）。
- **收益**：这条是 los 唯一有量化根因的瓶颈，且 shaders 用的就是 turbo（同一工具、同一配置文件），迁移成本最低。
- **成本/风险**：低—中。风险是声明错 `env` 会导致**错误的缓存命中**（比 miss 更糟），所以要用 M1 的差分测试验证缓存键。
- **优先级**：**P0**。

**P0-2 把 AP11 的「prompt cache 影响评估」机械化（M1）** ★
- **问题**：AGENTS.md 的 AP11 要求「system prompt 变更、工具定义变更、上下文窗口策略变更必须通过 code-first 确定性门禁：prompt cache 影响评估、聚焦 harness 回归测试、版本号提升」。其中「影响评估」目前是**人工评审**（`docs/governance/code-first-determinism.md`）。
- **做法**：把 shaders 的 `compileTimeHashCoverage.test.ts` 三段式直接照搬 ——（a）把「进入 prompt 前缀的所有输入」枚举出来（system prompt 片段、工具 schema、模型参数、上下文切点、压缩器版本…）作为真理源；（b）对每一项做「改它 → 前缀哈希必须变」的正向断言；（c）对不该影响前缀的项做「不改 → 哈希必须不变且不得重编」的反向断言；（d）自覆盖交叉校验。然后把 AP11 的措辞从「做影响评估」改成「跑这个测试」。
- **落点**：`docs/governance/code-first-determinism.md`（措辞）+ 新增测试（建议放在 `packages/agent/src/` 或独立的 `tools/` 测试）。
- **收益**：AP11 从「评审承诺」变成「CI 门禁」；同时消灭「改了 system prompt 导致缓存全线失效但没人发现」的成本事故。
- **成本/风险**：中；需要先产出「前缀输入枚举」这份清单（这本身就是治理资产）。
- **优先级**：**P0**。

**运行时线**

**P1-3 上下文压缩链：可交换律 + 保守谓词 + 预算 + 保底回退（M4）** ★最有创意的迁移
- **问题**：`packages/agent/src/loop/compression.ts` + `loop/message-builder.ts` + `packages/memory/src/core/compaction.ts`（624 行）+ `semantic-eviction.ts` 构成一串**对历史消息的变换**（裁剪 → 摘要 → 截断 → 重排）。当前这串变换是怎么组合的，是否有「合并成一次遍历」的优化空间，需要核实；但它天然是 shaders 那个「一串可交换变换」的形状。
- **做法**：把压缩链表达成一个**变换计划**，然后套 M4 的骨架：（a）写出哪些变换**与其它变换可交换**（例如纯删除类操作彼此可交换）；（b）用**纯静态谓词**判定一个子序列是否可融合成一个 pass（谓词必须无副作用 —— 这条在 shaders 里是硬约束，因为部分合成会留下已注册的副作用）；（c）给融合**预算上限**（防止病态会话产生巨大计划）；（d）**永远保留未融合的回退路径**；（e）用**结构性断言**测试（断言融合后 pass 数减少、断言否定清单里的形状必须回退），而不是端到端 LLM 质量 —— 这正是 M10 的「测试编译器而不是执行基质」。
- **收益**：token 与延迟双降；而且测试**不需要真 LLM**（这是 M10 的核心价值：把昂贵的测试变成廉价的结构断言）。
- **成本/风险**：中高；最大的风险是「可交换」的证明不成立 —— 如果写不出那条定律，就不要做融合（见 M4 边界）。
- **优先级**：**P1**。

**P1-4 缓存键覆盖 + 反向不变式（M1/M2）**
- **落点**：`packages/memory/src/core/retrieval.ts`、`packages/agent/src/providers/{registry,model-routing,provider-health}.ts`、`packages/agent/src/loop/token-utils.ts`。
- **做法**：（a）对 memory 检索缓存，键应来自「查询的结构指纹 + 索引版本 + 过滤条件」的声明式枚举（shaders 的 `structuralHash`，`pipelineCache.ts:24-34`），并按 M2 加活跃钉住与 dispose；（b）对 provider/model 路由决策，缓存键 = (provider, model, capability, health tier) 的结构哈希 + LRU；（c）los 已有 `fts-performance.test.ts` 用 EXPLAIN 断言索引名与 100/200/500 ms 预算 —— **这是同类门禁里质量最高的一条**，把它的形状推广到上面两处。
- **特别提示**：los 的 `memory/src/fts-performance.test.ts` 已经是「预算 + 结构化断言（索引名）」的成熟形态，值得作为 los 内部推广的模板，也是本报告给其他项目的推荐范例。
- **优先级**：**P1**。

**P1-5 失效作用域分级的不变式（M6）**
- **问题**：`packages/infra/src/db.ts`（pg Pool）+ `migrate.ts`（启动时 `migrateDir()`）；`session-recovery.ts` / `stream-checkpoints.ts` / `kernel-event-projection.ts` 之间有派生关系。
- **做法**：把 shaders 那条教训写成 los 的不变式并配测试：**「任何从资源身份派生的缓存句柄（连接、预处理语句、prepare 计划、纹理/缓冲区句柄），必须被重建该资源的同一事件失效。」** shaders 为此付了「整个命令缓冲被丢弃 → 画面全黑」的代价（`passManager.ts:399-435`）。在 los 里对应的是「schema 迁移后陈旧的 prepared statement / 连接」。
- **优先级**：**P1**。

**P1-6 docs manifest + skill 目录（M8，限缩范围）**
- los 有 `docs/adr/`（46 篇）+ `docs/governance/`（~50 篇）+ 本 `docs/research/`；以及一个对 agent 暴露的技能目录。建议先只做一个域（例如「治理文档索引」或「CLI/API 参考」），产出 `docs-manifest.json` + `llms.txt` + 覆盖率棘轮。
- **优先级**：**P1**（限缩范围可 P0）。

**P2-7 用 Gate A/B/C 治理「行为不该变」的大改动（M9）**
- los 有 `check-*` 门禁但缺「变更按等价强度分类」。对 session event 格式迁移（ADR 0002/0015）、事件投影重构、工具定义重构，套 Gate A（字节/记录等价）/ Gate B（论证等价）/ Gate C（行为变更需签核 + changelog）会显著降低回归面。配套那条 **「浮点/数值重排不是免费的」** 陷阱在 los 的 token 计数与成本核算里同样成立。
- **优先级**：**P2**。

**P2-8 用 PRIMITIVES.md 的形态替代 46 篇 ADR 的检索成本（M11.3）**
- 观察：los 的治理资产是**按时间/决策分散**的（46 ADR + ~50 governance 文档），而 shaders 是**按规则编号聚合**的（C1–C9 + D-1/D-2/D-6 + 「实现中学到的」+ 每个类别的显式异类清单）。shaders 用一份 477 行的文件覆盖了「规则、已解决约定、踩过的坑、退出路径」。建议 los 增加一份 `docs/governance/conventions.md`：编号规则 + 已解决约定 + 实现中学到的 + 显式异类清单，并**显式区分维护者文档与使用者文档**（`PRIMITIVES.md:3-7` 的做法）。
- **收益**：agent 与人的检索成本从「读 46 篇 ADR」降到「读一份规则册 + 按需跳转」。
- **优先级**：**P2**（但一旦做了，对所有后续工作都有复利）。

---

### 4.4 cantool

**P0-1 `search.rs` 复用 `mixer.rs` 已有的线程局部 matcher + 结果缓存（M2 的直接套用）** ★
- **问题**：`src-tauri/src/command_system/mixer.rs:15-31` 已有 thread-local `SkimMatcherV2`，`:40-44` 已有按 `(text, filters, limit, source-id signature)` 的结果缓存，`:164-178` 已有「安全超集」预过滤以躲开 `fuzzy_indices` 的主要开销。但 `src-tauri/src/command_system/search.rs:26`（以及 `:135`）**每次调用新建 `SkimMatcherV2::default()`**。
- **做法**：把 matcher 与结果缓存抽成一个共享的 `SearchContext`（或直接复用 mixer 的 thread-local），让 `search.rs` 走同一条路径。**这是本报告里成本最低、收益最直接的一条建议。**
- **额外收益**：一旦共享，`(text, filters, limit, source-id signature)` 这个**键就是声明式枚举的失效触发集**（M2）；可以顺手按 M1 加一个测试：改动键里的任意一项必须改变结果，改动不相关项必须不改变。
- **收益**：每次击键省掉 matcher 构造；按 shaders 的 `structuralHash` 思路，键的完备性还可被测试钉住。
- **成本/风险**：低。
- **优先级**：**P0**。

**P0-2 拆分 `cantool_lib` 单 crate（M11.1 facade 边界 + M16 降低层）** ★
- **问题**：`TODO.md:2623` —— 「338 Rust 文件全在 `cantool_lib`，改一行重编整个 crate」。这是 cantool 已文档化的构建时间瓶颈，也是 `target/` 11,012 MB（含 4,669 MB incremental）的来源之一。
- **shaders 的答案**：**facade 边界 + 一条 lint 规则强制它**。`eslint.config.mjs` 整个文件只有一个目的：禁止 `src/**` 里 import `typegpu`，唯一豁免是 `src/gpu/**`。等价做法在 Rust 里是：（a）把 `cantool_lib` 拆成若干 facade crate（`crates/cantool-file-index`、`crates/cantool-device-jobs` 已是先例）；（b）用 `cargo tree`/`cargo-deny` 或一个自定义 `check-*.sh` 断言「`cantool-core` 不得依赖 `cantool-surface-*`」这类方向约束；（c）把边界规则写成**可机检的一条规则**，而不是文档里的一段话。
- **补充**：cantool 已有 **15 个 `docs/governance/tasks/*optimization*` 目录**与 `OPTIMIZATION_TASKS.md`，但 shaders 的经验是**规则要能机检**（单规则 lint）而不只是被记录。
- **收益**：改一行的重编半径从「整个 crate」降到「一个 crate」；`target/` 增量目录随之下降。参照 rustopt 对 `verify-gate` 的实测：`[profile.dev.package."*"] debug = 0` + `strip = "none"` 带来 −40% dev target 磁盘、−12% 冷启动墙钟 —— 但那是**常数级**优化，**crate 粒度是结构级优化**，杠杆更大。
- **成本/风险**：高（跨 crate 重构），但可增量进行：先把最独立、最底层的模块（已有 `cantool-file-index`、`cantool-device-jobs` 模式）继续外提，每提一个就加一条边界断言。
- **优先级**：**P0**（作为立项；单次改动则是 P1）。

**P1-3 把尺寸测量绑定到「实际交付的产物身份」（M3 的 markReady/activeHash 纪律）** ★
- **问题**：`scripts/size-gate.sh:19-27` 与 `TODO.md:24` 记录：rustopt advisory 报告 30,867,280 B，而实际交付的二进制是 29,424,720 B，**差 1.44 MB，原因未结**。cantool 目前用「强制交叉校验真实产物」来绕过。
- **shaders 的答案**：`pipelineCache` 的 `markReady(hash)` 只在**新的那个**成功画出第一帧后才提升为 active；`activeHash` 明确标识「当前在被渲染的那一个」。等价纪律是：**测量必须绑定到将要交付的那个产物的身份**，而不是「同名但由另一个 profile 产生的产物」。
- **做法**：（a）让尺寸门禁记录产物的 `(sha256, length, profile, manifest_hash)` 四元组，并断言「被测产物 == 将要交付的产物」；（b）在 rustopt 侧修根因（见 4.7 的 P0-1）；（c）cantool 侧的交叉校验保留，但升级为**硬失败**而不是「绕过」。
- **收益**：尺寸门禁从「两个数字对不上就人工排查」变成「对不上就说明测错了对象」的确定性判据。
- **成本/风险**：低—中。
- **优先级**：**P1**。

**P1-4 插件宿主：把「热 worker + 合并提交」套到 `plugin_host`（M5 + M13）**
- **问题**：`src-tauri/src/plugin_host/worker.rs`（2,958 行）+ `supervisor.rs`（2,641 行，rquickjs）；TODO 里有「plugin host tool-call latency −40%」的目标阶段。
- **shaders 的答案**：（a）**进程/句柄单例 + 缓存承载**（`root.ts:5-25`：一个页面一个 device，因为它拥有编译流水线缓存；per-renderer device 会导致每次路由切换重编译全部 shader）—— 对应的正是「isolate 应当复用而不是每次新建」；（b）**dirty 合并**（`uniformStore.ts:879-912`）—— 对应「一帧/一次交互内的多次 tool call 合并成一次跨进程往返」；（c）**两阶段绑定**（`lateBoundChild.ts:70-89`）—— 对应「isolate 还没起来时先声明依赖，起来后再解析」。
- **优先级**：**P1**。

**P1-5 数据库/索引：把 los 的 EXPLAIN 门禁形状搬过来（M1 + M10）**
- **问题**：33 个 SQL 迁移 + `docs/development/database-index-optimization.md` + clipboard 仓库 1,521 行。cantool 的 `scripts/search-eval.sh` / `examples/search_eval.rs` 已经是评估装置。
- **做法**：参考 los 的 `memory/src/fts-performance.test.ts`（在多规模下用 EXPLAIN 断言**计划形状与索引名**，并带 100/200/500 ms 预算），把 cantool 的索引优化从「文档 + 一次性评估」升级为「每次 PR 都跑的形状断言」。这是 los → cantool 的横向迁移，而 los 的那个测试本身就是 shaders「结构化断言而非端到端指标」思想的应用。
- **优先级**：**P1**。

**P2-6 O(n²) 类问题的系统化扫描（M10 的「跨产物一致性扫描」思想）**
- cantool 的 TODO 里有一串已修但非常典型的项：per-keystroke regex 重编译（`TODO.md:3479`）、clipboard `trim_to_max_size` O(n²)（`:2904`）、calculator `is_function_at` O(n²)（`:3159`）、20 Hz `mouseLocation` 轮询（`:235`）、resize 期间 1.3–1.5 s JS 主线程阻塞（`:624`）。
- shaders 的 `enumPropSweep.test.ts` 的价值不在它测什么，而在**它把一类 bug 变成对全量代码的机械扫描**。建议为「热路径里出现 `new RegExp` / 循环内重编译 / 重复构造」写一个类似的扫描门禁（基于 `hotpath-0.28` 的 function-level probe 输出或简单的 AST 规则）。
- **优先级**：**P2**。

---

### 4.5 cankey

**判断**：cankey 是七个项目里**性能纪律最接近 shaders 的**（热路径 p95 < 8 ms 预算、`check-hotpath-no-io.sh` fail-closed 门禁、bounded lexicon 把 p95 从 37.18 ms 打到 56 µs、明确记录「测量后拒绝」的清单）。所以给它的大多是**精化**而不是**新概念**。

**P0-1 首次学习：从「复制整份 user HashMap」改为「稀疏 patch + 写时复制」（M5 + M13）** ★
- **问题**：`docs/design/bounded-lexicon-query.md` 记录 —— 首次学习复制基准（100k 行）为 p50 **3.718 ms**、p95 **4.763 ms**；「它低于 8 ms 热路径预算，但**单次学习会复制完整 user HashMap**」。在 8 ms 预算下，4.763 ms 的一次全量复制是危险的余量消耗。
- **shaders 的答案**：`uniformStore` 从来不复制整份缓冲 —— 写入落进 `dirtyScalars: Set` / `dirtyArrays: Map<handle, Set<index>>`，一次 flush 只发送**稀疏 patch**；`writeAll()` 是显式标注的全量回退路径（`uniformStore.ts:642-663,879-912`）。并且注释特别提醒：**在宣称「稀疏」之前先确知序列化器的真实更新粒度**（`:502-524`）。
- **做法**：（a）学习路径只计算**增量的词条**并写入，而不是 `clone()` 整份 `HashMap`；（b）把 `PreparedUser` 改成 `Arc` + 写时复制（cankey 已在别处用了 `Arc` — reconnaissance 记录 `PreparedUser shared Arc`），于是「未修改的读者」永不阻塞；（c）明确区分「稀疏增量提交」与「全量重建」两条路径，并让日志/诊断能区分它们（否则无法知道回退路径被触发得多频繁）。
- **收益**：把首次学习的 p95 从 4.763 ms 降到亚毫秒级，直接给热路径预算腾出余量。
- **成本/风险**：中；写时复制在多线程下需要小心 `Arc::make_mut` 的语义。
- **优先级**：**P0**。

**P0-2 用 `composedNodeIds` 式的「声明 vs 实际消费」不变式治理漏斗（M17 + M12 的失败分类）** ★
- **问题**：`docs/plan/funnel-attribution-2026-09-29.md` —— 501 次真机失败中 **61.1% 是「候选列表里根本没有答案」**，只有 16.6% 是纯排序问题。也就是说**继续调排序的 ROI 很低**，问题在更前面。
- **shaders 的答案**：`composer.ts:390` 维护一个 `composedNodeIds` 集合并在 `:1536` 返回；渲染器用它判断「这一帧是否完整」（`gpu/index.ts:1549`）。**核心不变式是：被声明的东西必须真的被执行到，否则这是一个可检测的状态，而不是一个静默的差异。**
- **做法**：（a）为候选生成的每个阶段（词库命中 → 分区扫描 → lattice 构建 → Viterbi 打分 → beam 截断 → 候选窗口渲染）维护结构化的**阶段计数器**；（b）断言「进入阶段的条目数 == 离开阶段的条目数 + 被该阶段显式淘汰的条目数」，差额必须为 0，否则是一个可检测的 bug 而不是「效果不好」；（c）把 61.1% 的「列表里没有答案」拆进这些阶段，定位到底是词库覆盖、还是 lattice 剪枝、还是 beam 太窄（reconnaissance 已记录「4× 打分精度、窗口 8/16/24、beam 扩展、bigram 重标定」都已被测量后拒绝 —— 这正说明缺的是**阶段归因**而不是更多调参）。
- **收益**：把一个「ROI 已被证明很低」的调参方向，换成有归因的阶段修复方向。
- **成本/风险**：中；需要一次真机数据采集（cankey 已有 `mixed-harness.py`、`paired-significance.py` 等装置）。
- **优先级**：**P0**。

**P1-3 缓存/索引失效的键覆盖率门禁（M1）**
- **落点**：`crates/cankey-config/src/lexicon.rs`（1,909 行）、`crates/cankey-core/src/pinyin.rs`（2,664 行）、`query.rs`。
- **做法**：cankey 有 `subscribed.tsv` 上限（100k 行 / 8 MiB）、`EVENTS_CAP = 4096`、`TAIL_BYTES_CAP = 1 MiB` 等硬上限，也有 `docs/design/decisions/` 的决策收据。补一条：对词库/用户态/配置的**每一条**影响查询结果的输入，断言「改它 → 缓存/索引键必须变」；反向断言「不改 → 键必须不变」。这直接防止「导入新词库后没生效」这类最难查的 bug。
- **优先级**：**P1**。

**P1-4 把 Gate A/B/C 用于排序/打分改动（M9 + 那条浮点陷阱）**
- **问题**：cankey 的 `docs/design/decisions/` 已经记录了「测量后拒绝」的候选（4× 打分精度、窗口扩展、beam 扩展、bigram 重标定），但拒绝的理由是否结构化？
- **做法**：借用 Gate 分类 —— 打分函数的重构属于 **Gate B**（必须论证等价，且**浮点重排不是免费的**：`PRIMITIVES.md:120-131` 明确警告表达式的重新结合会改变加法/乘法顺序）；权重重标定属于 **Gate C**（必须逐项真机签核 + 记入变更日志）。并要求**改名提交与逻辑提交分开**（因为 shaders 的教训是名字会进产物与快照 —— cankey 对应的是诊断 JSONL 与 harness 输出里的字段名）。
- **收益**：把「拒绝清单」从结论升级为**可复核的判据**。
- **优先级**：**P1**。

**P2-5 补 criterion benches（M10 的「测试编译器而非基质」）**
- **问题**：reconnaissance 明确记录 cankey **没有 criterion / benches**，性能靠 `cankey-cli typing` 的 p95 门 + 进程内 `imk::perf` 采样器（256 样本环形，写 `~/Library/Logs/CanKey/diag-*.jsonl`）。
- **做法**：shaders 的 `analyticPushdown.test.ts` 展示了一个更廉价的选择：**不需要端到端基准，只需要结构断言**。对 cankey 的 lattice/Viterbi/分区扫描，可以写「这个输入下分区读取的条目数必须 ≤ 3K」「beam 后的候选数必须 ≤ 24」这类**结构性上界断言**，比 p95 基准更早、更稳地捕获退化（p95 受机器噪声影响，结构性上界不受）。cankey 自己有「剩余 20.992 ms 尖峰」的未解项 —— 结构性断言比 p95 更能定位这类尖峰属于哪一段。
- **优先级**：**P2**。

---

### 4.6 lot2extension

**判断**：lot2extension 是七个项目里**机械门禁最多**（~35 个脚本）但**结构性不变式最少**的。它最需要的恰好是 shaders 的「让非法状态不可表示」。

**P0-1 过滤规则匹配：编译一次 + 结构哈希缓存 + 别针活跃态（M2 + M7 的流水线化）** ★
- **问题**：`docs/FILTER_LIST_MATCHING_OPTIMIZATION.md` 自述 —— 「Hot-path matching that does linear scan + `new RegExp` per rule per request does not scale.」目标流水线（解析 → 规范化 → 指纹去重 → 值序上限 → 编译 host 索引 → `Match O(host labels + small candidates)`，优先用 DNR）其实**已经在文档里设计好了**，缺的是「缓存的键与失效」这一环。
- **shaders 的答案**：`pipelineCache.ts:1-16` 的头部注释就是一份可直接照抄的设计说明 —— **缓存键来自「枚举出来的、写在代码里的重编译触发集」**（component/id/blend/mask/order/visible/opacity-bucket/transform/bbox/requiresRTT/compileTime props/colorSpace/toneMapping），而不是比较对象身份；FNV-1a 摘要 + 长度消歧；LRU 但**永不驱逐活跃与在途**；驱逐时调用 dispose 释放独占资源。
- **做法**：（a）规则集变更时算一个 `ruleSetRevision`（结构哈希，枚举全部影响编译结果的字段）；（b）编译产物（host 索引 + 编译后的候选集）缓存在该 revision 下；（c）LRU 容量按「用户实际有几个 profile」推导，不是拍脑袋常数；（d）**把活跃规则集钉住不驱逐**（shaders 的 `evictIfNeeded` 注释直说了：它是工作集，不是纯缓存）；（e）加 M1 的键覆盖测试。
- **收益**：从「每次请求每规则一次线性扫描 + new RegExp」变成「O(host labels + 小候选集)」，且规则集不变时零编译。
- **成本/风险**：中；DNR 的规则上限是外部约束，索引编译要遵守。
- **优先级**：**P0**。

**P0-2 消灭「声明了但没有消费者」的孤儿队列 —— 启动期 fail-closed（M17 的声明 vs 执行不变式）** ★
- **问题**：`TODO.md:118` —— 默认部署下 **page-snapshot 队列没有消费者**（inline worker 只在 `cfg.AI.Provider == ""` 时启动，默认 `openai`；`cmd/ai-worker` 自述 DEPRECATED），而这与 `check-consistency.sh` 强制的 `page-snapshot-summary-worker` 政策**直接冲突**。这是一个「配置声明了 A，运行时却做 B」的静默不一致。
- **shaders 的答案**：两层。（a）**构造期**：`composer` 维护 `composedNodeIds`，渲染器据此判断这一帧是否完整（`composer.ts:390,1536` → `gpu/index.ts:1549`）。（b）**启动期 fail-closed**：`support.ts:204-247` 的页面级闩锁 —— 属于「页面事实」的失败会闩锁，后续渲染器直接采纳结论，避免「一个特效没加载」升级为「标签页卡死」；而 `root.ts:142-166` 的 `acquireRoot` 把「已丢失的注入 device」永久排除（因为对尸体做 GPU 调用是静默 no-op，会导致永久白屏）。
- **做法**：（a）启动时做一次**拓扑自检**：对每个声明的队列/worker，断言「存在且已注册的消费者数量 ≥ 1」，否则启动失败并打印「谁声明了它、谁本该消费它、当前配置为什么没启动消费者」；（b）`check-consistency.sh` 从「检查名字存在」升级为「检查消费者确实会被启动」；（c）把这类检查写成一条可机检规则（M11.1 的单规则思路），而不是散落在多个脚本里。
- **收益**：把一个 P1 级阻塞项从「需要人读文档才能发现」变成「启动就报错」。
- **成本/风险**：低—中；难点是枚举「声明」的来源（配置项 + worker 注册表 + 脚本政策）。
- **优先级**：**P0**。

**P0-3 请求队列：把「生产者-消费者之间的显式 flush 点」与「单写者」正式化（M5 + M13.4）**
- **问题**：`extension/utils/request-queue.ts`（764 行）刻意做成 **SW 内单写者**（其它上下文通过 runtime message 转发），以避免双消费；DLQ 分类 `retryable`/`unrecoverable`/`max_attempts`，重放带新 id。设计已经很好。
- **shaders 的补充**：（a）`passManager.ts:364-382` 的教训 —— **生产者与消费者之间需要显式的 flush 点**（计算节点在收集阶段写了 uniform，若不在计算后、pass 前再 flush 一次，消费者会用到上一帧的参数，产生一帧的错误值）。对应到队列：入队与出队的批次之间需要一个**显式的、可断言顺序的提交点**，而不是依赖两侧各自 flush。（b）`compute.ts:101-133` 的设计 —— 混合步骤列表里，**内联 thunk 是隐式的顺序屏障**（因为底层队列保证 FIFO），并且**明确把「批处理编码器」作为可分离的后续优化记录下来，而不是顺手实现**。这个「先保序、后优化吞吐」的分层态度值得照抄。
- **做法**：把 DLQ 分类与重放语义写成**结构性不变式测试**（例如：任意 `retryable` 项重放后必须不重复消费；`max_attempts` 耗尽后必须只进 DLQ 一次），而不是只靠集成测试。
- **优先级**：**P0**（若按「不变式测试」范围做，成本很低）。

**P1-4 跨产物一致性扫描（M10 的 enumPropSweep 模式）** ★
- **问题**：`docs/SYSTEM_OPTIMIZATION_PLAN.md` P0-3 记录 —— `ruleMatching.ts` 的 `content_type` bug 读了一个**不存在的 `metadata.n`**，于是**永不匹配**。这是一个完美命中 shaders `enumPropSweep.test.ts` 所描述 bug 类的例子：**类型系统看不见、单测也看不见、只在对全量源码做机械扫描时才暴露**。
- **做法**：照搬那个扫描的结构 —— 对每个规则/适配器，若它在源码里读了某个字段路径，断言该路径在对应的类型/契约里**确实存在**（先剥注释，防止参考注释造成假阴性 —— `enumPropSweep.test.ts:31-33` 的理由）。lot2extension 有 ~35 个门禁脚本，这条应该成为第 36 个。
- **收益**：一次性消灭一整类「读了不存在的字段 → 静默不生效」的 bug。
- **成本/风险**：低—中；需要能解析字段访问（AST 或正则 + 类型/契约 schema 对照）。
- **优先级**：**P1**。

**P1-5 自覆盖交叉校验（M1 的第三段）**
- **问题**：lot2extension 的门禁脚本很多（`check:consistency`、`module:report`、`release:preflight`），reconnaissance 也记录了「4 个测试只有 `t.Log` 没有断言」这类**门禁自身失效**的问题。
- **shaders 的答案**：`compileTimeHashCoverage.test.ts:228-233` 断言「实际遍历到的 prop 数 == 从注册表推导出的 prop 数」—— **门禁自己也要被门禁检查**，一个被静默跳过的条目仍会让测试失败。
- **做法**：为每个扫描型门禁加一条自覆盖断言（「我扫到的条目数必须等于真源里的条目数」）。这对 `check-consistency.sh`、`module:report`、一致性扫描尤其重要。
- **收益**：把「门禁存在但已失效」这个最隐蔽的失效模式变成可检测的。
- **成本/风险**：低。
- **优先级**：**P1**。

**P2-6 生成物提交门禁（M7.3）**
- lot2extension 有 `write-extension-build-identity`、`patch-options-manifest` 等构建期生成步骤，也有 `artifacts/audit-*.json`。建议对**决定构建身份的产物**（build identity、options manifest）加「build 后无 diff」门禁，因为它们是「构建链身份一致性」的关键（这正是 `build-chain-identity-audit` 技能关注的问题域）。
- **优先级**：**P2**。

**P2-7 SSE/UI 侧：把 rAF 合并正式化为「每帧一次提交」（M5）**
- 已有 `requestAnimationFrame` 合并的 `repositionPanel`、`progressiveRevealText` 回退。建议把它们表述成 shaders 那种「dirty 集合 + 每 tick 一次提交」的显式形态，并加一条「一帧内提交次数 ≤ 1」的结构断言测试（廉价且能防止回归）。
- **优先级**：**P2**。

---

### 4.7 rustopt

**判断**：rustopt 是七个项目里**自审质量最高**的（`docs/SELF-OPTIMIZATION-REVIEW.md` 给出每条改动的实测 delta：guard 7.5×、measure 2.4×、preflight 1.82×，并承认自我优化让工具变大 +6.3%/+8.9% 是有数据支撑的欠债）。它需要的是 shaders 的**并行调度 + 有界化 + 测量口径绑定**。

**P0-1 修 `current` variant 的语义 —— 让测量绑定到「manifest 实际生效的 profile」（M3 的 activeHash/markReady 纪律 + M2 的显式键）** ★
- **问题**：这是本报告里**最具体的跨项目缺陷**。`cantool/scripts/size-gate.sh:19-27` 与 `cantool/TODO.md:24` 记录：rustopt advisory 报告 **30,867,280 B**，实际交付 **29,424,720 B**，差 **1.44 MB**，「cause is still open」。而 `rustopt` 自身已经修过一次同类问题（`check` 在产物由别的 profile 产生时仍测 `--release`，报 940,720 B 而实际交付 571,536 B → 加了 `--build-profile`）。现在的症状指向：**`current` variant 测的是 cargo 默认值，而不是 manifest 里的 `[profile.release]`**。
- **shaders 的答案**：`pipelineCache` 用 `activeHash` 明确标识「当前正在被渲染的那一个」，并且**只有在新的那个成功画出第一帧之后**才把 active 换成它（`markReady`，`pipelineCache.ts:104-143`、`frame.ts:248-284`）。等价纪律：**任何测量/门禁都必须绑定到「将要交付的那个产物的身份」，而不是一个同名但来源不同的产物。**
- **做法**：（a）`current` variant 必须**从 manifest 解析出实际生效的 `[profile.release]`**（而不是用 cargo 的内建默认）；（b）每次测量记录 `(artifact sha256, length, effective profile, manifest hash)` 四元组；（c）加一个**回归 fixture**：一个 `[profile.release]` 非默认的 fixture manifest，必须让 `current` 与 `default` 产生**不同**的结果 —— 当前如果 `current ≡ default` 就说明 bug 还在；（d）`check` 断言「被测产物 == 交付产物」。
- **收益**：消除一个已经跨项目传播了 1.44 MB 误差、并迫使下游加人工绕过的缺陷。这条同时让 rustopt 的核心判据（「必须能在没参与开发的仓上给出人想不到的结论」）重新成立。
- **成本/风险**：低—中（改 `variants.rs`/`measure.rs` + 一个 fixture）。
- **优先级**：**P0**。

**P0-2 variant 矩阵并行化（M6 的失效作用域 + M13 的独立资源池）** ★
- **问题**：`docs/SELF-OPTIMIZATION-REVIEW.md` 记录 variant 矩阵仍串行，**已实测 2.24× 头寸**（5 个 variant 冷启动 34.35 s → 15.36 s），但**被推迟**（理由是「gated on adding a `-j` cap」）。
- **shaders 的答案**：variant 之间是**完全独立的工作项**（各自有独立的 `CARGO_TARGET_DIR`，写在 `~/.cache/rustopt/work/<fnv(repo)>/<variant>`）。shaders 对应的是 `dispatcher.dispatch(steps)` 执行一个**有序的独立步骤列表**（`compute.ts:101-133`）：它保持总序但允许批处理；而且它**明确把批处理编码器记为「可分离的后续优化」**。迁移的形态是：variant 矩阵本身是 DAG 上的独立叶子，可以并行；但**必须有一个显式的并发上限**（这正是 shaders 的 `PUSHDOWN_MAX_NODES = 24` 那种「用显式预算封住搜索」的思路）—— 无界并行会把 cargo 的内存/IO 压垮。
- **做法**：（a）加 `-j <n>`（默认取 `min(variants, cores/2)` 或按可用内存推导）；（b）保持 `--locked` 与**每个 variant 独立 target dir** 的隔离（这是并行的前提，已经具备）；（c）把「串行 vs 并行」的结果一致性做成断言（同样的 variant 集合必须得到同样的 verdict，只有时间不同）；（d）把并发度变成 `runs.jsonl` 里的记录字段。
- **收益**：已实测 2.24×（34.35 s → 15.36 s 冷启动 / 5 variant）；对 CI 与本地迭代都直接生效。
- **成本/风险**：低—中；主要风险是资源争抢导致单 variant 变慢，因此需要 `-j` 默认值保守 + 可调。
- **优先级**：**P0**。

**P0-3 ledger/events：从 `2+2N` 次 open 改成一次合并追加 + 有界化（M5 + M2 的 dispose）** ★
- **问题**：`docs/SELF-OPTIMIZATION-REVIEW.md` §0 记录 —— `ledger.rs` + `events.rs` 每个 plan 有 **`2+2N` 次文件 open/close**；`runs.jsonl` **无界且无 prune**；读取时用 `Value` 重新解析。这是明确标注的 open item。
- **shaders 的答案**：两件事一次解决 ——（a）**dirty 合并**：`uniformStore.flush()` 把一帧内所有写入合并成**一次** `buffer.patch`（`uniformStore.ts:879-912`，注释：「Patches accumulate across a frame and flush once」）；（b）**有界 + dispose**：`pipelineCache` 的 LRU 有显式容量、**永不驱逐活跃项**、驱逐时调用 `dispose`（`pipelineCache.ts:78-102`）。
- **做法**：（a）ledger 文件在整个 plan 期间**只 open 一次**，事件写入内存缓冲，plan 结束时一次追加写（如果崩溃可见性是硬需求，则保留「每个事件一次 append」但改成**单个持久 fd + `write_all` 缓冲**，避免 open/close 系统调用）；（b）`runs.jsonl` 加保留策略（按时间 + 条数双上限，或按项目滚动），并在 prune 时保留「最近 N 条 + 每月一条摘要」；（c）读取改成流式反序列化（参考 measure.rs 已有的 `Value`→typed 改造，那里拿到了 2.4×）。
- **收益**：plan 的 IO syscall 次数从 `2+2N` 降到常数；无界增长被消除（这也是 `build-artifact-retention` 类治理关注的问题）。
- **成本/风险**：低；append-only 的语义要小心（rustopt 的记录是「append-only `runs.jsonl` 只存 `stderr_hash` + 长度」—— 保留这个性质，只改 IO 形态与保留策略）。
- **优先级**：**P0**。

**P1-4 把 Gate A/B/C 与 bail-out 用于 rustopt 自身（M9）**
- **问题**：rustopt 的 `docs/SELF-OPTIMIZATION-REVIEW.md` §12 承认自我优化让 dist 537,712 → **571,536 B（+6.3%）**、release 940,720 → **1,024,816 B（+8.9%）**，并作为「有数据支撑的欠债」接受。这个判断是对的，但**缺一个形式化的分级**。
- **做法**：采用 shaders 的三档 —— **Gate A**（字节等价重构：如 `guard.rs` 的三趟合一趟，如果输出完全一致）；**Gate B**（论证等价：函数重命名、声明重排 —— 注意 **rustopt 的性能守卫匹配的是源码文本，重命名会移动守卫结果**，这一点与 shaders「函数名会进生成的 WGSL」是同一个陷阱）；**Gate C**（行为/尺寸变化：需要签核 + 变更日志条目）。
- **配套**：shaders 的 **bail-out 规则**（`PRIMITIVES.md:140-146`：「如果 Gate A 迁移无法在合理工作量内达到字节等价，跳过该消费者并记录原因」）+ **显式异类清单**。rustopt 的 variant「permanent outliers」正好需要这个（例如某些 crate 对小尺寸优化不敏感，就应该被显式记为异类而不是被工具反复尝试）。
- **优先级**：**P1**。

**P1-5 守卫扫描：注释剥离要早于匹配 + 用测试钉住（M10 的 enumPropSweep 教训）**
- **问题**：rustopt 已经修过一次「off-by-one 让证据指向一个注释」（self-review 记录：「一个指着注释的 ban 比没有 ban 更糟」），现在的做法是「guards matched on code-only with path-segment needles」。
- **shaders 的做法**：`enumPropSweep.test.ts:31-33` **先剥注释再匹配**，并且注释里明确写了理由（「precisely so v1-reference comments can't produce false negatives」）。建议 rustopt 补一个 fixture：`tests/fixtures/` 里放一个**在注释里包含被禁 needle**的 crate，断言守卫**不**命中；再放一个在代码里包含该 needle 的，断言守卫**命中**。这是把「已经踩过的坑」变成不可回归的资产。
- **优先级**：**P1**。

**P1-6 设计文档的「拒绝清单」升级为带编号的约定（M11.3 / M16）**
- **问题**：rustopt 的 design doc §6 已有一份**拒绝清单**，每条带一行理由（无 target/ GC、无 what-if 估算器、无单态化去重、无二进制打包、无动态链接建议）。这是好实践。
- **shaders 的升级**：把它变成 **`PRIMITIVES.md` 式的编号约定 + 显式异类清单 + bail-out 规则**：每条拒绝写成 `D-n`（类似 shaders 的 `D-1`/`D-2`/`D-6`），并附「为什么不能用另一种做法」。shaders 的 `D-2`（两个亮度标准都保留，迁移时**采用该文件今天使用的权重**以保持 Gate A）是一个极好的范例：**拒绝统一化有时比统一化更正确**。
- **收益**：对新贡献者（与人/agent）来说，检索成本从「读完整个 design doc」降到「查 D-n 表」。
- **优先级**：**P1**。

**P2-7 打包内容门禁 + 3 OS 矩阵 + msrv 交叉校验 —— 已经很好，仅补一条（M7.3）**
- rustopt 已有：`docs/` 绝不进 `.crate` 的**打包内容门禁**、`msrv` job 交叉校验 `rust-version`、tag 触发的 3 目标 release 矩阵、`.crate` 从 126.1 → 41.2 KiB。这与 shaders 的「生成物必须提交」是同一类**产物内容断言**。
- **唯一补充**：shaders 的**幂等发布**（`release.yml:117-127`：如果 `npm view <pkg>@<version>` 能解析就跳过，避免发布后失败再跑时 409）。rustopt 的 release 矩阵如果会在「部分目标成功、部分失败」后重跑，就需要同等的幂等性。
- **优先级**：**P2**。

---

### 4.8 七个项目的横向优先级矩阵

| 机制 | ComfyUI | dsh | los | cantool | cankey | lot2 | rustopt |
|---|---|---|---|---|---|---|---|
| M1 缓存键覆盖差分门禁 | **P0** | **P0** | **P0**(AP11) | P1 | P1 | P1 | — |
| M2 结构哈希 + 钉住 + dispose | P1 | P1 | P1 | **P0** | P1 | **P0** | — |
| M3 swap-when-ready | P2 | — | P2 | — | — | **P0** | **P0**(测量口径) |
| M4 融合：谓词+预算+回退 | P2 | P1 | **P1** | — | — | — | — |
| M5 dirty 合并提交 | **P0** | P1 | P1 | P1 | **P0** | P0 | **P0** |
| M6 失效作用域分级 | P1 | P2 | P1 | P1 | — | P1 | **P0** |
| M7 生成物提交门禁 | — | P1 | **P0** | P2 | — | P2 | P2 |
| M8 docs manifest + 棘轮 | — | P1 | P1 | — | — | — | — |
| M9 Gate A/B/C + 异类清单 | P1 | P2 | P2 | — | P1 | — | P1 |
| M10 无基质测试 / 结构断言 | — | P1 | P1 | P1 | P2 | **P1** | P1 |
| M11 facade lint + 决策登记册 | — | P1 | P2 | **P0** | — | P1 | P1 |
| M12 预算遥测 + 失败分级 | P1 | — | P1 | P1 | P1 | P1 | — |
| M13 资源池 + 两阶段绑定 | P1 | P2 | P2 | P1 | P0 | P0 | — |
| M14 布局/ABI/确定性标识 | P2（量化/权重布局） | P1（session 格式的确定性序列化） | P2 | — | — | — | P1（守卫的路径段匹配） |
| M15 静止即不做 | P1 | — | — | P1 | — | — | — |
| M16 纯降低 + 角色推断 | — | P1 | — | P1 | — | — | — |
| M17 纯探针 + 从产物反推依赖 | P2 | P2 | P2 | — | — | **P0** | — |

（"—" = 未发现同构问题或收益不足以支撑成本。）

**统计**：P0 共 12 项，分布在 6 个项目中（rustopt 3、lot2extension 4、cankey 2、ComfyUI 2、dsh 2、los 2、cantool 2 —— 部分项跨项目计一次）。

---

## 5. 落地路线（30 / 60 / 90 天）与度量

### 第 1 阶段（0–30 天）：P0 单点，要求「一两个工作日内可验证」

| 项目 | 动作 | 验收判据（可度量） |
|---|---|---|
| rustopt | 修 `current` variant 语义 + 加非默认 profile fixture | fixture 下 `current != default`；cantool 的 1.44 MB 差消失 |
| rustopt | ledger 单 fd 单次写 + 保留策略 | plan 的 open/close 次数从 `2+2N` → 常数（可用 `dtruss`/自计） |
| rustopt | variant 并行 + `-j` | 5 variant 冷启动 ≤ 16 s（当前 34.35 s，实测空间 2.24×） |
| cantool | `search.rs` 复用 thread-local matcher + 结果缓存 | 每次击键不再构造 matcher；搜索 p95 下降 |
| cankey | 学习路径稀疏 patch + 写时复制 | 首次学习 p95 从 4.763 ms 降到 < 1.5 ms |
| lot2extension | 孤儿队列启动期 fail-closed | 默认配置启动即报「声明了但无消费者」 |
| ComfyUI | `/history` + `jobs` 版本戳 + 脏集合 | 队列统计延迟从 O(历史) 降到 O(变化量) |
| ComfyUI | 缓存键覆盖差分测试（先只覆盖 `IS_CHANGED` 与直接输入） | 每个 node class 的每个输入都有正/反断言 |
| los | turbo 任务显式 `env`/`inputs` + Forgejo 持久缓存目录 | gate-test 墙钟下降（当前 4.2–5.4 min） |
| los | AP11 影响评估 → 机器化差分测试 | AP11 checklist 里「影响评估」项改为「跑这个测试」 |
| dsh | `deepFreeze` 重复遍历修复（WeakSet 或结构性 revision） | backend continuation 自时间从 211.3 ms 显著下降 |
| dsh | 投影缓存 + prompt cache 键覆盖差分测试 | 每个影响前缀的字段都有正/反断言 |

### 第 2 阶段（30–60 天）：把一个机制变成一条可机检的不变式

- **建立「缓存键覆盖」测试模板并复用**：dsh（投影 + prompt）、los（memory/provider 路由）、ComfyUI（node 缓存）、cankey（词库/索引）、cantool（搜索）—— 同一套三段式结构（正向 / 反向 / 自覆盖交叉校验）。
- **建立「声明 vs 实际执行」不变式**：lot2extension（队列消费者）、ComfyUI（执行列表）、cankey（漏斗阶段计数）、dsh（job pump）。
- **建立「失效作用域分级」不变式**：任何从资源身份派生的缓存句柄必须被重建该资源的同一事件失效 —— los（迁移后的 prepared statement）、cantool（SQLite 索引）、lot2extension（SW 重启后的状态）。
- **建立 Gate A/B/C 分类**：rustopt（自身改动 + 守卫）、cankey（打分重构）、los（session event 格式迁移）、ComfyUI（采样/注意力核）。

### 第 3 阶段（60–90 天）：结构与治理

- **facade 边界机械化**：cantool 继续外提 crate + 加边界断言；dsh 为插件边界加单规则 lint（注意：shaders 的 lint 写好了但 CI 没跑 —— **不要重复这个错误**）。
- **docs manifest + 覆盖率棘轮**：先做 dsh（插件/工具目录）与 los（治理文档索引）各一个域。
- **决策登记册形态迁移**：los 从「46 ADR + ~50 governance 文档」补一份 `conventions.md`（编号规则 + 已解决约定 + 实现中学到的 + 显式异类清单）；rustopt 把 design doc 的拒绝清单编号化。
- **性能预算的产品化**：把 shaders 的 `performanceTracker` 形态（p99 / 预算占用 / 卡顿率 / 强度分）引入 lot2extension 的扩展侧与 ComfyUI 的作业侧。

### 全局度量（建议统一采集）

1. **缓存正确性**：键覆盖测试的「已覆盖输入数 / 真源输入数」= 100%（自覆盖交叉校验强制）。
2. **失效粒度**：单位时间内各级失效发生的次数分布（patch / 句柄 / 产物 / 全部）—— 重心应向左移。
3. **门禁有效性**：每个机械门禁都带自覆盖断言，且**故意注入一次失败**验证它真的会红（lot2extension 已有「4 个测试只有 `t.Log`」的教训）。
4. **构建/CI 墙钟**：按阶段分解（los 的 `ci-gate.sh` 已在写 `/tmp/los-gate-summary.json`）。
5. **人工绕过次数**：例如 cantool 对 rustopt 的交叉校验是「绕过」，目标是把绕过数降到 0（修根因而非加护栏）。

---

## 6. 不建议照搬的部分（反例清单）

明确区分「模式」与「shaders 的场景特有选择」。以下**不要**当普适经验抄：

1. **`maxSize = 4` 的 LRU 容量**（`pipelineCache.ts:36-40`）。它的理由是「用户编辑时来回切换」。跨项目必须重新推导容量，否则要么浪费内存要么抖动。
2. **4 个固定 bind group 的 ABI 划分**（`composer.ts:52-62` 的 `BIND_GROUPS = {uniforms:0, textures:1, samplers:2, external:3}`）。这是 WebGPU 特有的绑定模型，不是通用分层原则；通用原则是「把绑定面切成共享/不可变的一半与每项的一半」（M13.1），具体切几刀要按目标平台定。
3. **`swap-when-ready` 用在无用户可见连续性的场景**。rustopt 的 variant 矩阵不需要它；批处理任务需要的是并行调度（M6/M13）。
4. **266 个测试文件 / 214 个快照 / 2.2 MB 快照的测试规模**。这对有 199 个产物的库是合理的，对小项目是净负担。要抄的是**结构断言的形状**（M10），不是体量。
5. **`docsManifest.ts`（1047 行）+ `inject-jsdoc.ts`（299 行）+ 2348 行手工 catalog 的文档基建**。这是中大型项目的投入；小项目应先做覆盖率棘轮（一个常数 + 一条断言），再考虑全自动 manifest。
6. **`_pad*` 补结构体大小的 workaround**（`uniformStore.ts:795-844`）。这是 TypeGPU 部分写路径的具体缺陷驱动的。要抄的是**方法**（「遵守内存布局 ABI 时优先补大小而非对齐成员，且采用前先验证与序列化路径兼容」），不是那几行代码。
7. **把「没有 affected-only 构建」当优点**。shaders 的 `turbo.json` **没有** `test` 任务、没有 `--affected`，测试跑整个 core 包。对 shaders 规模可接受，对 los（已文档化 CI 瓶颈）恰恰是需要补的。**不要把 shaders 的「没做」当成「不需要做」。**
8. **lint 规则写了但不进 CI**（`eslint.config.mjs` vs `.github/`）。这是 shaders 的一个明确缺口，抄的时候要连反例一起抄。
9. **`GC`/内存压力驱动的驱逐**。shaders **没有**做（`NOT PRESENT` 清单）；它改为「uniform 总量事先封顶并拒绝」。ComfyUI 已经有了压力驱逐，**不要**反过来把 shaders 的「事先拒绝」当成替代。
10. **`Unhashable()` 式的静默降级**。这是反面模式，不是正面经验（`caching.py:50-65`）—— 一个不可哈希的输入应该**使缓存失效**或**明确拒绝缓存**，而不是返回一个恒定哨兵。
11. **用猜测的常数驱动资源调度**（ComfyUI 的 17 处 `memory_usage_factor`）。shaders 在 `PRIMITIVES.md` 里的做法（约定必须写下来 + 给出为什么不能用另一种 + 维护显式异类清单）才是解，猜测常数不是。
12. **`continue-on-error: true` 的性能测试**。ComfyUI 的 `test-unit.yml`/`test-execution.yml` 与时序断言默认跳过 —— 这让护栏形同虚设。shaders 的覆盖率阈值（functions 70 / lines 70 / branches 60）至少是**会阻断**的。

---

## 7. 证据强度与不确定性

### 高置信（直接读到源码，带行号）
- shaders 的全部 M1–M17 机制（第 2 节每条都有 `文件:行`）。
- 七个项目的栈、规模、构建/测试命令、已文档化的性能瓶颈与优化证据（来自只读勘察 + 各自的 README/AGENTS/design docs）。
- 三个具体缺陷的同构性：
  - ComfyUI `to_hashable` → `Unhashable()`（**两台实例均已核实**：M1 `comfy_execution/caching.py:50-65`、M3 `:51-55`；类内无 `__eq__`/`__hash__`）；
  - cantool `search.rs:26,135` 每次新建 matcher vs `mixer.rs:15-31,40-44` 已有缓存；
  - rustopt `current` 未读 manifest 的 `[profile.release]`（由 cantool 的 1.44 MB 差 + rustopt 已修过的同类 `--build-profile` bug 交叉印证）。

### 中置信（需在目标项目核实后才能下结论）
- **ComfyUI 的 `Unhashable` 是否真的导致过用户可见的陈旧缓存**：机制上成立，但没有找到对应的 issue/bug 记录。建议在实施 P0-1 时先写一个最小复现。
- **los 的上下文压缩链是否可融合**：M4 的迁移前提是存在一条可交换律。我没有逐行读 `compression.ts`/`compaction.ts` 的变换语义，**可交换性必须由 los 侧证明**；本报告只给出判定骨架与「证明不出来就不要做」的边界。
- **cankey 首次学习的 4.763 ms 是否真的来自 `HashMap` 全量复制**：来自 cankey 自己的 `bounded-lexicon-query.md` 描述（「单次学习会复制完整 user HashMap」），但我没有 profile 复核。
- **dsh `deepFreeze` 的修法选择**：三种方案（WeakSet / 结构性 revision / 写时复制）各有权衡，需要 dsh 侧结合 `buildRequest` 的实际调用形态定；profile 数据来自 dsh 自己的文档（132.876/211.300 ms 自时间）。

### 低置信 / 明确未核实
- shaders 的 `partner` 包与 `packages/shaders`（CLI/registry，2145 行）只做了结构级浏览，未逐行审阅；如果其中还有可迁移模式（例如 CLI 的项目探测 `cli/detect.ts`、锁文件 `cli/lockFile.ts`、preset 安装 `cli/presets.ts`），本报告未覆盖。**建议作为一个后续补充调研项。**
- shaders 未审阅的模块：`gpu/kit/*`（约 15,000 行着色器数学）、`src/shaders/**`（199 个特效）。这些是**图形语义相关**的，按第 1.1 节的判据本就不应作为通用模式来源，但如果目标项目要做 GPU 相关工作则是另一回事（七个项目中目前没有）。
- 各项目的**绝对性能收益**只能给出量级与判据，不能给出保证数字；唯一有实测数字的是 rustopt 的 variant 并行（2.24×）与 cankey 的 bounded lexicon（37.18 ms → 56 µs，已完成）。

---

## 8. 附：本文引用的关键证据索引

**shaders（`/Users/echerlos/syncfolder/project/shaders`）**

| 机制 | 文件:行 |
|---|---|
| 结构哈希 + LRU + swap-when-ready | `packages/core/src/gpu/pipelineCache.ts:1-16,24-40,49-76,78-102,104-143` |
| 结构性哈希输入枚举 | `packages/core/src/gpu/composer.ts:1668-1737` |
| 二级哈希 + 规范化投影规则 | `packages/core/src/gpu/index.ts:1369-1422` |
| 缓存键覆盖差分门禁 | `packages/core/src/__tests__/gpu/compileTimeHashCoverage.test.ts:8-29,104-140,142-215,228-233` |
| 融合：纯谓词 / 否定清单 / 预算 / 回退 | `packages/core/src/gpu/composer.ts:1129-1137,1170-1221,1189-1191,1243-1312,1372-1427` |
| 融合的结构断言测试 | `packages/core/src/__tests__/gpu/analyticPushdown.test.ts:157-179,172,211-243` |
| 点态 filter（零 pass 融合） | `packages/core/src/gpu/scaffolds/pointwiseFilter.ts:1-33,112-138` |
| dirty 合并 flush + 粒度匹配 | `packages/core/src/gpu/uniformStore.ts:502-524,642-663,879-912` |
| 生产者-消费者之间第二处 flush | `packages/core/src/gpu/passManager.ts:364-382` |
| 失效作用域分级 + resize 后 rebind | `packages/core/src/gpu/passManager.ts:41-43,328-343,399-435` |
| 资源池对账式清扫 | `packages/core/src/gpu/passManager.ts:148-174` |
| 两阶段延迟绑定 | `packages/core/src/gpu/scaffolds/lateBoundChild.ts:70-89`、`gpu/compute.ts:135-220,241-271` |
| 反馈模拟 scaffold | `packages/core/src/gpu/scaffolds/feedbackSim.ts:1-34,141-217` |
| 页面级单例 + 缓存承诺 | `packages/core/src/gpu/root.ts:5-25,87,142-166,181-205` |
| 失败原因机器可读 + 结构检测 | `packages/core/src/gpu/support.ts:18-73` |
| 按受众分级诊断 + 按键闩锁 | `packages/core/src/gpu/support.ts:79-143` |
| 页面级闩锁与爆炸半径分类 | `packages/core/src/gpu/support.ts:204-247` |
| 错误作用域隔离 + 粘性放弃 | `packages/core/src/gpu/index.ts:104,111,1441-1486,2416-2440,2466-2468` |
| 能力分层与保守 ABI | `packages/core/src/gpu/root.ts:41-48`、`gpu/composer.ts:399-406,1569-1578` |
| uniform 打包 / 补大小不补对齐 | `packages/core/src/gpu/uniformStore.ts:795-844,132-166,55-106` |
| 静止即不做 | `packages/core/src/std/sim/waves.ts:204-231`、`gpu/frame.ts:163-215` |
| 纯降低 + 角色推断 + 闭代数 | `packages/core/src/std/lower.ts:11-17,46-61,304-350,352-383,399-457`、`std/types.ts:14-17,31-43` |
| 从产物反推依赖 | `packages/core/src/gpu/composer.ts:1551-1608` |
| 发射边界 CSE / memo / asLocal | `packages/core/src/gpu/contract.ts:61-79`、`gpu/composer.ts:106-122,305-346` |
| 性能追踪器 | `packages/core/src/performanceTracker.ts:1-50` |
| 治理规则册 + Gate A/B/C | `packages/core/src/gpu/kit/PRIMITIVES.md:3-7,12-25,88-92,100-146` |
| 目录的 review-blocking 规则 | `packages/core/src/gpu/kit/CATALOG.md:7-9` |
| 单规则 facade lint | `packages/core/eslint.config.mjs:1-3,25-35` |
| 一源多目标 codegen | `packages/core/scripts/generate-components.ts:17-53,55-87,146-155,394-484` |
| 注册表生成 + exports 重写 + 文本扫描破环 | `packages/core/scripts/generateRegistry.ts:9-21,28-62,67-183` |
| docs manifest → llms.txt | `packages/core/scripts/docsManifest.ts:202-273,277-291,790-830,850,858,874-917,968-995,998-1033,1037-1047` |
| 覆盖率棘轮 | `packages/core/src/__tests__/docsManifest.test.ts:19-24,49-53` |
| 跨产物一致性扫描 | `packages/core/src/__tests__/gpu/enumPropSweep.test.ts:31-33,38-65` |
| 无基质测试的三件假件 | `packages/core/src/__tests__/gpu/_patternHarness.ts:17-27,58-104` |
| CPU golden 参照 | `packages/core/src/__tests__/gpu/helpers/shapeGolden.ts:1-6` |
| 覆盖率阈值 | `packages/core/vitest.config.ts:9,16-25` |
| 生成物提交门禁 + pnpm 缓存 | `.github/workflows/test.yml:34-40,42-43,45-49,54-62,65-88` |
| turbo 任务声明 | `turbo.json` |
| 幂等发布 + merge 即发布 | `.github/workflows/release.yml:117-127`、`scripts/release.mjs:39-49,64-79,87-110` |

**对照项目**

| 项目 | 文件:行 | 内容 |
|---|---|---|
| ComfyUI | `comfy_execution/caching.py:26-65,82-149,361-408,439-506` | CacheKeySet 层级、`to_hashable` 的 `Unhashable` 降级、`CacheKeySetInputSignature`、`HierarchicalCache`、`LRUCache`/`RAMPressureCache` |
| ComfyUI | `comfy_execution/cache_provider.py`、`comfy_api/latest/_caching.py` | 可插拔 `CacheProvider` 钩子 |
| ComfyUI | `nodes.py:555,1757,1812` | `IS_CHANGED` / `VALIDATE_INPUTS` 失效钩子 |
| ComfyUI | `comfy/model_patcher.py:691` | 全模型重载 TODO |
| ComfyUI | `comfy/supported_models.py:740,891,919,1203,1904` | 猜测的 `memory_usage_factor` |
| ComfyUI | `.github/workflows/test-unit.yml`、`test-execution.yml`、`tests/conftest.py` | `continue-on-error: true` 与 `--skip-timing-checks` |
| dsh | `core/agent-loop/tests/request-cache.e2e.ts` | prompt cache 作为契约的证据 |
| dsh | `benchmarks/AGENTS.md` + 8 条场景 | 按用户路径的 CI 性能门禁 |
| dsh | `packages/session/session-projection-cache` | 持久化 fold 捷径 |
| los | `docs/governance/2026-08-16-ci-observability-and-bottleneck-review.md` | CI 墙钟分解与根因 |
| los | `docs/governance/code-first-determinism.md`（AP11） | prompt cache 影响评估（人工） |
| los | `packages/memory/src/fts-performance.test.ts` | EXPLAIN + 索引名 + 100/200/500 ms 预算 |
| los | `turbo.json`、`tools/ci-gate.sh`、`packages/infra/src/{db.ts,migrate.ts}` | 构建编排与 DB 层 |
| cantool | `src-tauri/src/command_system/mixer.rs:15-31,40-44,164-178` | thread-local matcher + 结果缓存 + 超集预过滤 |
| cantool | `src-tauri/src/command_system/search.rs:26,135` | 每次新建 matcher |
| cantool | `TODO.md:24,2623`、`scripts/size-gate.sh:19-27` | 单 crate 重编瓶颈；rustopt 1.44 MB 口径差 |
| cankey | `docs/design/bounded-lexicon-query.md` | 37.18 ms → 56 µs；首次学习 4.763 ms 全量复制 |
| cankey | `docs/design/architecture.md:125`、`scripts/check-hotpath-no-io.sh` | 热路径 p95 < 8 ms；fail-closed 无 IO 门禁 |
| cankey | `docs/plan/funnel-attribution-2026-09-29.md` | 61.1% / 16.6% 漏斗归因 |
| lot2extension | `docs/FILTER_LIST_MATCHING_OPTIMIZATION.md` | 线性扫描 + 每规则 `new RegExp` 不 scale |
| lot2extension | `TODO.md:118` | page-snapshot 队列无消费者 |
| lot2extension | `docs/SYSTEM_OPTIMIZATION_PLAN.md` P0-3 | `ruleMatching.ts` 读不存在的 `metadata.n` |
| lot2extension | `extension/utils/request-queue.ts` | SW 单写者 + DLQ 分类 |
| rustopt | `docs/SELF-OPTIMIZATION-REVIEW.md` §0, §12 | guard 7.5× / measure 2.4× / preflight 1.82× / variant 串行 2.24× 空间 / ledger `2+2N` open |
| rustopt | `docs/BASELINE-project-sizes.md` | 各仓 `target/` 基线 |
| rustopt | `scripts/apply-build-profile.sh` | 跨四个仓的 dev profile 策略 |

---

## 9. 沉淀索引（本次调研派生的产出物）

本文是「参考实现 → 跨项目模式迁移」的方法案例。派生出的通用规则、技能与逐项目落地文档如下；后续会话应从**技能 + 规则**进入，而不是从本文进入。

### 9.1 通用（跨项目复用）

| 产出 | 路径 | 作用 |
|---|---|---|
| 技能 | `~/.agents/skills/transferable-pattern-audit/SKILL.md` | 审计方法：可迁移性四级判定、12 条工程模式卡、反例清单、证据分级 |
| 规则 | `~/.claude/rules/pattern-transfer-discipline.md` | 决策纪律：去词汇判据、缓存键完备性、失效作用域、融合三义务、先证明再提升、等价强度分级 |
| 姊妹技能 | `algorithmic-hotpath-audit` / `sync-engine-patterns` / `build-chain-identity-audit` | 分别覆盖「算法成果→工程」「实时同步三模式」「构建身份一致性」；与本文不重叠 |

### 9.2 特定（逐项目落地文档）

| 项目 | 落地文档 | 该项目的最高杠杆项 |
|---|---|---|
| los | `docs/research/2026-10-07-shaders-pattern-adoption-plan.md`（本仓） | 把 AP11 的「prompt cache 影响评估」机械化；turbo 任务 `env` 声明 + 生成物无 diff 门禁 |
| dsh | `.agents/notes/proposed/architecture/2026-10-07-shaders-pattern-adoption.md` | `buildRequest` 的 `deepFreeze` 重复遍历（占自时间 132.876/211.300 ms）；投影/请求缓存的键完整性 sweep |
| cantool | `docs/governance/tasks/2026-10-07-shaders-pattern-adoption/design.md`（索引已补 `docs/INDEX.md`） | `search.rs` 复用 `mixer.rs` 已有的线程局部 matcher + 结果缓存；单 crate 重编半径 |
| cankey | `docs/design/pattern-adoption-2026-10-07.md`（索引已补 `docs/design/decisions/README.md`） | 首次学习复制整份 user HashMap（p95 4.763 ms / 8 ms 预算）；漏斗阶段守恒 |
| lot2extension | `docs/SHADERS_PATTERN_ADOPTION_2026-10-07.md`（索引已补 `docs/README.md`） | 过滤规则匹配的缓存键覆盖；孤儿队列启动期 fail-closed |
| rustopt | `docs/pattern-adoption-from-shaders-2026-10-07.md` | `current` variant 未读 manifest 的 `[profile.release]`（cantool 1.44 MB 差的根因）；variant 并行 2.24× |
| ComfyUI | **树内双份**：M1 `ComfyUI/docs/SHADERS-PATTERN-ADOPTION-2026-10-07.md`、M3 `m3-t:~/projects/qwen21/ComfyUI/docs/…`（索引指针 `dsfolder/COMFYUI-PATTERN-ADOPTION-2026-10-07.md`） | 缓存键覆盖率差分测试 + `to_hashable` 的 `Unhashable` 静默降级 |

**ComfyUI 是双实例目标（本文的一条重要修正）**：本文第 1.3 节与第 4.1 节的 ComfyUI 事实**只来自 M1 实例**（v0.24.0，无版本库）。复核发现 **M3 实例是 v0.37.0，且有 `.git`/`.jj` 与自己的 `AGENTS.md` 和 `benchmarks/`**——两机相差 13 个小版本，缺陷存在性、`file:line`、有无版本库全部不同。因此 ComfyUI 的方案按双实例重写并**分别落在两机树内**；`dsfolder/` 只留索引指针。这条修正也是通用规则第 11 条（多实例目标）的来源。

**路径口径**：上表「落地文档」列中，los 行相对本仓根；dsh / cantool / cankey / lot2extension / rustopt 各行的路径相对**各自仓库根**（`deepseek-harness/`、`cantool/`、`cankey/`、`lot2extension/`、`dsfolder/rustopt/`）；以 `dsfolder/`、`~/.agents/`、`~/.claude/` 开头的路径相对工作区根或家目录。

### 9.3 引用本文时应保留的纪律

- 第 7 节的**证据强度分级**（高/中/低置信）是本文的一部分，引用单条结论时不要丢掉它的置信档。
- 第 6 节的**反例清单**（12 条「不要照搬」）与第 2.19 节的 **NOT PRESENT** 清单同等重要 —— 它们防止把源仓库的**场景特有选择**或**缺口**当成最佳实践。
- 三个需要目标项目自行证明的前置项：los 上下文压缩链的可交换律、cankey 首次学习复制归因、ComfyUI 「不可哈希输入 ⇒ 陈旧结果」是否可达。**证明不出来就不要动手。**
- **多实例目标**：目标项目的每个部署实例都要单独核实版本与版本库状态；`file:line` 不可跨实例套用，设备相关常数按实例各测，方案文档若目标在实例本地则须逐实例存在。本次 ComfyUI（M1 v0.24.0 / M3 v0.37.0）就是反例，见 §9.2。

---

*报告完。所有建议均标注了落点文件与验收判据；中/低置信项已在第 7 节显式列出。*
