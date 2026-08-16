# Agent/LLM 可视化与可观测性项目调研报告

> 调研日期：2026-08-16 · 调研员会话：4c33c383-97ae-40db-ae71-3633fc4ea178
> 目的：为「自建 agent 执行可视化方案」收集具体可借鉴的 UI 模式与数据模型细节
> 方法：web_search 逐项目查证；查不到即标注「未查到」，不编造细节

## 1. 逐项目调研

### 1.1 Langfuse（开源、可自托管）

- **定位**：LLM 应用的全栈可观测平台（trace + 评估 + 成本）。
- **核心可视化形态**：trace 列表 → trace 详情页（trace→observation 嵌套树 + waterfall 时间轴）；session 分组视图；Dashboard 用量/成本图表。
- **数据模型关键点**：Trace 为根，挂三类 observation——**span**（代码块/工具调用等）、**generation**（LLM 调用，含 input/output/usage）、**event**（日志点）；三者任意嵌套（span 内嵌 generation）；session 为 trace 的逻辑分组；token/cost 按 usage 统一计费单位（billable units）核算。
- **最值得借鉴**：
  1. 四层模型（trace/span/generation/event）克制清晰，generation 专门承载 LLM I/O+usage；
  2. session 将多次 trace 串成「对话→会话→请求」三级导航；
  3. 成本=模型单价×usage 派生，直接进 trace 详情展示。

### 1.2 AgentOps

- **定位**：agent 监控/回放/成本追踪平台（SaaS，SDK 自动插桩）。
- **核心可视化形态**：会话列表（session overview）→ 会话详情事件流；agent 关系图（agent graph）；Dashboard（成本/性能/基准）。
- **数据模型关键点**：session → events（LLM/工具/agent 动作），SDK 统一 schema 覆盖 CrewAI/LangChain/AutoGen 等框架。
- **最值得借鉴**：
  1. session 为第一导航层级，事件流按时间回放；
  2. 跨框架统一事件 schema 自动采集，插桩成本低。
  - 注：官方文档中「time-travel debug/session replay」的具体交互细节未查到权威页面，仅见 dashboard/session overview 文档（[docs.agentops.ai/v2/usage/dashboard-info](https://docs.agentops.ai/v2/usage/dashboard-info)、[v1 session overview](https://docs.agentops.ai/v1/introduction#session-overview)）。

### 1.3 Arize Phoenix（开源）

- **定位**：开源 LLM 可观测 + 评估平台，可 notebook 内嵌启动。
- **核心可视化形态**：project → traces 列表（支持根 span 过滤）→ trace 详情（span 树 + 时间线）；span 面板展示 I/O/属性/usage；evals 结果作为 annotation/feedback 直接挂到 trace/span 上。
- **数据模型关键点**：OpenInference/OTel 兼容的 trace→span；prompt/completion/usage 落 span 属性。
- **最值得借鉴**：
  1. evals 与 trace 同一 UI 闭环（跑完评估立即在 span 上标注），多数工具缺失；
  2. notebook-first 启动降低接入门槛；
  3. span 可下载导出 + 实验对比图表（[release notes](https://arize.com/docs/phoenix/release-notes/07-2026/07-28-2026-experiment-charts-span-downloads-and-root-span-filters)）。

### 1.4 OpenTelemetry GenAI 语义约定

- **定位**：跨厂商的 LLM/agent 追踪标准，定义 span 语义与属性命名。
- **数据模型关键点**：`gen_ai.*` 属性族——`gen_ai.operation.name`、`gen_ai.system`、`gen_ai.request.model`、`gen_ai.usage.input_tokens/output_tokens` 等；prompt/completion 可放属性也可放事件（体积权衡）；span 命名规范（`{operation.name} {system}` 形式）；仓库已新增 **agent span 约定**（[gen-ai-agent-spans.md](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-agent-spans.md)，含 agent 步骤/迭代维度，具体属性名未逐条验证）。
- **最值得借鉴**：
  1. system/operation/model/usage 分层属性直接可抄，保证多 provider 数据可比；
  2. 内容入属性 vs 事件的取舍（控制 trace 体积）；
  3. agent 层约定是自建模型对齐的坐标。

### 1.5 evilmartians/agent-prism

- **定位**：渲染 AI agent trace 的 React 组件库（开源）。
- **核心可视化形态**：开箱即用的 trace 可视化组件集（trace 树/消息/工具调用列表等，具体组件名未逐条验证）；输入数据契约独立为 `@evilmartians/agent-prism-types` 包。
- **数据模型关键点**：以 trace item 数组为输入，README 演示与 Vercel AI SDK 等 trace 数据对接。
- **最值得借鉴**：
  1. 数据格式包与渲染组件拆分，输入契约清晰可测；
  2. 组件库形态适合自建 UI 直接复用（trace 树、消息气泡不用自研）；
  3. 定位「调试快」——聚焦可读性而非堆指标。

### 1.6 CHATS-lab/VibeLens

- **定位**：可视化 Claude Code/Codex/Gemini CLI/OpenClaw 会话 + dashboard 分析 + 个性化建议。
- **核心可视化形态**：会话可视化（解析 CLI 会话 transcript）；dashboard 分析维度（使用统计、生产力 tips）。
- **数据模型关键点**：解析各 CLI 会话 JSONL transcript 为统一视图——**零侵入**（不插桩）。
- **最值得借鉴**：
  1. 「读 transcript 而非插桩」路线，已有 agent 立即可视化，适合快速原型；
  2. 从真实交互提炼 actionable 建议（观测→建议）；
  3. 多 CLI transcript 解析经验可直接借鉴。

### 1.7 idvxlab/VibeTrace

- 仅检索到仓库页（[github.com/idvxlab/VibeTrace](https://github.com/idvxlab/VibeTrace)），README 细节**未查到**；从命名推断为 agent 轨迹可视化，具体形态待进一步查证。

### 1.8 Honeycomb Agent Timeline

- **定位**：以「agent 时间线」为第一视角的 agent 可观测视图（已 GA）。
- **核心可视化形态**：Agent Timeline——agent/session 作为泳道，span 按时间横向排布（「flight recorder」心智，可回放一段执行）；配套 OTel Collector 配置（[jessitron/claude-collector](https://github.com/jessitron/claude-collector)）把 Claude Code 原始遥测整形为 span。
- **数据模型关键点**：span 按 agent/session 分组渲染为时间线泳道；原始 CLI 日志需经 collector 整形为 span。
- **最值得借鉴**：
  1. 「agent 泳道时间线」替代纯 trace 树，适合并发多 agent/多会话对比；
  2. 数据整形（原始 CLI 日志→span）是可视化的前置工程，需单独设计；
  3. 时间线可回放 = 执行记录事件化。

### 补充发现（辅助搜索）

- `widescope`（[github.com/soumendrak/widescope](https://github.com/soumendrak/widescope)）：Rust/WASM 浏览器内 trace viewer；
- `agentcanvas`（[github.com/vstorm-co/agentcanvas](https://github.com/vstorm-co/agentcanvas)）：Logfire traces → 交互 HTML 图，含工具/嵌套子代理/token 与精确成本；
- `patoles/agent-flow`（[github.com/patoles/agent-flow](https://github.com/patoles/agent-flow)）：Claude Code 编排实时可视化；
- `tracesage`（[pypi.org/project/tracesage](https://pypi.org/project/tracesage/)）：本地优先 LangGraph 观测。

## 2. 横向对比矩阵

| 项目 | Trace树 | 时间线 | 关系图 | 成本 | 回放 | 自托管 | 协议 |
|---|---|---|---|---|---|---|---|
| Langfuse | ✅ | ✅ waterfall | ❌ | ✅ | △(历史浏览) | ✅ | SDK/OTel |
| AgentOps | ✅ | ✅ | ✅ | ✅ | ✅(宣传,细节未查到) | ❌(SaaS) | SDK |
| Phoenix | ✅ | ✅ | ❌ | ✅ | △(notebook) | ✅ | OTel/OpenInference |
| OTel GenAI | —(数据层) | — | — | ✅(usage) | — | — | OTLP |
| agent-prism | ✅(组件) | △(列表) | ❌ | 未查到 | ❌ | ✅(组件库) | 纯数据输入 |
| VibeLens | △(会话视图) | ✅ | ❌ | 未查到 | ✅(会话可视化) | ✅ | 读 CLI JSONL |
| VibeTrace | 未查到 | 未查到 | 未查到 | 未查到 | 未查到 | ✅ | 未查到 |
| Honeycomb | ❌ | ✅ 泳道 | △ | ✅ | ✅ flight recorder | ❌(SaaS) | OTel |

## 3. 自建 agent 可视化的可借鉴清单

### UI 形态

1. Trace 树 + waterfall 双视图联动（点树节点高亮时间轴段）——Langfuse/Phoenix
2. 详情侧栏：span 的 prompt/completion/工具 I/O/usage/error 一屏展开
3. Agent 泳道时间线（多 agent/多会话并发对比）——Honeycomb
4. Session 分组导航：对话→会话→请求三级
5. Evals 标注直接上 trace（annotation/feedback 徽标）——Phoenix
6. 成本徽标：token+cost 落在 span 上——Langfuse
7. 回放控制条（step 前进/后退/跳事件点）
8. Trace 导出 + 实验对比图表

### 数据模型

1. Trace(根)→Observation{span/generation/event} 四类嵌套，避免过度建模
2. generation 专用于 LLM 调用（input/output/usage/模型元数据）
3. session 作 trace 分组键，跨请求串会话
4. 对齐 OTel `gen_ai.*`：system/operation.name/request.model/usage.*
5. usage 统一 billable unit 记账，成本=单价×用量派生
6. 事件流 append-only、UI 视图派生（回放/审计免费）——与事件溯源架构天然契合
7. transcript(JSONL) 作为零侵入回放源（VibeLens/collector 路线）

### 交互模式

1. 时间轴缩放 + 悬停高亮 + 点击下钻
2. 过滤：按根 span/错误/模型/成本排序过滤——Phoenix
3. 多会话泳道并排对比
4. trace→span→属性三跳下钻，避免长列表滚动
5. 评估闭环：跑完即见标注，同视图迭代

## 4. 来源 URL

- Langfuse：[数据模型](https://js-sdk-v3.docs-snapshot.langfuse.com/docs/observability/data-model/) · [自托管指南](https://dev.to/jangwook_kim_e31e7291ad98/langfuse-v3-self-hosting-complete-guide-building-llm-tracing-on-your-own-infrastructure-406i) · [成本追踪](https://langfuse.com.cn/docs/observability/features/token-and-cost-tracking) · [UI 导航](https://support.dropsolid.io/user-guides/ai-gateway-user-guides/observability-traceability-langfuse/dashboard-how-to-navigate-in-langfuse-ui/)
- AgentOps：[Dashboard](https://docs.agentops.ai/v2/usage/dashboard-info) · [Session overview](https://docs.agentops.ai/v1/introduction#session-overview) · [GitHub SDK](https://github.com/AgentOps-AI/agentops) · [AutoGen 集成](https://microsoft.github.io/autogen/0.2/docs/ecosystem/agentops/)
- Phoenix：[Tracing Tutorial](https://arize.com/docs/phoenix/tracing/tutorial) · [Traces 上跑 Evals](https://arize.com/docs/phoenix/tracing/how-to-tracing/feedback-and-annotations/evaluating-phoenix-traces) · [Release notes](https://arize.com/docs/phoenix/release-notes/07-2026/07-28-2026-experiment-charts-span-downloads-and-root-span-filters)
- OTel：[gen-ai-spans.md](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-spans.md) · [gen-ai-agent-spans.md](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-agent-spans.md) · [agentpatterns 标准](https://github.com/agentpatterns-ai/website/blob/main/standards/opentelemetry-agent-observability.md)
- agent-prism：[GitHub](https://github.com/evilmartians/agent-prism) · [types 包](https://www.npmjs.com/package/@evilmartians/agent-prism-types) · [Evil Martians 博客](https://evilmartians.com/chronicles/debug-ai-fast-agent-prism-open-source-library-visualize-agent-traces)
- VibeLens：[GitHub/README](https://github.com/CHATS-lab/VibeLens/blob/main/README.md)
- VibeTrace：[GitHub](https://github.com/idvxlab/VibeTrace)
- Honeycomb：[Agent Timeline 产品页](https://www.honeycomb.io/platform/agent-timeline) · [Docs](https://docs.honeycomb.io/investigate/observe/agent-timeline) · [实践 OTel 指南](https://www.honeycomb.io/blog/instrumenting-ai-agents-agent-timeline-opentelemetry-guide) · [claude-collector](https://github.com/jessitron/claude-collector)
- 补充：[widescope](https://github.com/soumendrak/widescope) · [agentcanvas](https://github.com/vstorm-co/agentcanvas) · [agent-flow](https://github.com/patoles/agent-flow) · [tracesage](https://pypi.org/project/tracesage/)

## 5. 诚实声明

以下 4 处无法验证的细节已如实标注「未查到/未逐条验证」，未编造：

1. AgentOps 的 time-travel/session replay 具体交互细节（仅见 dashboard/session overview 文档页）；
2. agent-prism 的具体组件清单（仅见仓库定位描述与独立 types 包）；
3. VibeTrace 的轨迹可视化形态（仅检索到仓库页）；
4. OTel gen-ai-agent-spans 的逐属性名（仅确认该约定文件存在）。
