# los 可观测性 vs DSH：对比分析与加强清单

> 日期：2026-08-16
> 范围：los（本仓库，PG 中心化账本 + Fastify gateway + React web）与 DSH（deepseek-harness，事件溯源 + cordis 插件 + Trajectory UI）
> 方法：源码证据 + ADR/agent notes 决策记录，双 agent 并行深挖后汇总

## 0. 摘要

两侧走的是**两条不同的可观测性路线**：

- **los = 持久化账本路线**：一切证据写入 PostgreSQL（`session_events`/`task_runs`/`run_evals`/`provider_call_telemetry`），Prometheus 端点从 DB 聚合出指标（重启不丢），Web 控制台以表格/数据页为主。强在**审计完备、跨 gateway 分布式、质量评估与成本立方**。
- **DSH = 事件溯源路线**：session 是 append-only JSONL（zstd）事件流，一切视图（stats/title/projection）都是对日志的派生折叠，GUI 有 Trajectory 时间轴。强在**精确回放、事件模型严谨、埋点隐私设计（脱敏瀑布/门控模式）**。

互相可借鉴：los 缺 DSH 的「事件类型规范化、精确回放、脱敏与隐私披露、时间轴可视化」；DSH 缺 los 的「Prometheus 端点、质量评估、用量成本立方、每日快照」。

---

## 1. 总览对比

| 维度 | los | DSH |
| --- | --- | --- |
| 事件基座 | PostgreSQL `session_events` 账本（`packages/agent/src/session-events.ts:135`） | 文件事件溯源 `session.jsonl.zstd`（`session-persistence-jsonl`，seq 连续 + 版本号 + ignorable 守卫） |
| 事件类型治理 | 文档 catalog（`docs/governance/session-event-type-catalog.md`，domain.action 10 域），**实际 ~90 个散落字符串字面量，无编译期枚举** | `SessionEventMap` 判别联合（`packages/core/session/src/types.ts`），类型系统强制；生产者/消费者矩阵文档机械化生成 |
| 模型可见面 | 无独立概念（session 即证据） | `surface` 机制：模型可见面事件与完整日志分离，`surfaceOp`(append/replace) + `sourceEventSeqs` 溯源 |
| 精确流回放 | **不支持**：ADR 0015 明确 `model.delta` 不持久化；审计重建靠 task_runs+session_events | **支持**：`assistant/chunk` 全保留（packed 行压缩 -60% 无损），崩溃恢复合成 closers |
| 实时推送 | SSE/WS + PG NOTIFY + 进程内 eventBus + outbox 双保险（`streaming/sse-routes.ts`、`event-bus.ts`） | 进程内事件火线 + `session/projection` 推送帧（单进程） |
| 会话时间线 UI | `SessionInspector`（turn 分组事件列表，12s 轮询整段重载） | `ui-trajectory`：turn-aware 台账 + Chrome-Network 风格时间轴（缩放/拖选/TTFT/decode 分解/虚拟滚动） |
| 会话统计 | `execution-observability` 投影（指纹+turn 瀑布+失败分面） | `session-stats` 折叠（turns/steps/llmMs/ttftMs/decodeMs/toolMs）+ `token-meter` |
| 指标出口 | `GET /metrics` Prometheus 文本（10 指标，DB 聚合）；无进程内 gauge/直方图 | **无 Prometheus/metrics 端点**；仅 OTLP/HTTP logs 导出（默认 DISABLED） |
| 埋点落库 | `provider_call_telemetry` 全量持久化（trace/session/status/延迟/usage/rate-limit） | 事件流即埋点源；`session-telemetry` 契约（Sink emit/flush/shutdown）→ OTel backend |
| 脱敏/隐私 | **无脱敏框架、无披露机制** | 脱敏瀑布（`sessionTelemetry/record`）+ 三模式（FULL/FEEDBACK_ONLY/DISABLED，默认关）+ 匿名 user.id + 共享披露 |
| 质量评估 | `run_evals`（pairwise A/B、experiment、rubric）+ `daily_agent_quality_snapshots` | 无等价物 |
| 用量成本 | `GET /usage/summary` L1 立方（token/cost/缓存命中），三层证据分类 L1/L2/L3 | 无成本立方（仅 token 投影） |
| 外部 agent 遥测 | **OTel bridge**（4318 摄入 Claude Code/Codex span → session_events，只入不出） | 无（hooks-claude-code/codex 为行为钩子，非遥测摄入） |
| 审计导出 | 单会话 JSON 导出 + 事件冷存储 | `/export` ZIP（含 descendants + attachments + flush 栅栏）+ `tool-session-query` 5 查询工具 |
| 决策记录 | ADR（0002/0004/0015/0037 等）+ catalog | agent notes 四象限 + **拒绝清单**（每决策带被拒方案+理由） |

---

## 2. los 现状详情（强项与缺口）

### 2.1 强项

1. **多维关联账本**：`session_events` 带 `tenant/project/user/node/request/trace_id` + `parent_event_id` + 12 索引；`request-context.ts:38` 全链路注入 `x-request-id`/`x-trace-id`（child logger 绑定并回写响应头）。
2. **多实体证据面**：`task_runs`（租约+dedupe_key）、`run_specs`（run_contract_json，AP2 落点）、`run_evals`（pairwise/experiment/rubric）、`daily_agent_quality_snapshots`（按 tenant/project/date 幂等，5 类指标 JSON）。
3. **provider 全量埋点**：`providers/telemetry.ts` 每次 fetch 记 trace/session/provider/model/endpoint/status/duration(分段 headers/body)/error/rate_limit/usage；fire-and-forget 不阻塞主路径。
4. **Prometheus 端点**：`/metrics` 10 指标全部 DB 聚合（跨重启有效），标签稳定契约化（`docs/operations/metrics.md`）。
5. **执行可观测投影**：`execution-observability.ts` 指纹（sha256：prompt/spec/memory/toolCatalog 版本散列）+ turn 瀑布（modelWait/toolWait/retries/errors/denied/tokens）+ 失败分面（provider/tool/policy/verification/context/recovery），每条带 eventIds 溯源。
6. **trace 读模型**：`contracts/session-trace.yaml` + `session-trace.ts` 把事件投影为「消息+工具调用卡片」（状态/时长/attempts），`/sessions/:id/trace` 带事件 id 高水位游标。
7. **实时推送**：SSE `/events/stream`、`/events/live`、WS `/sessions/:id/stream/ws`（stream-lease 租约）+ 事件类型化 eventBus + PG NOTIFY 跨 gateway。
8. **OTel bridge**：摄入外部 agent CLI span（`runtime-adapter/otel-bridge.ts`），映射为 session_events（`claudeSpanToEventType`），健康/状态/控制面三接口齐备。
9. **三层证据分类**：L1 los_runtime（权威）/L2 wire_inspect（预留）/L3 external_usage（仅总览），UI 强制标注 evidenceClass。
10. **事件目录治理**：catalog 注册制、PR 标记 `event-protocol-change`、60 天移除。

### 2.2 缺口（按严重度）

| # | 缺口 | 证据 |
| --- | --- | --- |
| G1 | **事件类型无统一枚举**：catalog 文档与实现脱节，~90 个散落字面量，visibility 分级是事后启发式 | `grep session.started packages/agent` 分散 30+ 文件 |
| G2 | **trace 只存不聚**：`trace_id` 无跨 session/task/provider 聚合 API/UI；`parent_event_id` 从不写 span 父子链 | `trace-routes.ts` 仅按 session 投影 |
| G3 | **无精确流回放**：`model.delta` 不持久化（ADR 0015 决策），UI 无法复现 token 级输出 | ADR 0015 |
| G4 | **回放 UI 无流式**：SessionInspector 12s 轮询整段重载，未用 `trace/since` 游标与 WS | `session-inspector.tsx` |
| G5 | **无真实图表**：全仓无 svg/canvas/chart 库，usage/evals 无趋势图、无时间序列 | `grep <svg|canvas` 0 命中 |
| G6 | **Metrics 单薄**：仅 DB 快照端点，无进程内指标（活跃会话/队列深度）、无 latency 直方图 bucket、无 exporter、deploy 无 collector/grafana | `metrics-routes.ts` |
| G7 | **无脱敏框架**：session_events payload/telemetry 无 redaction 瀑布，导出即原样 | `session-events.ts` |
| G8 | **无隐私披露/共享模式**：无 full/feedback-only/disabled 概念 | 对比 DSH 三模式 |
| G9 | **无前端埋点**：web 无 analytics/trackEvent 任何命中；无事件漏斗/留存/失败模式分析 | `grep analytics packages/web` 0 命中 |
| G10 | **审计出口弱**：仅 JSON 导出 + 冷存储；`/sessions/search` FTS 有 API 无页面 | `session-events-search.ts` |
| G11 | **logger 承诺未兑现**：`infra/logger.ts` 头注释称有 otel 适配器，实际未实现；无采样 | `logger.ts` |
| G12 | **事件安全**：payload 无大小/深度限制与脱敏写入策略（runtime.* 有 2000 字符上限，其余事件无） | `session-events.ts` |

---

## 3. DSH 现状详情（可借鉴要点）

### 3.1 事件溯源基座

- **判别联合事件类型**（`packages/core/session/src/types.ts`）：`turn/start|end|pending`、`step/start|end`、`user/message`、`assistant/chunk|message`、`tool/call|result`、`request/header|context`、`session/end-seed` + ~20 插件合并事件（`session/title`、`feedback/record`、`compaction/*`、`llm/retry`、`subagent/descriptor`…）。
- **持久化**：`session-persistence-jsonl` — zstd 分帧（header 帧 + 追加帧，checksum）、`packChunkRuns` 把连续 chunk delta 压成 packed 行（实测 -60% 且无损重建 seq/time）、崩溃时 torn frame 截断修复 + 合成 closers、append 拒绝 seq 不连续批次。
- **语义耐久点**：`session-checkpoint-policy` 在 `llm/stream` 派发前、顶层 `tools/execute` 前、`agent/pre-step` 前各设 flush 栅栏，失败 fail-closed 不派发。
- **模型可见面与日志分离**：`surfaceOp`(append/replace) + `sourceEventSeqs` 使 compaction 替换链、chunk→消息关联可溯源；replay/审计/统计「结构性免费」（追加日志 + 派生投影）。

### 3.2 埋点设计（最值得 los 学习的部分）

- **契约**：`SessionTelemetrySink`（emit 非阻塞入队 / flush 提示 / shutdown 排空），backend SDK 拥有批处理/重试/丢失策略。
- **捕获点**：`session/created`（adopt 头部）、`session/event`（投影→深拷贝→脱敏→移交，零 IO）、`session/flush`、`session/disposed`（shutdown 操作记录）、`agent/error`（唯一 ops 信号）。
- **脱敏瀑布**：`sessionTelemetry/record` 监听器栈式变换，不挂监听则原样透传；fail-closed（抛错的监听扣留单条）；只作用于外发副本，**规范日志永不重写**。
- **移交游标**：`WeakMap<Session, seq>` 记录已移交水位；接收端按 `(session.id, event.seq)` 去重；resume/fork 通过 header `parentSession`+`seedLength` 缝合，不重发。
- **chunk 投影**：每 `(turn,step)` 只发首个 `assistant/chunk`（流启动信号），TTFT 可算，seq 间隙≠丢失。
- **隐私三模式**（`session-telemetry-otel`）：`FULL`（立即上报）/`FEEDBACK_ONLY`（仅 `feedback/record` 时回放释放未上报前缀）/`DISABLED`（默认，不构造 SDK 管道）；共享披露 `sharing` 属性供 `/feedback` 确认界面展示；匿名 `user.id`（`$DSH_HOME/.anonymous-user-id`）。
- **决策记录**：每次策略调整都有 agent note（implemented 象限）+ **被拒替代方案及理由**（如「capture 时保留脱敏副本」被拒——重复无界前缀，canonical log 已拥有事件）。

### 3.3 GUI

- **Trajectory**（`packages/client/ui-trajectory`）：turn 边界粗线、step 行内标记、行级 inspector（token/时长/Input/Output/Timing）、Overview 时间轴（TTFT/decode/duration，缩放/拖选/右击平移）、虚拟滚动 + 分页加载、搜索。
- **StatsLine**（`ui-conversation`）：composer dock 处整会话 turn/step/llmMs/toolMs/ttftMs/decodeMs/decodeTokens。
- **导出**：`/export` → apiproxy 流式 ZIP（session.jsonl 原文 + subagents + attachments，live session 先 flush）。

### 3.4 DSH 缺口

1. 无 Prometheus/metrics 端点、无进程级指标。
2. 无质量评估框架（run_evals / daily snapshots 等价物）。
3. telemetry best-effort：崩溃时队列内容丢失（durable outbox 明确 deferred）。
4. `turn/pending` 无任何 GUI 呈现（排空语义模型可见但不可见 UI）。
5. 无用量/成本统计页。
6. resume 只加载不自动续跑（Step3 未实现）。

---

## 4. 埋点设计检查清单（对照表）

| 检查项 | los | DSH | 结论 |
| --- | --- | --- | --- |
| 每次模型调用全记录 | ✅ provider_call_telemetry（状态/延迟/usage/限流） | ✅ 事件流（request/header + assistant/message usage） | 相当 |
| 事件有权威枚举/契约 | ⚠️ 文档有 catalog，实现是散落字面量 | ✅ 判别联合 + 类型系统 + 矩阵文档机械化生成 | **los 需补** |
| 脱敏（redaction） | ❌ 无 | ✅ 瀑布式、fail-closed、规范日志不重写 | **los 需补** |
| 隐私披露/用户同意 | ❌ 无 | ✅ 三模式 + 默认关 + 共享披露 | **los 需补** |
| 指标端点 | ✅ Prometheus /metrics（DB 聚合） | ❌ 无 | **DSH 需补** |
| 进程内指标/直方图 | ❌ 无 | ❌ 无 | 双方需补 |
| 用量/成本立方 | ✅ L1 tokens/cost/缓存命中 | ⚠️ 仅 token 投影 | los 领先 |
| 质量评估/趋势 | ✅ run_evals + daily snapshots | ❌ 无 | los 领先 |
| 外部 agent 遥测摄入 | ✅ OTel bridge（只入） | ❌ 无 | los 领先 |
| 崩溃恢复语义 | ⚠️ outbox 双保险但无 closers | ✅ torn frame 修复 + 合成 closers | 相当 |
| 审计导出 | ⚠️ 单会话 JSON | ✅ ZIP 含 descendants/attachments | DSH 领先 |
| 查询/检索 | ⚠️ FTS API 无 UI | ✅ tool-session-query 5 工具 + SQLite FTS | DSH 领先 |
| 前端交互埋点 | ❌ 无 | ❌ 无（刻意，隐私优先） | 双方一致（无） |
| 决策记录含拒绝清单 | ⚠️ ADR 有，拒绝清单稀疏 | ✅ 每决策带被拒方案+理由 | DSH 领先 |

---

## 5. 加强清单（los ← DSH，按优先级）

### P0 — 收益最大，建议立即排期

1. **事件类型枚举化 + 机械验证**：把 ~90 个散落字面量收敛为 `SessionEventMap` 式判别联合（或 zod schema 单一真源），新增类型必须经类型系统/门禁，catalog 文档改为生成物。参照 DSH `types.ts`。
2. **trace 聚合与 span 树**：`trace_id` 打通 session_events/task_runs/provider_call_telemetry，`parent_event_id` 写入真实 span 父子链；新增 `GET /traces/:traceId` 时间线 API + Diagnostics 页展示（当前 `GET /diagnostics/:traceId` 只按 session 查 telemetry 行）。
3. **回放 UI 流式化**：SessionInspector 改用 `trace/since` 高水位游标 + WS/SSE 增量追加，去掉 12s 轮询整段重载；加播放/跳转控制（参照 Trajectory 的加载分页 + 时间轴）。
4. **写路径脱敏框架**：为 session_events payload 与 telemetry 建立 `redactPayload` 瀑布扩展点（至少：密钥模式、`runtime.*` 2000 字符上限推广到全事件、payload 大小/深度上限），fail-closed 单条扣留。参照 DSH `sessionTelemetry/record`。

### P1 — 值得做

5. **隐私三模式**：`los` 增加 telemetry 共享状态（`full`/`feedback-only`/`disabled`，默认 `disabled`），`feedback`/`run_evals.user_feedback` 可作为 `feedback-only` 释放触发器；UI 披露共享状态。参照 DSH 三模式 + sharing 属性。
6. **趋势图表**：usage/evals 页加时间序列图（轻量自绘 SVG，无外部依赖，`byDay` 数据已有）；daily-quality 页加 28 天证据窗口趋势。
7. **/metrics 扩充**：加进程内指标（活跃会话、SSE/WS 连接数、outbox 积压）、provider 延迟直方图 bucket（`le` 分位），保持 DB 聚合 + 进程级混合。
8. **model.delta 可选持久化**：评估 ADR 0015 的 4 个 promotion 条件（cross-gateway resume / UI 精确回放 / eval 时序 / provider 失败分析），任一触发则带脱敏落 `session_events`（`model.delta` 事件 + packed 压缩参照 DSH -60%）。
9. **logger 兑现或删注释**：`infra/logger.ts` 的 otel 适配器要么实现（对齐 OTel bridge），要么移除头注释避免误导。
10. **审计检索页**：`/sessions/search` FTS 已有 API，补 web 页面（关键词 + 事件类型 + 时间范围过滤）。

### P2 — 远期/按需

11. **出向遥测**：若需产品级分析，加 OTel exporter（logs 或 traces）→ collector → 后端；当前只入不出可先保持 Prometheus。
12. **前端交互埋点**：如做产品分析，先立隐私披露再埋；当前无前端埋点与 DSH 一致（隐私优先），不急于补。
13. **会话导出增强**：单会话 JSON → 支持 ZIP（含子会话/事件原文），参照 DSH `/export`。

---

## 6. 反向借鉴清单（DSH ← los）

1. **Prometheus /metrics 端点**：从会话/投影数据聚合进程级指标（活跃会话、事件吞吐、turn/pending 计数——正好可补 `turn/pending` 无 GUI 呈现的缺口）。
2. **质量评估框架**：run_evals（pairwise A/B + rubric + experiment）等价物，DSH 有 eval 基建但无持久化质量表。
3. **每日质量快照**：`daily_agent_quality_snapshots` 类趋势读模型（DSH 有 projection 机制，缺「按日期幂等快照」语义）。
4. **用量成本立方**：`/usage/summary` 等价物（token/cost/缓存命中，按 provider/model/day）。
5. **OTel bridge 摄入**：DSH 的 hooks-claude-code/codex 是行为钩子，可考虑把外部 CLI 的 OTLP span 摄入会话流（los 已有完整实现可参照）。

---

## 7. 建议路线（los 侧）

```
第一批（架构层，1-2 周量级）：
  事件类型枚举化 ──→ trace span 树 ──→ 回放 UI 流式化
第二批（数据治理）：
  写路径脱敏瀑布 ──→ 隐私三模式 + 披露
第三批（呈现/容量）：
  趋势图表 ──→ /metrics 扩充 ──→ model.delta 可选持久化（评估后）
```

每一批完成后跑 `pnpm run gate`；事件类型变更按 catalog 规则标记 `event-protocol-change`。

---

## 8. 证据索引

- los：`docs/adr/0002-session-ledger-observability.md`、`0004-web-observability-console-plan.md`、`0015-external-transcript-truncation-and-run-replay-policy.md`、`0037-daily-agent-quality-snapshots.md`；`docs/governance/session-event-type-catalog.md`；`docs/operations/metrics.md`、`otel-bridge.md`、`2026-08-09-usage-hub-design.md`；`packages/agent/src/session-events.ts`、`providers/telemetry.ts`、`execution-observability.ts`、`session-trace.ts`、`runtime-adapter/otel-bridge.ts`、`event-bus.ts`；`packages/gateway/src/routes/{data/trace-routes.ts, infrastructure/metrics-routes.ts, infrastructure/diagnostics-routes.ts, streaming/sse-routes.ts}`；`packages/web/src/pages/{sessions-page, session-inspector, execution-observability-panel, usage-page, diagnostics-page}.tsx`；`contracts/{session-trace, usage-summary}.yaml`。
- DSH：`packages/core/session/src/types.ts`（SessionEventMap）；`packages/session/session-persistence-jsonl`（format/zstd/write-behind）、`session-checkpoint-policy`、`session-telemetry`（coordinator/waterfall/cursor）、`session-telemetry-otel`（三模式）、`session-stats`、`session-projection(-cache)`、`session-query/{session-log-export, tool-session-query}`；`packages/client/ui-trajectory`、`ui-conversation/src/client/chat/StatsLine.tsx`；`docs/event-producer-consumer.md`；`.agents/notes/implemented/feature/2026-07-23-session-telemetry-otel-revival.md`、`2026-08-05-feedback-gated-session-telemetry.md`、`2026-08-10-telemetry-default-off.md`、`2026-08-07-feedback-acknowledgement-sharing-disclosure.md`。
