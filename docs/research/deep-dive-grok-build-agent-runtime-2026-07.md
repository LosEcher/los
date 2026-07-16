# Grok Build agent runtime 深度分析

> 分析日期：2026-07-16  
> 对象：`/Users/echerlos/syncthing/project/grok-build`  
> 基线：commit `c1b5909ec707c069f1d21a93917af044e71da0d7`，2026-07-15，`Publish harness and TUI open-source`  
> 版本：`0.1.220-alpha.4`  
> 方法：源码调用链追踪 + LOS 当前实现对照；未执行 Grok live agent probe

## 结论

Grok Build 最值得 LOS 学习的不是某个单独工具，而是五个彼此配合的运行时边界：session actor、typed projection、与当前上下文窗口绑定的 compaction、可暂停并反复验证的 goal、以及有 lineage 和生命周期的 subagent。

LOS 不应替换自身的 run contract、状态转换和验证门。更合适的方向是：

1. 保留 LOS native provider loop 作为默认运行时。
2. 优先修正 LOS context fill 与 semantic eviction 的接线问题。
3. 把 Grok 的 ACP stdio 作为受控 external-agent adapter 候选，而不是把 `api.x.ai` 模型调用误认为完整 Grok agent 执行。
4. 在 adapter 通过只读、写入预览、取消、重放、权限拒绝等兼容性 probe 前，保持 advisory/blocked。
5. 将 Grok Build 纳入 Tier 0 竞品监督；本地镜像 commit、版本和 changelog 是每次 sweep 的比较基线。

## 证据分级

- **[V] 已验证**：本次直接从 Grok/LOS 当前源码或已有 live 记录确认。
- **[I] 推断**：源码支持该解释，但尚未通过 live probe 验证。
- **[R] 建议**：面向 LOS 的设计判断，不表示当前已经实现。

## 1. Agent loop

### 1.1 Grok 的实现

Grok 的 session 不是一个简单的 `while (tool_calls)`。`SessionActor::run_session` 是 session 级事件循环，统一处理 command、模型切换、chat-state 更新、replay、turn completion、idle memory flush 和 notification drain。[V]

关键调用点：

- `crates/codegen/xai-grok-shell/src/session/acp_session_impl/run_loop.rs:33`：session actor 主循环。
- `crates/codegen/xai-grok-shell/src/session/acp_session_impl/notification_drain.rs:22`：`maybe_start_running_task`，保证单 session 同时只有一个前台 turn。
- `crates/codegen/xai-grok-shell/src/session/acp_session_impl/tool_calls.rs:477`：用 `FuturesUnordered` 并发调度允许并行的工具调用。
- `crates/codegen/xai-grok-shell/src/session/acp_session_impl/turn_end.rs:317`：`emit_turn_completed` 形成统一的 turn terminal event。

queued prompt 在完成或取消路径明确结束之前保留在队首，完成后再 dequeue。这避免了 cancel/completion 与下一 prompt promote 之间的竞态。[V]

turn 内部仍然是模型—工具循环，但每轮还会：

1. drain interjection、reminder、goal/monitor 更新；
2. sampling 前检查 auto-compaction；
3. 采样并处理 auth recovery 或 compact-and-resubmit；
4. 并发执行可并行工具，并按原调用索引归并结果；
5. 在无工具调用时结束 turn，通过统一 terminal event 持久化和广播。

### 1.2 与 LOS 的差异

LOS 已有稳定 provider loop、并行/串行工具边界、session events、task run 和 execution state machine。`packages/agent/src/loop/tool-runner.ts:48` 已经先 prepare，再按 capability 分批并行，并在 `:89` 恢复原调用顺序。[V]

LOS 当前缺少的是 session 级的权威运行单元：prompt queue、foreground turn ownership、replay cursor、terminal turn event 仍分布在多个路径。Grok 的经验说明，后续若要强化恢复和多入口协同，应先定义 session actor/projection contract，而不是继续往 `runAgent()` 增加分支。[R]

### 1.3 可吸收项

- [R] 建立 durable prompt queue，并明确 queued/running/completed/cancelled 的所有权。
- [R] 建立唯一 `turn.completed` terminal chokepoint，承载 usage、cancel trigger、tool outcome 和 replay cursor。
- [R] 保持 LOS AP1/AP3：session actor 只编排，状态仍通过 `transitionExecutionState()`，成功仍通过 `canMarkSucceeded()`。
- [R] 不直接移植 Grok 的大 actor；先用当前 event store 做小型、可恢复的 session coordinator。

## 2. Terminal rendering

### 2.1 Grok 的实现

Grok TUI 的关键是数据流分层，而不是 Rust 或具体样式：

```text
ACP SessionUpdate
→ AcpUpdateTracker typed state machine
→ ScrollbackState / RenderBlock
→ AppView
→ batch + frame cap + buffer diff
→ dedicated terminal writer
```

主要证据：

- `crates/codegen/xai-grok-pager/src/acp/tracker.rs:213`：`AcpUpdateTracker` 保存 message、thought、tool、compaction、retry、waiting 等 typed streaming state。
- `crates/codegen/xai-grok-pager/src/acp/tracker.rs:604`：`handle_update` 只把协议事件归约为状态，不执行网络或终端 I/O。
- `crates/codegen/xai-grok-pager/src/app/event_loop.rs:1656`：biased select，优先处理输入并批量 drain ACP firehose，避免 UI 饥饿。
- `crates/codegen/xai-grok-pager/src/app/acp_handler/mod.rs`：按 session 路由更新，区分 replay/live，并处理 viewer/driver adoption。
- `crates/codegen/xai-grok-pager-render/src/render/draw.rs`：terminal buffer diff 和同步输出。
- `crates/codegen/xai-ratatui-inline/src/scrollback.rs`：native scrollback 与 inline viewport。

这套结构允许同一事件既可 replay，又可 live stream，并通过 event ID high-water 去重。[V]

### 2.2 与 LOS 的差异

LOS CLI 仍在 `packages/cli/src/index.ts:269` 逐事件 `console.log`。Web 已有 accumulator/live tool hooks，但 `packages/web/src/chat-accumulator.ts` 已标记应迁移到 trace projection，说明统一 read model 正在形成但还未覆盖 CLI。[V]

### 2.3 可吸收项

- [R] 先定义 transport-neutral `ExecutionProjection`：message、thought、tool call、waiting reason、retry、compaction、turn terminal。
- [R] CLI 与 Web 共用 projection reducer；CLI 只负责把 projection render 成文本。
- [R] replay/live 使用相同 event identity 和 high-water 规则。
- [R] 对高频 delta 批处理并设 frame cap；不要让每个 token 都触发完整 render。
- [R] 不直接复制 Grok TUI。LOS 当前收益最高的是 typed projection 和 replay correctness，而不是 terminal widgets。

## 3. Compaction

### 3.1 Grok 的实现

Grok 默认在当前 conversation 估算 token 达到模型 context window 的 85% 时自动压缩。阈值定义见 `crates/common/xai-grok-compaction/src/code_compaction/config.rs:13`，用户文档见 `crates/codegen/xai-grok-pager/docs/user-guide/04-slash-commands.md:43`。[V]

其 compaction 不是单一路径：

- sampling 前主动检查：`crates/codegen/xai-grok-shell/src/session/compaction.rs:1764`。
- manual/auto 共用 `run_compact_inner`：`crates/codegen/xai-grok-shell/src/session/compaction.rs:811`。
- `PreCompact` hook：`crates/codegen/xai-grok-shell/src/session/compaction.rs:857`。
- deterministic failure suppression 与 sticky/per-turn suppression：同文件 `:647` 之后。
- context overflow 后 compact-and-resubmit：sampler turn 的错误恢复路径。
- compaction checkpoint 可持久化，并进入 rewind/replay。
- 在真正 compaction 之前，请求构建器已经会淘汰旧 tool result/image，避免把 full summary 当第一防线。

common compaction crate 还区分 intra/inter compaction、LLM full-replace、deterministic filtering/soft trimming。[V]

### 3.2 LOS 当前风险

#### P0：context fill 可能重复累计历史 prompt

`packages/agent/src/context-monitor.ts:128` 每轮累加 `promptTokens`，再在 `:133` 加上累计 completion。多数 chat provider 返回的当轮 `promptTokens` 已包含本次请求中的完整历史；跨轮求和会重复计算旧上下文，因此可能过早进入 checkpoint/critical。[I]

需要用 provider fixture 证明各 provider usage 语义，再决定采用“最新 prompt + 当前 completion/预留”还是 tokenizer 估算，不能直接假设所有 provider 相同。[R]

#### P0：semantic eviction 的持久位置可能没有接上

`packages/agent/src/loop.ts:207` 只在 tool message 带 `observation_id` 时建立 persisted location；但 `packages/agent/src/loop/tool-runner.ts:93` 生成的 tool message 只有 `role/content/tool_call_id`。因此 critical callback 中的 persisted location 大概率为空，semantic eviction 可能退化为不替换。[V：字段不匹配；I：live 影响范围]

#### P1：压缩缺少 attempt/checkpoint/resubmit 协议

`packages/agent/src/loop/compression.ts:19` 是确定性的字符串摘要/裁剪，`packages/agent/src/loop.ts:472` 只在消息数下降时替换。它没有 LLM summary、compaction attempt event、checkpoint、失败抑制、Pre/PostCompact 或 overflow resubmit。[V]

### 3.3 建议顺序

1. [R] P0：修正 context fill 真值，并增加 provider usage fixture。
2. [R] P0：让 tool result 显式携带可验证的 persisted location，增加“critical eviction 实际缩短大结果”的 focused test。
3. [R] P1：引入 `compaction.attempted/completed/failed/suppressed` 与 checkpoint，支持一次 bounded compact-resubmit。
4. [R] P2：有真实质量数据后，再评估 LLM full-replace 和 two-pass prefire。

## 4. Goals

### 4.1 Grok 的实现

Grok goal 是持久状态机，而不是 prompt 上的一个字符串：

- `GoalPhase`：Idle / Planning / Executing。
- `GoalStatus`：Active、UserPaused、BackOffPaused、NoProgressPaused、InfraPaused、Blocked、BudgetLimited、Complete。
- 未知持久状态恢复为 UserPaused，避免旧客户端把未知自治状态恢复成 Active。

证据见 `crates/codegen/xai-grok-shell/src/session/goal_tracker.rs:31`。[V]

模型通过 `update_goal` 提交 progress、blocked 或 completed。`completed: true` 不会直接完成：turn-end 才启动 verifier/skeptic；mid-turn completion 会先 defer，避免验证子代理与主模型并发。`crates/codegen/xai-grok-shell/src/session/acp_session_impl/goal.rs` 记录了该 drain 语义。[V]

额外保护包括：

- classifier run cap 和 in-flight guard；
- verifier gap fingerprint，连续无进展后暂停；
- blocked 连续报告 3 次后才进入 Blocked；
- goal token budget 包含父子 agent；
- stop detector 识别“停止、等待其他 agent、ready for review”等提前收尾信号；
- continuation directive 每轮只保留一份，避免 prompt 膨胀。

### 4.2 与 LOS 的差异

LOS 强项是 durable run contract、approved plan、verification record 和 AP3 success gate。Grok 强项是长时间 goal execution 中的暂停原因、budget/no-progress 控制、验证拒绝后继续执行。[V]

LOS 不应把 Grok 的 stop regex 变成成功真值。它适合作为 `premature_completion_candidate` eval signal；真正成功仍必须由 verification record 和 `canMarkSucceeded()` 决定。[R]

### 4.3 可吸收项

- [R] 增加 goal attempt、verification rejection、pause reason 和 verifier gap fingerprint 事件。
- [R] 验证失败后创建 plan revision/task attempt，而不是在一次 opaque `runAgent()` 中无限循环。
- [R] continuation 必须 bounded：run cap、token budget、no-progress 和 infra pause 都要可观察。
- [R] 未识别的 persisted autonomous status 恢复为 paused，而不是 active。

## 5. Subagents

### 5.1 Grok 的实现

Grok 的 `task` tool 把子代理当成有生命周期的 child session。协议和运行时包含：child UUID、parent session/prompt、foreground/background、resume、cwd、capability、isolation/worktree、model/reasoning/persona override、surface completion 和 fork context。[V]

关键证据：

- `crates/codegen/xai-grok-shell/src/agent/subagent/handle_request.rs:95`：foreground/background 决策。
- 同文件 `:183`：`resume_from`。
- 同文件 `:405`：最大子代理深度门。
- 同文件 `:420`：fork context。
- `crates/codegen/xai-grok-subagent-resolution/src/types.rs:14`：runtime override、capability、isolation 与 resume identity。
- `crates/codegen/xai-grok-subagent-resolution/src/context.rs:14`：仅保留最近 3 个完整 turn 原文，更早内容做 metadata summary。

fork normalization 还会去除 parent 的 system reminder、git/project layout、attached files 和 skill body；child task prompt 最后注入，保留 recency。[V]

### 5.2 与 LOS 的差异

LOS `packages/agent/src/tools/core/agent-tools.ts:100` 当前同步等待 child `runAgent()`；child 有独立 session ID、1–12 loop 限额、read-only/project-write 工具模式，并继承 clone 后的 run contract、trace/request/runSpec。[V]

当前缺口是：

- 无 background/query/kill/resume；
- 无 parent context normalization；
- 无 durable child run-spec/task-attempt lineage；
- child completion 只返回 JSON tool text；
- parent cancel 与 background survival 没有显式协议。

### 5.3 可吸收项

- [R] 先补 child lineage、attempt 和 completion event，再补 background lifecycle。
- [R] capability mode 与 isolation mode 分开表达，避免把“能做什么”和“在哪里做”混在一起。
- [R] 建立 context handoff normalizer，保留最近 turn 与证据索引，去除重复 system/skill 文本。
- [R] background agent 必须有 query/kill/timeout/parent-cancel policy，不能只是不等待 Promise。

## 6. LOS 调用 xAI agent 的三条路径

### 6.1 路径 A：LOS native loop + `api.x.ai/v1`

LOS 当前 xAI profile 是 OpenAI-compatible provider；默认 endpoint 在 `packages/infra/src/provider-defaults.ts:23`，OAuth credential 最终仍返回 inference `baseUrl`，模型 aliases 在 `packages/agent/src/model-profiles.ts:257`。[V]

这条路径调用的是 xAI 模型，不是 Grok Build 的完整 session actor、goal、compaction 和 subagent runtime。[V]

已有 live 证据表明 `grok-4.3/read-context` 返回 0 tool calls，见 `docs/governance/2026-07-10-remediation-task-dag-and-ownership.md:337`。因此当前保持 blocked 是正确的，不能只换 model slug 就宣称 agent compatibility。[V]

### 6.2 路径 B：Grok session token + cli-chat-proxy

Grok 源码区分 session auth 与 external API key：

- session auth 路由 `https://cli-chat-proxy.grok.com/v1`；
- external API key 路由 `https://api.x.ai/v1`；
- proxy 请求携带 `X-XAI-Token-Auth: xai-grok-cli`、`x-grok-client-version` 和 `x-grok-model-override`；
- `crates/codegen/xai-grok-models/default_models.json:15` 标记 `grok-build` 为 `supported_in_api: false`。

相关断言集中在 `crates/codegen/xai-grok-shell/src/agent/config.rs:7367` 和 `:7382`。[V]

这可能解释 LOS 当前 OAuth/profile 与 Grok CLI 行为不一致，但尚未做 live proxy probe，因此只能作为调查假设，不能直接改 endpoint 或复制 session token。[I]

### 6.3 路径 C：`grok agent stdio` ACP adapter

Grok 官方源码文档把 stdio 定义为主要集成模式：`crates/codegen/xai-grok-pager/docs/user-guide/15-agent-mode.md:21`。它通过 JSON-RPC 提供 `session/new`、`session/load`、`session/prompt`，并 stream `agent_message_chunk`、`agent_thought_chunk`、`tool_call`、`tool_call_update` 和 `plan`。[V]

这是调用完整 Grok agent runtime 的最稳定边界，也是 LOS 的首选候选路径。[R]

adapter 需要映射：

```text
ACP session              → LOS run_spec + task_run lineage
ACP session/update       → LOS session_events + execution projection
ACP permission request   → LOS tool policy / operator approval
cwd + tool allowlist      → RunContract editable surfaces / capability policy
cancel + process exit     → task attempt terminal outcome
artifacts + stderr        → redacted evidence records
```

首次执行属于新的 stateful/cross-package tool，仍需 operator consent。最低兼容性门：

1. `read-context`：必须产生预期只读工具事件和 durable result。
2. `patch-preview`：默认不自动批准写入，能展示并拒绝 patch。
3. cancel/timeout：父 run 能终止子进程并得到明确 terminal event。
4. replay/load：重复载入不重复写入 event。
5. permission-deny：拒绝后 agent 不得绕过 LOS policy。
6. redaction：token、原始 session auth 和未经结构化的 transcript 不进入版本库。

## 7. 建议优先级

| 优先级 | 工作 | 原因 | 验证门 |
|---|---|---|---|
| P0 | 修正 context fill 计量 | 可能导致过早 critical/compaction | provider usage fixtures + threshold test |
| P0 | 证明 semantic eviction 已接线 | 当前 tool message 缺少 persisted location | 大 tool result focused test |
| P1 | 统一 execution projection | CLI/Web/replay 解释逻辑仍分散 | replay/live 同一 fixture |
| P1 | compaction attempt/checkpoint/resubmit | 当前只有字符串裁剪 | overflow + deterministic failure tests |
| P1 | Grok ACP read-only spike | 验证完整 agent 执行边界 | read-context/cancel/deny |
| P2 | goal continuation 状态与 gap fingerprint | 提升长任务恢复与反提前停止 | bounded continuation eval |
| P2 | durable subagent lifecycle | 支持 background/resume/lineage | parent cancel + child replay tests |

## 8. 竞品监督基线

Grok Build 进入 Tier 0，原因是它同时覆盖 LOS 的核心 loop、compaction、goal、subagent、terminal projection，并提供 xAI 完整 agent runtime 的公开集成边界。[R]

每次周期 sweep 至少记录：

- 本地镜像 HEAD、commit 日期和版本；
- `crates/codegen/xai-grok-shell/CHANGELOG.md` 新增条目；
- `run_loop.rs`、`compaction.rs`、`goal_tracker.rs`、`agent/subagent/` 的行为变化；
- ACP agent mode 与 permission/replay extension 变化；
- `default_models.json` 的 model、context window、`supported_in_api` 变化；
- cli-chat-proxy 与 api.x.ai 路由/headers 变化；
- 对 LOS P0/P1 建议是否仍成立，以及是否已有回归测试覆盖。

当前自动化缺口：LOS 策略文档规划了 `competitive_snapshot`，但当前 `SEED_JOBS` 没有该 job，cadence schema 也不支持 monthly。因此本次只更新 structured reference-watch 和监督策略，不把“计划周期关注”描述为“已经自动运行”。[V]

## 9. 未验证事项

- 未运行 `grok agent stdio`，ACP 行为来自源码与文档，尚无 LOS adapter live evidence。
- 未使用 Grok session token 请求 cli-chat-proxy；路由差异尚未证明是 LOS 0 tool calls 的根因。
- 未验证 Grok 当前服务端是否允许第三方 client 复用全部 extension methods。
- 未测量 Grok compaction 的摘要质量、token 节省或任务成功率。
- 未修改 LOS runtime；本报告中的 P0 风险需要独立任务、fixture 和窄测试确认。
