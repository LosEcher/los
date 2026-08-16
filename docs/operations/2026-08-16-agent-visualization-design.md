# Agent 执行可视化设计方案 — 2026-08-16

> Status: **Phase 1-4 + P0 implemented**（2026-08-16，change `orvqqppt`）
> 范围：los web 的 agent 执行可视化（请求轨迹 / 执行拓扑 / 模型指标），
> 设计参考业界方案 + DeepSeek Harness（DSH）事件溯源与 UI 模式。

## 0. 实现记录（Phase 1-3，2026-08-16）

已实现并验证（本地 8080 gateway + 5173 vite dev 实测）：

- **Phase 1 轨迹时间线**：`packages/web/src/pages/timeline-gantt.tsx`（turn 泳道 +
  绝对时间条块，model.response/tool.result/error 分色，hover/选中）
  + `timeline-panel.tsx`（甘特 + 事件 inspector：timing/usage/父链/payload），
  挂载于 Sessions 详情面板（`sessions-page.tsx`）。
  数据源：`useSessionEventStream`（WS 实时 + 增量轮询），零后端改动。
- **Phase 2 执行拓扑图**：`packages/web/src/pages/topology-panel.tsx`（自绘 SVG 分层
  布局：run_spec → task_run → agent_task → task_attempt；session_event /
  tool_call_state / verification_record 折叠为计数徽章；边按 kind 分色、
  depends_on 实线其余虚线；点击节点显示 record JSON），挂载于 Run specs 详情
  （`run-specs-page.tsx`）。数据源：`GET /runs/:id/inspect`（证据图，零改动）。
- **Phase 3 模型指标趋势与窗口对比**：
  - 后端 `packages/agent/src/metrics-trends.ts` + `GET /metrics/trends`（contract
    `contracts/metrics-trends.yaml`）：按日聚合 provider_call_telemetry 的
    调用数/错误率/avg/P50/P95（percentile_cont）/usageFillRate，附当前窗 vs
    等长前一窗的环比（calls/errorRate/avgMs delta）。
  - 前端 `sparkline.tsx`（自绘 SVG 折线+面积渐变）+ `usage-trends-section.tsx`
    （趋势卡片：p50 序列 sparkline + 三组环比箭头，↑红=恶化 ↓绿=改善 —=无前窗），
    usage 页 callTelemetry 表格新增「延迟趋势（p50）」列。
  - 实测：9 个 provider×model 系列；deepseek 延迟环比 +664%（真实恶化被如实呈现）。
- **顺手修复 pre-existing bug**：run-specs 页渲染 `blockers`（`RunStateBlocker[]`
  对象）直接作为 React child 导致整页白屏（React: Objects are not valid as a
  React child），改为渲染 `message` + ids；vite dev proxy 缺失 `/usage` 与
  `/metrics` 转发（usage 页 dev 模式不可用的根因）。
- 样式：styles.css 追加（CSS 变量、与 exec-obs 风格一致）；i18n en/zh 对称。
- 测试：`timeline-topology.test.mjs` + `usage-trends.test.mjs`（源码级接线断言，
  与 execution-observability-panel.test.mjs 同模式）+ agent
  `metrics-trends.test.ts`（真实 DB 聚合断言：P50/P95 区间、错误率、加权
  usageFill、环比）；web check / build / 55 既有测试 / 结构门禁全绿。
- 实测数据：20 泳道 / 58 条块的时间线；519 节点 835 边的证据图折叠为
  2 可视节点 + 折叠计数；9 趋势卡片 + 18 sparkline + 27 环比。

### P0 — Activity 并发时间线（AgentsView 对标，2026-08-16，change `xtysloxk`）

- 后端 `packages/agent/src/metrics-activity.ts` + `GET /metrics/activity`
  （contract `contracts/metrics-activity.yaml`）：`generate_series` 时间桶网格，
  活跃判定 = timed 事件（model.response/tool.result）的
  [created_at, created_at+durationMs] 区间跨越桶起点（上界 `created_at <
  bucket+bucketSize` 防止高估）；每桶并发数/agent-minutes/成本（model.response
  payload cost 同网格聚合）；`bucket=<iso>` 时返回该桶活跃会话钻取列表
  （LIMIT 200，含活跃区间/事件数/成本）。坑：`to_char(timestamptz)` 用会话
  时区导致桶标签偏移——必须 `AT TIME ZONE 'UTC'`。
- 前端 `activity-panel.tsx`：SVG 柱状图（24 桶，峰值桶高亮、hover 提示、
  点击钻取）+ 峰值/agent-minutes/成本/会话槽位合计 + 钻取会话列表
  （点击跳转 Sessions 页并选中，sessionStorage 接力）。挂载于 usage 页
  FleetCard 之后。
- 实测：峰值并发 23、agent-minutes 3480、钻取 23 会话与系列一致；修复了
  series JOIN 缺上界导致桶 0 高估（53→23）的 bug。
- 测试：agent 单测 2/2（并发/成本/钻取/窗口校验）+ 页面接线断言 2 条；
  web/agent/gateway check、55 既有测试全绿。

### Phase 4 — 子代理树（2026-08-16，change `xtysloxk`）

- 后端 `packages/agent/src/session-subagents.ts` + `GET /sessions/:id/subagents`
  （contract `contracts/session-subagents.yaml`）：递归 `parent_run_spec_id`
  血缘（默认深度 4，上限 8）；子节点带 child.agent.* 生命周期状态（事件在
  **父会话**、按 payload.childRunSpecId 索引，一次查询）、子会话
  model.response 的 usage/token/成本聚合、耗时（created→updated）。
- 前端 `subagent-tree.tsx`：递归树（展开/折叠、状态点+事件徽章、耗时/token/
  成本行尾汇总），挂载于 SessionInspector（TimelinePanel 之后）；点击节点
  直连 `onSelectSession` 切换子会话（跨页兜底 sessionStorage 接力）。
- 实测：真实血缘树（父 216k tokens → 4 子节点各 ~4.9k）；点击子节点 →
  子会话详情 + 时间线，无错误。
- **顺手修复 pre-existing bug**：SessionInspector 对 metadata/turns/messages
  缺失的会话（子会话记录）直接白屏——加可选链保护。
- 测试：agent 单测 1/1（递归/事件状态/usage/成本/深度上限）+ 页面接线断言；
  全量检查绿（agent 5/5、页面 13/13、web 55）。

### Effective-model 投影（展示层修复，2026-08-16，change `xtysloxk`）

「模型?」根因：会话 metadata 记录的是**请求模型**（未指定时为 null，
`model ?? null`），实际运行模型只在事件账本里。按「追加日志 + 派生投影」
原则做纯读修复（拒绝回填双写）：

- `latestEffectiveModels(sessionIds)`（session-events.ts）：`DISTINCT ON
  (session_id) ... ORDER BY session_id, id DESC` 取每会话最新
  model.response 的实际模型；
- `GET /sessions` 与 `GET /sessions/:id` 返回 `effectiveModel`；
- 前端列表行与详情面板显示 `metadata.model ?? effectiveModel ?? 占位`。
- 实测：`chat-deepseek-1786876211597`（meta.model=null）→ 列表与详情均显示
  `deepseek-v4-flash`（与账本一致）。
- 测试：agent 单测 2/2（最新模型胜出/空模型过滤/空输入）+ 接线断言。

Phase 4 完成，方案四视图全部落地。剩余增强见 §8（搜索 UI 等）。

## 1. 背景与目标

2026-08-16 的 los 可观测性盘点结论：

- **数据层完备**：`session_events` 事件账本（trace_id / request_id / parent_event_id
  span 链，10 域 100+ 事件类型）、`provider_call_telemetry` 调用级遥测（分段延迟、
  usage、错误）、`run_evals` 终态投影、`daily_agent_quality_snapshots` 每日质量、
  `GET /metrics`（Prometheus）、`GET /usage/summary`（L1 用量立方体）。
- **轨迹可显示**：`/sessions/:id/trace`（+since 增量）、`/sessions/:id/execution-observability`
  （waterfall / fingerprint / failureFacets）、`/diagnostics/:traceId`（跨表聚合 +
  span 树）。
- **拓扑缺可视化**：`/runs/:id/inspect` 返回完整证据图（7 类节点、11 类边），
  web 端无图渲染页面 —— 最大空白。

本方案目标：在 los web 补齐 **agent 执行可视化**，包括会话级轨迹时间线、
执行拓扑图、模型指标与用量视图，并建立跨会话的 fleet 级聚合视图。

## 2. 业界调研结论

调研范围：Langfuse、LangSmith、AgentOps、Arize Phoenix、Traceloop/OTel GenAI、
W&B Weave、agent-prism、VibeLens、VibeTrace、widescope、tracesage、veilpiercer、
Honeycomb agent timeline、AutoGen/LangGraph Studio、Dify/Flowise 等。
完整报告见 `docs/research/2026-08-16-agent-visualization-landscape.md`。

### 2.1 三类主流形态

| 形态 | 代表 | 特点 | 适用 |
| --- | --- | --- | --- |
| **全链路 trace 平台**（自托管/云） | Langfuse、Phoenix、Traceloop、W&B Weave | Trace→Span→Event 嵌套树 + session 分组 + 成本/缓存/评估闭环 | 生产级、协议标准、多 provider 可比 |
| **会话回放/时间旅行** | AgentOps、Phoenix | 逐步回放、时移调试、agent 关系图 | 调试多 agent 交互 |
| **本地优先 transcript 解析** | VibeLens、VibeTrace、widescope、tracesage、veilpiercer | 解析现有 CLI JSONL，零插桩，本地渲染 | 轻量起步、隐私敏感、个人工作流 |

### 2.2 可直接落地的借鉴点

1. **数据模型抄 Langfuse 的 Trace→Observation 嵌套**（span/generation/event 四层），
   session 分组 + usage 统一计费单位，对齐 OTel `gen_ai.*` 属性族（prompt/completion
   tokens、cache 读写、reasoning tokens），保证多 provider 可比。
2. **UI 主视图选 Honeycomb 的 agent 泳道时间线**（多 agent/会话并发对比、真实
   start/duration 甘特），叠加 trace 树 + waterfall 下钻联动；evals 标注直接挂
   span 形成评估闭环（Phoenix 模式）。
3. **零侵入起步走 VibeLens 路线**：解析现有 transcript（los 即 `session_events`）
   而非重新插桩——los 数据面已完备，直接投影即可。
4. **OTel GenAI semantic conventions**（`gen-ai-agent-spans.md`）：agent span 语义
   约定正在标准化（`gen_ai.agent.*` 属性），los 的 trace_id/span 链与它天然同构，
   未来互操作成本低。
5. **local-first 是趋势**：widescope（Rust/WASM 浏览器原生）、tracesage/veilpiercer
   （本地优先）说明自建本地可视化是成熟路线，无需引入重量级平台。

## 3. DSH / harness 设计思路提炼

从 deepseek-harness checkout 直接验证（2026-08-16）：

### 3.1 事件溯源是唯一真相（核心原则）

- SessionEvent 追加日志是唯一真相；**「模型可见即日志记录」**：任何到达模型请求的
  内容都必须能从日志重建，运行时不变量强制（`Model-visible means logged`）。
- UI 与 SDK 从日志渲染：`Add UI or editor integration → drive ctx.agents and render
  from session/event`。
- 派生视图（标题、模型历史、telemetry）都是日志的投影（`deriveMessages()`、
  `foldSurface()`），日志本身不因投影而改变。

> **对 los 的含义**：可视化必须从 `session_events` 投影，而不是为可视化另建写入路径；
> 可视化视图全部是派生 read model。los 已符合这一点（trace / observability / usage
> 都是查询时投影）。

### 3.2 turn / step 两级模型

- **step** = 一次模型请求 + 其调用的工具；**turn** = 零或多个 step，开口于首次输入
  认领、闭合于无欠账。
- `turn/*`、`step/*`、`user/message`、`assistant/*`、`tool/*` 都是持久会话事件；
  `agent/*` 是 live 扩展点（瀑布式监听，必须 `next()` 委托）。
- 事件词汇表（`known-event-types.ts`）：turn/start、turn/end、turn/pending、step/start、
  step/end、assistant/chunk、assistant/message、tool/call、tool/result、request/header
  （提示词快照）、compaction/*、approval/*、tool-workflow/run-start|agent-start|…、
  subagent/descriptor 等 48 种。

> **对 los 的含义**：los 的 `session_events.turn` 字段 + `model.turn.started/completed` +
> `model.response` + `tool.call/result` 与 DSH 的 turn/step 同构；可视化按 turn 分组、
> step 内联的层级组织方式可直接借鉴 DSH trajectory。

### 3.3 ui-trajectory：turn-aware 事件账本（最直接的参照实现）

`packages/client/ui-trajectory`（conversation.view 槽位 tab）：

- **Overview 时间线**：固定顶部，真实 start/duration 从左到右投影（甘特式）；
  拖动区间聚焦 ledger 上的活跃记录；滚轮缩放时间域；拖拽平移。
- **Ledger 表**：只保留 index / event / content 三列；turn 边界用粗线、step 用紧凑
  内联标记；选择记录打开本地 inspector（token 用量、duration、Input/Output/Timing）。
- **TTFT 分段**：assistant span 把首 token 时间与解码时间分开记录；hover 500ms 显示
  精确时钟与时长。
- **虚拟化**：只挂载可见行窗口 + overscan；尾部打开、向上翻页加载；流式更新保持
  尾部跟随，向上滚动即暂停跟随。
- **语义细节**：compaction 请求作为独立「Between turns」区块、编号压缩留在所属 turn；
  运行中记录不伪造时长（partial/runningCalls 只画 start marker）；搜索/折叠/Request
  汇总作用于已加载窗口。
- 组装方式：从共享 Session window（会话快照）用 **Event Definitions** 组装业务记录，
  Trajectory 不读也不改 Chat 快照。

> **对 los 的含义**：los 的 waterfall（modelWait/toolWait/tokens/retries）可升级为
> 同类时间线：Overview 甘特 + 虚拟化 ledger + 本地 inspector；los 的
> `session-events.trace_id/parent_event_id` 提供 DSH 没有的 span 链，可支持
> 「父子跨度」在时间线上叠加显示。

### 3.4 子代理与工作流的层级可视化模式

- **ui-subagent**：父会话 header 的目录树 —— 懒展开的 catalog tree、running 活动
  状态、token 用量桶汇总（四个不相交桶）、duration 精确显示；`subagentsByParent`
  通过标准 `useSessions` 钩子读取。
- **ui-workflow-run**：run → phase → member 三层树 —— 展开/折叠随生命周期状态自动
  控制（运行/失败/取消/中断强制展开，完成后自动折叠一次）；member 可打开子会话。

> **对 los 的含义**：los 的 `run_specs.parent_run_spec_id`（子 agent lineage）、
> `agent_tasks` DAG、`tool-workflow` 等价物（feed-analysis / scheduled-work）可复刻
> 这两类层级树；「展开状态随状态机自动驱动」是值得借鉴的交互模式。

### 3.5 遥测出口

- `session-telemetry-otel`：OTel 日志导出（FULL / FEEDBACK_ONLY / DISABLED），
  按 `(session.id, seq)` 去重，`shutdown` 标记缺失可检测崩溃；隐私 fail-closed。

> **对 los 的含义**：los 的 OTel bridge（4318）方向相反（外部 CLI → los），
> 面向外部导出可参考 DSH 的 mode 设计（los 目前 /metrics 与 usage 已足够，
> 外部导出非本方案范围）。

### 3.6 前端工程约束（实现必须遵守）

- CSS Modules + `clsx`，不引入组件库/Tailwind；`--dsw-alias-*` 语义令牌，
  禁止字面色值；主题归属 ui-theme。
- 所有注册（locale / definition / slot）是 Cordis effect，可撤销；无特权核心。
- 浏览器端包禁止 `node:` 导入（vite bundle 约束）。

## 4. los 数据面盘点（实现输入）

| 数据 | 来源表/接口 | 状态 |
| --- | --- | --- |
| 事件流（span 链） | `session_events`（trace_id/request_id/parent_event_id/turn/usage/payload） | ✅ 已有 |
| 会话轨迹投影 | `projectSessionTrace` → `/sessions/:id/trace`(+since) | ✅ 已有 |
| 执行观测投影 | `projectExecutionObservability` → `/sessions/:id/execution-observability` | ✅ 已有 |
| 跨表请求轨迹 | `/diagnostics/:traceId`（events+tasks+todos+provider calls+spanTree） | ✅ 已有 |
| 证据图（拓扑数据） | `readRuntimeEvidenceGraph` → `/runs/:id/inspect`（7 节点 11 边） | ✅ 已有，**无 UI** |
| Agent 任务 DAG | `readAgentTaskGraph` → `/runs/:id/graph` | ✅ 已有（治理页用） |
| 子 agent lineage | `run_specs.parent_run_spec_id` + `child.agent.*` 事件 | ✅ 数据有，无树视图 |
| 调用级遥测 | `provider_call_telemetry`（分段延迟/usage/错误码/限流） | ✅ 已有 |
| 用量立方体 | `/usage/summary`（byProviderModel/byDay/callTelemetry） | ✅ 已有（usage 页） |
| 每日质量 | `daily_agent_quality_snapshots`（provider 成功率/延迟/retry/cost） | ✅ 已有 |
| Provider 健康 | `/diagnostics/provider-health` | ✅ 已有 |
| Prometheus | `/metrics`（10 指标） | ✅ 已有 |
| 失败归因 | failureFacets（provider/tool/policy/verification/context/recovery） | ✅ 已有 |
| 实时流 | SSE（chat live events + operator events）、trace/since 增量 | ✅ 已有 |

**缺口**：证据图与拓扑无可视化；子 agent 无树视图；waterfall 无甘特时间线；
模型指标无对比视图（provider×model 的延迟/错误/成本趋势）；fleet 级聚合无
时间窗对比。

## 5. 目标形态

### 5.1 会话级轨迹视图（时间线瀑布）— 升级 execution-observability

- **Overview 甘特条**（顶部固定）：每 turn 一条泳道，modelWait（模型等待）与
  toolWait（工具执行）分色分段，宽度=真实时长；失败/重试/被拒标记；点击定位
  ledger 行。
- **Ledger 明细**（下方虚拟化列表）：turn 分组（粗边界）+ step 内联；每行显示
  事件类型/工具名/耗时/状态；展开行显示 args/result 预览与 token 明细。
- **本地 inspector**（右侧）：选中记录的 Input / Output / Timing / Usage / 父链
  （parent_event_id 回溯）/ 关联 provider call（telemetry 行）。
- 数据源：现有 `/sessions/:id/execution-observability` + `/sessions/:id/trace`，
  增量刷新沿用 `/trace/since` 轮询模式。

### 5.2 执行拓扑图（证据图可视化）— 补最大空白

- **节点**：run_spec / task_run / session_event / tool_call_state /
  verification_record / agent_task / task_attempt（现有 7 类），按类型着色与图标。
- **边**：has_task_run / emitted_event / parent_event / depends_on / attempt_ran_as /
  attempt_verified_by / attempt_used_tool_state（现有 11 类），线型/虚线区分。
- **布局**：run_spec 根居中 → 左列 task_runs → 右列 agent_task DAG（depends_on 边），
  session_events 按时间序瀑布排列在下部；tool_call_state 与 verification 挂靠
  task_run。
- **交互**：点击节点打开该实体详情抽屉（事件 payload / 状态 / 时长）；点击边高亮
  路径；切换「时间模式」（按 parent_event 链组织）与「依赖模式」（按 depends_on 组织）。
- **渲染**：自绘 SVG（无新依赖）或引入 React Flow（评估后定）。
- 数据源：`/runs/:id/inspect`（已返回 nodes/edges/counts/warnings）。

### 5.3 模型指标与用量视图 — 升级 usage / 新增对比

- usage 页扩展：provider×model 卡片增加 **延迟趋势（P50/P95）**、错误率、
  usageFillRate、缓存命中率的小趋势图（Sparkline）。
- 新增「模型对比」视图：同一 session 内多 provider/model 切换（fallback 链）的
  turn 级延迟/成本对比；fleet 级时间窗对比（本周 vs 上周成功率/延迟/成本）。
- 数据源：`/usage/summary`（callTelemetry 已有 avgDurationMs/errorCount/usageFillRate）
  + `/diagnostics/provider-health` + `run_evals` 聚合。

### 5.4 子 agent 与工作流层级树

- Session 详情页增加「子代理树」：parent_run_spec_id 递归展开，节点显示
  child.agent.* 事件状态、耗时、token 汇总（跨 run_spec 的 usage 聚合）。
- Work 页面 run 卡片增加「运行结构」展开：task_run → agent_task → attempt →
  verification 的状态流转链。

## 6. 技术选型

| 项 | 选择 | 理由 |
| --- | --- | --- |
| 图渲染 | 评估：自绘 SVG vs @xyflow/react | 拓扑图仅 7 节点类型、节点数可控（<500），自绘 SVG 零依赖、可控性强；若需缩放平移/自动布局则用 React Flow |
| 时间线 | 自绘（CSS Grid/Flex + SVG 泳道） | DSH trajectory 即自绘；los 无图库依赖包袱 |
| 状态管理 | 沿用 TanStack Query + 轮询 | 与现有页面一致；trace/since 已有增量模式 |
| 组件 | 现有 ui.tsx（Badge/Fact/DataTable/StatusPill）+ CSS | 与 los web 现有风格一致 |
| 后端 | 现有路由复用，必要时加 1-2 个聚合端点 | 不引入新存储 |

## 7. 数据流与 API 设计

现有 API 已覆盖大部分需求，仅需少量补充：

| 端点 | 用途 | 状态 |
| --- | --- | --- |
| `GET /sessions/:id/trace`(+since) | 轨迹消息流 | ✅ 已有 |
| `GET /sessions/:id/execution-observability` | waterfall/fingerprint/facets | ✅ 已有 |
| `GET /diagnostics/:traceId` | 跨表请求轨迹 + spanTree | ✅ 已有 |
| `GET /runs/:id/inspect` | 证据图 nodes/edges | ✅ 已有（**拓扑视图主数据源**） |
| `GET /runs/:id/graph` | agent task DAG | ✅ 已有 |
| `GET /usage/summary` | 用量立方体 | ✅ 已有 |
| `GET /diagnostics/provider-health` | provider 健康 | ✅ 已有 |
| **新增** `GET /sessions/:id/subagents` | 子 agent 树（parent_run_spec_id 递归 + usage 聚合） | 待实现 |
| **新增** `GET /sessions/:id/topology`（或复用 inspect） | 会话级拓扑投影（节点-边 + turn 定位） | 评估后定 |
| **新增** `GET /metrics/trends?metric=provider_latency&window=14d` | fleet 趋势（P50/P95/错误率） | 待实现 |

**不新增存储**：全部为查询时投影，符合 DSH「模型可见即日志、视图从日志派生」原则；
los 侧等价于「视图从 session_events / telemetry 派生」。

## 8. 落地路径（阶段化）

### Phase 1 — 轨迹时间线（复用现有数据，纯前端）
- execution-observability-panel 升级：Overview 甘特 + 虚拟化 ledger + inspector。
- 会话详情页（session-inspector）接入。

### Phase 2 — 执行拓扑图
- `/runs/:id/inspect` 数据接入新页面（run-specs 页或 sessions 页入口）。
- 节点/边渲染 + 详情抽屉 + 两种组织模式。

### Phase 3 — 模型指标与 fleet 趋势
- usage 页趋势增强（P50/P95 sparkline、对比视图）。
- 新增 `/metrics/trends` 聚合端点 + 时间窗对比视图。

### Phase 4 — 子代理树与运行结构
- `/sessions/:id/subagents` 聚合端点 + 树视图。
- Work 页运行结构展开。

## 9. 与 DSH 的映射与未来迁移

| los 本方案 | DSH 对应物 |
| --- | --- |
| 会话轨迹时间线（Overview 甘特 + ledger + inspector） | ui-trajectory（conversation.view tab） |
| 子代理树 | ui-subagent（header catalog tree） |
| 运行结构树（task_run→agent_task→attempt→verification） | ui-workflow-run（run→phase→member） |
| 从 session_events 查询时投影 | render from the log / foldSurface |
| turn 分组 + 事件明细 | turn/step 两级模型 |
| 设计令牌 + CSS Modules | --dsw-alias-* + CSS Modules |

若未来 los 会话数据与 DSH 会话格式互操作（Rust 重写后的 envelope 注册式 codec），
本方案的视图组件可平移为 DSH client-plugin（conversation.view 槽位注册）。

## 10. 风险与开放问题

- [ ] 图渲染选型（自绘 SVG vs React Flow）—— Phase 2 前定。
- [ ] evidence graph 节点数上限（sessionEventsLimit=1000 截断告警已存在）——
      大会话的渲染性能策略。
- [ ] 实时性：拓扑图是否需要增量更新（现为查询时快照）。
- [ ] fingerprint 在 chat 路径常 unknown（G3 旧账）是否顺手修复。
- [ ] 子 agent usage 聚合口径（跨 run_spec 的 token/成本合并规则）。
- [ ] 数据保留与红action（payload 脱敏瀑布已存在，拓扑视图展示需遵循 visibility 字段）。
