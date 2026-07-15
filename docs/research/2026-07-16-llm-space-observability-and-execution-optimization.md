# LLM Space 对 los 可观测性与执行优化的参考价值

> 调研日期：2026-07-16  
> 外部代码快照：`deer-flow/llm-space@94ece2544e022e5998e1f94eef4bc6d44d32c1e1`  
> 对应最新发布：`v4.0.1`，发布于 2026-07-15  
> 调研方式：外部仓库源码直读、官方页面与 GitHub 当前元数据核对、los ADR/contract/source 对照  
> 限制：未启动 LLM Space 桌面端，也未连接真实 Langfuse 项目；运行时性能与交互稳定性尚未实测

## TL;DR

1. LLM Space 不是 Langfuse、OpenTelemetry 或 TokenTelemetry 的同类替代品。它首先是一个本地 Agent 原型和调试工作台：配置 prompt/model/tools，运行 Agent，把历史或 Langfuse trace 转成可编辑 Thread，再重新执行和人工 A/B 评分。
2. los 的执行事实层更强：`session_events`、`task_runs`、`run_specs`、`tool_call_states`、provider telemetry、verification records 和跨 gateway 游标重放已经形成持久化证据。los 的主要缺口不在“有没有 trace”，而在“如何从一次 trace 快速生成受控实验、重跑、对比并形成优化决策”。
3. 建议吸收 LLM Space 的 trace-to-workbench、run snapshot、配置差异对比和 rubric A/B 交互，但保持 los 自己的 PostgreSQL 事实模型和状态机。目标模块应是 los 原生的 **Execution Lab**：从不可变执行证据创建带来源关系的实验候选，经过正常 RunContract、工具策略和 verification gate 执行，再把质量、成本、延迟、重试和工具错误统一写入 `run_evals`。

## 1. 比较口径与证据边界

当前 los 仓库没有保存一个可以唯一对应“之前的 LLM 执行可观测项目”的名称。本文因此使用两类既有项目作为比较基线：

1. **TokenTelemetry 型本地可观测工具**：读取 Codex、Claude Code、Gemini CLI 等现有日志，统一展示 token、成本、工具调用和 session trace，核心特征是只读、零侵入、跨 Agent 聚合。
2. **Langfuse 型可观测后端**：通过 SDK/OTel 收集 trace、observation、usage、score 和 dataset experiment，核心特征是通用遥测后端与分析平台。

这是明确的调研假设，不代表已经确认用户此前所指项目就是 TokenTelemetry。LLM Space 当前 trace import 和远端 sync 的代码只实现了 Langfuse，因此 Langfuse 也是必须纳入的直接比较对象。

证据优先级如下：

1. LLM Space 当前 commit 的源码和 README。
2. los 当前 contracts、ADR 和实现源码。
3. 项目官网与 GitHub API 当前元数据。
4. 外部项目自述，仅用于定位，不替代源码事实。

## 2. LLM Space 实际是什么

### 2.1 产品定位

LLM Space v4 是一个 macOS 本地桌面应用，技术栈为 Bun、Electrobun、React 和 Pi Agent Core。它把四个动作放在同一工作区：

- 编辑 system prompt、messages、tools、variables 和 model settings；
- 执行单轮或 ReAct loop；
- 检查模型输出、thinking、tool call、token 和成本；
- 保存最近运行快照，恢复历史版本并做人工 A/B 评价。

这使它更接近“Agent harness IDE”，而不是只读监控面板。

### 2.2 两条不同的可观测链路

LLM Space 实际包含两条链路，不能混为一个 trace backend：

```text
本地 Thread 执行
  prompt/model/tools -> Pi Agent Core -> streamed messages/tool calls
  -> Thread 文件 -> 最近 20 次 run snapshot -> 人工比较

外部 Langfuse trace
  JSON export 或 Public API -> raw.json + trace.json
  -> 启发式转换 -> workbench.json
  -> 编辑 Thread -> 重新调用模型/工具 -> 新 run snapshot
```

第一条链路记录 LLM Space 自己执行产生的 Thread 状态。第二条链路不负责采集 Langfuse trace，而是消费已经存在的 Langfuse observations。

### 2.3 核心数据模型

LLM Space 的 Thread 同时承担配置、对话、运行历史和人工评价容器：

| 对象 | 当前语义 | 关键限制 |
|---|---|---|
| `ThreadContext` | system prompt、tools、variables、messages | 面向本地编辑，不是跨进程执行事实 |
| `ThreadRunSnapshot` | 一次完成运行后的 Thread 快照和 provider usage | 最近 20 次；失败运行不进入 run history |
| `ThreadEvaluation` | 两次 run 的 verdict、note、rubric snapshot、1-5 分 | 当前是人工评价，不是自动 evaluator |
| `TraceRecord` | Langfuse trace 摘要：状态、observation 数、模型、延迟、usage | 只支持 Langfuse source |
| `raw.json` | 导入的原始 observations | 本地文件；不是受事务保护的 ledger |
| `workbench.json` | 从 trace 派生的可编辑 Thread | 与 `raw.json` 分离，编辑不会修改原始 trace |

`workbench.json` 与 `raw.json` 分离是值得保留的设计思想：事实不可变，实验副本可变。但 los 应把它实现为数据库中的 source evidence 与 experiment spec，而不是复制这套文件目录。

### 2.4 “回放”的准确语义

LLM Space 的宣传文案使用 replay，但源码中的主要行为是：

1. 恢复某次 Thread snapshot；
2. 或从指定 message 截断后续 messages；
3. 使用当前或修改后的 model/tools/prompt 再次调用真实模型和工具。

这属于 **restore-and-rerun**，不是确定性重放。它不会保证相同模型响应、相同外部工具结果或相同副作用，也没有 los 的 idempotency、tool state recovery 和 verification 语义。报告和未来 UI 应明确区分：

- `stream replay`：重读已持久化事件，不产生新执行；
- `resume`：从持久化状态继续未完成执行；
- `retry`：重新尝试失败步骤；
- `fork/rerun`：从旧执行派生新的执行，可能产生新副作用；
- `deterministic replay`：用录制结果模拟执行，当前两边都未完整提供。

### 2.5 当前实现边界和风险

1. Langfuse observations 被按时间排序，再把 generation 的直接 child spans 映射为 tool calls。复杂嵌套 span、并行分支和 subagent topology 可能在 Thread 转换时丢失。
2. Connected project 把完整 Langfuse public/secret key 写入本地 `project.json`。这不符合 los 的 secret 治理要求，不能照搬。
3. 远端 trace 搜索最多返回 100 条；单 trace observation sync 最多 5 页、每页 1000 条。超过上限时整条 trace 不导入，避免部分 trace 被当成完整事实。
4. 评估是人工 pairwise verdict 与 2-6 个 rubric criteria 的 1-5 分，不包含自动 dataset runner、统计显著性或 verification gate。
5. `trace-manager.ts`、`trace-panel.tsx`、`thread-store.ts` 都超过 1000 行。其功能可以参考，但结构不符合 los 的 400/600 行模块门槛。
6. 项目在 2026-06-28 才公开当前仓库，且截至调研日仍在快速变化；本文结论绑定到所列 commit。

## 3. 与既有 LLM 执行可观测项目的差异

| 维度 | TokenTelemetry 型工具 | Langfuse 型后端 | LLM Space v4 | los 当前 |
|---|---|---|---|---|
| 首要目标 | 跨 Agent 只读监控 | 通用 LLM telemetry/eval 平台 | Agent 原型、调试和重跑工作台 | 可审计、可恢复的 Agent 执行与记忆平台 |
| 数据获取 | 解析本地既有日志 | SDK/OTel/API instrumentation | 自己执行 Thread；或导入/sync Langfuse | 执行路径原生写 PG ledger |
| 事实所有权 | 外部日志是来源 | Langfuse observations 是来源 | 本地 Thread/raw trace 文件 | `run_specs`、`task_runs`、`session_events` 等是来源 |
| 跨 Agent 覆盖 | 强，依赖 adapter | 强，依赖 instrumentation | 弱，当前 trace source 只有 Langfuse | los 自身执行强；外部 adapter 受治理约束 |
| 实时 trace | 日志 watcher | 原生 | 自身 run 有 streaming；外部 trace 需导入/sync | SSE/NDJSON + persisted events/checkpoints |
| trace 拓扑 | 取决于各日志格式 | span/observation 树 | 导入时压缩成 message + direct child tool call | turn/tool/state projection，保留状态审计 |
| 历史重读 | 是 | 是 | 是 | 是，支持 cursor replay |
| 受控重跑 | 通常无 | 可借 dataset/experiment 实现 | 强，恢复/编辑 Thread 后重跑 | 有 branch/resume/retry 基础，但缺少统一实验工作台 |
| 评价 | 成本与使用统计为主 | score、dataset、experiment | 人工 A/B + rubric | run eval 汇总/时间窗比较 + verification，但缺少 run-pair UX |
| 状态机约束 | 无 | 不拥有业务状态机 | 轻量本地 run 状态 | AP1/AP2/AP3 强制状态、计划和验证 |
| 持久化 | 本地日志和轻量配置 | 服务端数据库 | 本地 JSON 文件 | PostgreSQL + contracts |
| 最适合的问题 | “Agent 花了多少、做了什么” | “线上 LLM 系统表现如何” | “这条失败 trace 改哪里、重跑后是否更好” | “执行是否合规、可恢复、可验证，以及如何持续优化” |

核心判断：LLM Space 增加的不是更完整的 telemetry backend，而是 **从观察到实验的操作路径**。这正是 los 当前最值得补的部分。

## 4. los 已有能力与真实缺口

### 4.1 已有事实层

当前源码可验证的能力包括：

- `session_events` 作为 append-only 执行事件来源，`/sessions/:id/trace` 提供 UI projection；
- `run_specs`、`task_runs`、`tool_call_states` 和 `verification_records` 支持恢复级状态判断；
- `/runs/:id/events`、`/runs/:id/stream` 按 cursor 返回持久化事件与 stream checkpoints；
- provider call telemetry 记录 trace/session、provider/model、endpoint、HTTP status、duration、payload size 和 token usage；
- session inspector 按 turn 显示 model/tool duration、token 和 tool 数；
- `run_evals` 可按 provider/model、failure class、verification status 和 failover scope 汇总，并比较两个时间窗口；
- context monitor 已实现 60%/75%/85% 阈值事件，semantic eviction 已有代码入口；
- session branch、blocked task resume、tool retry/recovery 已经是独立语义。

这些能力意味着 los 不需要再引入一套第三方 trace 状态机，也不应该让 Langfuse 或 LLM Space 成为运行时事实来源。

### 4.2 主要缺口

| 缺口 | 当前表现 | LLM Space 提供的参考 |
|---|---|---|
| Trace 到实验 | Inspector 主要用于查看事件 | 一键把 trace 变成可编辑 workbench |
| 单次 run 对比 | Evals 主要按时间窗聚合 | 直接选择两个 run，检查内容并评分 |
| 配置 provenance | 事件中有 effective provider/model，但缺少统一实验快照 | run snapshot 保存 model/context/tools |
| 失败定位到重跑 | branch/resume/retry 分散在不同入口 | restore、rerun-from-message 集中在 Thread UX |
| 质量评价 UX | 可手工 record eval，字段偏运维统计 | rubric revision、criterion score、pairwise verdict |
| 优化建议 | 有原始指标，缺少关联分析 | 工作台让人快速修改变量并观察新结果 |
| 外部 trace 利用 | 外部 summary 与 runtime evidence 被严格分开 | Langfuse trace adapter + editable copy 的分层方式 |

## 5. 建议吸收的能力

### P0：完善现有可观测投影，不新增执行语义

1. **Execution fingerprint**  
   为每次 run projection 计算可解释指纹：system prompt version/hash、effective provider/model/profile、tool catalog hash、allowed tool policy、identity、memory/spec snapshot 标识、context thresholds。先从已有事件与 run contract 读取，不反向修改 ledger。

2. **Turn waterfall 与浪费指标**  
   在 session inspector 增加 per-turn model/tool waterfall 和汇总：模型等待、工具等待、重试、错误、denied、无结果 tool call、cache token、context fill。LLM Space 的卡片式 token/cost 展示可以参考，但数据必须来自 los projection。

3. **失败原因快捷筛选**  
   从 `session_events`、provider telemetry、tool states 和 verification records 生成 failure facets，例如 provider error、tool error、policy denied、verification failed、context critical、orphan/recovery。不要从自由文本摘要推断唯一原因。

### P1：建立 los 原生 Execution Experiment 合同

新增 contract 时应先定义 `contracts/execution-experiment.yaml`，再实现存储和 API。建议最小对象如下：

```text
ExecutionExperiment
  id
  sourceRunSpecId / sourceSessionId / sourceEventCursor
  sourceEvidenceHash
  baselineRunSpecId
  candidateConfig
    promptPatch
    providerProfileOverride
    toolPolicyOverride
    input/message fork point
  createdBy / createdAt
  status
  candidateRunSpecIds[]
  rubricSnapshot?
```

关键约束：

- experiment 只引用源证据，不复制或改写 `session_events`；
- candidate 必须生成新的 `run_spec`，继续经过 AP2 plan persistence；
- 执行仍走现有 scheduler/provider/tool policy；
- succeeded 仍必须经过 AP3 verification；
- fork/rerun 必须显示会重新调用外部工具，不能标成无副作用 replay；
- 每个 candidate 都记录基线、改动项和有效 runtime route，避免只比较配置值。

### P1：增加 run-pair 评价

在现有 `run_evals` 之上增加稳定的 pair/rubric 语义，而不是把 LLM Space 的 `ThreadEvaluation` JSON 塞进 `summary_json`：

- immutable rubric revision；
- baseline/candidate run spec IDs；
- criterion scores；
- operator verdict 与 note；
- deterministic verification results；
- judge model score及 judge provider/model provenance；
- cost、latency、retry、tool error、context efficiency 自动指标。

人工评价和自动验证必须分栏显示。人工“更好”不能替代 verification succeeded，judge 分数也不能直接触发 trusted provider promotion。

### P2：把实验用于执行优化

1. **Provider/profile 选择**  
   对相同 input 和 tool policy 运行受控候选，按 verification pass rate、人工 rubric、成本、延迟和重试率比较。只有 compatibility probe 与回归样本通过后，才允许调整默认 profile。

2. **工具策略优化**  
   统计每个工具的成功率、P50/P95 duration、重试、denied、输出大小和后续验证结果。识别“高 token 输出但没有提高成功率”的工具调用，以及串行执行中可并行的独立只读工具。

3. **上下文策略优化**  
   将 context fill、semantic eviction、compaction、cache read/write token 与最终 verification 关联。比较策略时保留相同任务集合，不能只看 token 降幅。

4. **失败回归集生成**  
   把确认的 failure class 和最小必要输入提升为 eval dataset candidate。原始 transcript、secret、文件内容和工具输出必须先经过脱敏与 provenance 审查。

5. **关键路径分析**  
   根据 task/tool/provider 的 causation/correlation 关系计算关键路径，区分总 wall time 与并行分支累计 duration。LLM Space 的简单时间排序不足以处理 los 的 DAG 和远端 executor。

### P3：可选外部 trace adapter

若确有跨工具复盘需求，可实现 Langfuse/OTel/本地 agent log adapter，但需要遵守 ADR 0002 和外部 evidence policy：

- 导入记录标记 `external` provenance；
- 原始外部 trace 不成为 los runtime replay evidence；
- 转换结果只创建 experiment draft，不直接创建 succeeded run 或 verification；
- adapter 必须报告字段丢失、截断、未知 event 和 topology degradation；
- secret 使用 `@los/infra` 的配置/凭据路径，不写明文项目 JSON。

## 6. 不建议吸收的部分

1. **不引入 Pi Agent Core 替代 los loop**：会产生第二套 tool、message、state 和 provider 语义，违反 ADR 0007。
2. **不采用 Thread JSON 作为执行真相**：los 需要事务、一致性、跨进程恢复和状态转换审计。
3. **不直接复用 Langfuse observation -> message 的启发式映射**：los 已有原生 event contract，降维转换会丢失 DAG、subagent、state transition 和 causation 信息。
4. **不把 rerun 称为 replay**：这会混淆只读事件重放与会产生副作用的新执行。
5. **不复制桌面壳**：los 已有 Web operator surface；Electrobun 不解决当前核心缺口。
6. **不复制超大模块**：应按 contract、projection、experiment service、routes 和 UI view 拆分，并遵守 400/600 行门槛。
7. **不保存明文 Langfuse secret**：外部连接必须走 los 现有 infra/config 规则，并明确 operator consent。

## 7. 建议的 los 目标结构

```text
不可变事实
  run_specs / task_runs / session_events / tool_call_states
  provider_call_telemetry / verification_records / stream_checkpoints
                         |
                         v
投影层
  Session Trace Projection
  Execution Fingerprint
  Critical Path + Failure Facets
                         |
                         v
Execution Lab
  Create experiment from run/turn/failure
  -> patch prompt/model/tool policy/fork point
  -> persist experiment provenance
  -> create candidate run_spec
                         |
                         v
现有执行与治理
  scheduler -> provider/tool policy -> task/tool states -> verification gate
                         |
                         v
评价与决策
  run_evals + pairwise rubric + deterministic checks
  -> baseline/candidate diff -> operator decision
```

模块放置建议：

| 层 | 建议位置 | 责任 |
|---|---|---|
| Contract | `contracts/execution-experiment.yaml` | experiment、fork、pair evaluation 的公开语义 |
| Projection | `packages/agent/src/` 下的独立小模块 | 从 persisted evidence 计算 fingerprint/metrics |
| Store/service | `packages/agent/src/` | experiment provenance 与 candidate lifecycle；状态变化仍走统一 transition path |
| Gateway | `packages/gateway/src/routes/` | 读取 trace/metrics，创建 experiment，显式执行 candidate |
| Web | `packages/web/src/` | Trace、Diff、Run、Compare 四个视图 |
| Eval | 扩展现有 `run-evals` | pair/rubric/judge/deterministic metric，不另建平行 eval 系统 |

是否需要新增数据库表，应在 contract 和 ADR 评审后决定；不要为了复刻 `workbench.json` 直接在 `packages/infra/` 新增文件。

## 8. 分阶段验收标准

### Phase A：只读可观测增强

- 同一 run 的 trace、provider telemetry、tool states 和 verification 可通过稳定 ID 关联；
- UI 明确区分 configured provider/model 与 effective provider/model；
- 每个 duration、token、cost 指标标注来源和缺失状态；
- projection 对未知 event 不静默丢弃，并由 golden fixture 覆盖。

### Phase B：单候选实验

- 可从一个 run 或 turn 创建 experiment draft；
- source evidence hash、fork point 和 config diff 可审计；
- 执行前必须经过 operator action 和现有 RunContract；
- candidate 使用新 run/session 标识，原始证据不变；
- 失败、取消、blocked 和 succeeded 都能回到 experiment 视图。

### Phase C：成对评价

- baseline/candidate 可以按内容、配置和指标逐项比较；
- rubric revision 被快照保存；
- 人工评分、judge 评分和 verification 独立展示；
- 比较结果可进入回归集候选，但不能自动提升 provider trust。

### Phase D：批量优化

- 固定 dataset、预算、并发、tool policy 和 verification 后再比较 provider/profile；
- 报告 success/verification rate、成本、延迟、重试、tool error 和 context 指标；
- 支持失败样本下钻到原始 persisted evidence；
- 所有自动建议都保留 operator decision，不直接改默认配置。

## 9. 最终判断

LLM Space 对 los 的主要价值不是“再加一个 trace 系统”，而是证明了一个高价值操作路径：

```text
看到失败 -> 恢复当时上下文 -> 修改一个变量 -> 重新执行 -> 对比两个结果
```

los 已经拥有这条路径所需的更可靠事实基础，但当前这些能力分散在 session inspector、branch/resume、provider diagnostics、run eval 和 verification 页面。下一阶段应优先把它们组合为有 provenance、有状态门禁、有验证记录的 Execution Lab。

优先级判断：

1. 先做 execution fingerprint、failure facets 和 turn waterfall；风险低，直接提高现有证据可读性。
2. 再定义 execution experiment contract 和单候选 fork/rerun；这是核心新增语义，需要 ADR、contract 和 focused harness。
3. 再补 pairwise rubric 与自动指标；复用 `run_evals`，不要另建评价孤岛。
4. 最后考虑 Langfuse/TokenTelemetry/OTel adapter；它们只能作为外部证据入口，不能改变 los 的事实所有权。

### 9.1 已登记的结构化待办

本次调研已登记到 `packages/agent/src/todo-seeds-execution-lab.ts`。所有项先保持 `backlog`，优先级表示技术顺序和影响程度，不代表已批准进入执行模式。

| 优先级 | Todo | 为什么是这个优先级 | 前置条件 |
|---|---|---|---|
| P0 | `todo-los-execution-observability-projection` | 只读投影不增加执行状态，却决定后续 fingerprint、成本、延迟和失败原因是否可信 | model event projection、tool state wiring、golden trace fixtures |
| P1 | `todo-los-execution-experiment-contract` | 引入 experiment provenance、candidate lifecycle 和 fork/rerun 新语义，必须 contract first 并经过 ADR 与 harness | P0 projection、RunContract、verification gate |
| P1 | `todo-los-execution-pairwise-rubric-eval` | 候选是否优于基线需要同源配对与不可变 rubric，但评价语义必须建立在 experiment provenance 上 | experiment contract、P0 projection |
| P2 | `todo-los-execution-optimization-analysis` | 聚合优化需要足够的配对样本；当前先输出 advisory，不能自动修改 provider/profile/tool/context 默认值 | pairwise eval、provider compatibility harness |
| P3 | `todo-los-external-trace-adapters` | 外部 trace 扩展覆盖面，但不是 los 当前主缺口，且存在截断、映射和事实所有权风险 | experiment contract、P0 projection |

依赖顺序如下：

```text
persisted execution evidence
  -> P0 observability projection
  -> P1 experiment contract
  -> P1 pairwise rubric eval
  -> P2 optimization analysis

P1 experiment contract + P0 projection
  -> P3 external trace adapters
```

P0 的完成标准不是“页面显示出图表”，而是指标可从持久化证据重算，缺失版本显式返回 `unknown`，并由 golden fixtures 固定。P1 开始涉及 API、存储和执行语义，因此进入实现前还需要 operator 对 ADR、合同字段和首次实验执行模式分别确认。

## 10. 参考资料

### 外部来源

- [LLM Space GitHub 仓库](https://github.com/deer-flow/llm-space)
- [LLM Space v4.0.1 release](https://github.com/deer-flow/llm-space/releases/tag/v4.0.1)
- [LLM Space README at 94ece25](https://github.com/deer-flow/llm-space/blob/94ece2544e022e5998e1f94eef4bc6d44d32c1e1/README.md)
- [TraceManager: Langfuse import、sync 与 workbench](https://github.com/deer-flow/llm-space/blob/94ece2544e022e5998e1f94eef4bc6d44d32c1e1/apps/desktop/src/bun/traces/trace-manager.ts)
- [Thread run history 与 manual evaluation](https://github.com/deer-flow/llm-space/blob/94ece2544e022e5998e1f94eef4bc6d44d32c1e1/packages/core/src/thread/history.ts)
- [Langfuse API client 与同步上限](https://github.com/deer-flow/llm-space/blob/94ece2544e022e5998e1f94eef4bc6d44d32c1e1/apps/desktop/src/bun/traces/langfuse-client.ts)
- [LLM Space telemetry policy](https://github.com/deer-flow/llm-space/blob/94ece2544e022e5998e1f94eef4bc6d44d32c1e1/TELEMETRY.md)
- [TokenTelemetry GitHub 仓库](https://github.com/VasiHemanth/tokentelemetry)
- [Langfuse Observability](https://langfuse.com/docs/observability/overview)
- [Langfuse Evaluation](https://langfuse.com/docs/evaluation/overview)

### los 当前证据

- `docs/adr/0002-session-ledger-observability.md`
- `docs/adr/0007-provider-loop-first-model-profiles.md`
- `docs/adr/0012-service-cluster-and-stateful-agent-roadmap.md`
- `docs/adr/0014-testing-strategy-and-regression-gates.md`
- `contracts/session-trace.yaml`
- `contracts/run-stream.yaml`
- `packages/agent/src/session-trace.ts`
- `packages/agent/src/providers/telemetry.ts`
- `packages/agent/src/run-evals.ts`
- `packages/agent/src/context-monitor.ts`
- `packages/agent/src/semantic-eviction.ts`
- `packages/web/src/pages/session-inspector.tsx`
- `packages/web/src/evals-page.tsx`

## 11. 尚待验证

1. 用户所说的“之前项目”是否特指 TokenTelemetry、Langfuse，或另一个未进入当前仓库文档的项目；若名称不同，应追加一次点对点差异表。
2. LLM Space 在真实大 trace、并行 tool call、subagent 和超 5000 observations 场景下的转换完整性。
3. LLM Space run history 的人工 A/B 工作流在实际使用中是否足以稳定提升任务成功率；当前源码只能证明功能存在，不能证明优化收益。
4. los 当前 persisted evidence 是否已经覆盖 execution fingerprint 所需的全部 tool catalog、prompt/spec/memory version；缺失字段需先进入 contract，不能靠 UI 临时拼接。
5. 批量实验的真实成本与 provider quota 影响；在有基准任务集和预算前，不应给出自动路由结论。
