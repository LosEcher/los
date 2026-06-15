# ADR 0007: Provider Loop First With Model Profiles

## Status

Implemented (2026-06-15). The core design described here is now the active runtime architecture. All eight sub-tasks listed below have been implemented and verified.

## Implementation Evidence

The four-layer architecture is fully materialized in the current codebase:

**Layer 1 — Stable Agent Loop:**
- `packages/agent/src/loop.ts` (425 lines) — ReAct loop, provider invocation, tool execution, session events
- `packages/agent/src/loop/phases.ts` — discover/plan/execute phase gates with B0 enforcement

**Layer 2 — Provider Adapter:**
- `packages/agent/src/providers/anthropic.ts` — Anthropic Messages API
- `packages/agent/src/providers/openai-utils.ts` — OpenAI-compatible Chat Completions  
- `packages/agent/src/providers/responses.ts` — Responses API adapter
- `packages/agent/src/providers/delta-repair.ts` — delta aggregation with PackyCode/OpenAI-compatible merge

**Layer 3 — Model Profile:**
- `packages/agent/src/model-profiles.ts` — 16-field ModelProfile with capability profile, pricing, cache policy, retry policy
- `packages/agent/src/model-settings.ts` — per-model parameter normalization

**Layer 4 — Harness and Fallback:**
- `packages/agent/src/compat-harness.ts` — compatibility harness with required gate enforcement
- `tools/compat-ci.sh` — CI gate script
- `docs/adr/0018-cli-fallback-gate.md` — CLI fallback boundary defined

**Cross-cutting:**
- `packages/agent/src/scheduler/scheduled-task-runner.ts` — goal self-check gate (B0 enforcement, 2026-06-15)
- All 8 sub-tasks listed below have corresponding `todo-seeds` entries with `status: done` and implementation evidence.

## Adoption and Rejection Criteria

The decision to build on a proprietary thin orchestration layer rather than adopt an external framework was made based on the following criteria:

| Criterion | Verdict | Evidence |
|-----------|---------|----------|
| State model ownership | **Must not** duplicate `task_runs`/`session_events` | External frameworks introduce their own state machines incompatible with los's dual ledger |
| Tool policy integration | **Must** go through `registry.ts` capability gates | Phase-tool-gate, risk-level ceiling, sandbox enforcement are los-specific |
| Provider diversity | **Must** support DeepSeek, PackyCode/OpenAI-compatible, Anthropic, others via profiles | 16-field ModelProfile handles protocol/api-shape/cache/repair differences per model |
| Audit trail fidelity | **Must** write structured session_events with trace/request linkage | External frameworks produce unstructured logs; los requires structured evidence |
| PostgreSQL-first | **Must** use single PG for state, not in-memory or framework-specific stores | All los state (task_runs, session_events, executor_nodes, memory) lives in PostgreSQL |
| Dependency surface | **Prefer** zero new runtime framework dependencies | `@los/agent` has zero external agent-framework npm dependencies |
| Sub-agent contracts | **Must** propagate run contract to children | `spawn_agent` inherits parent `runContractMetadata` including phase/verification gates |

Three frameworks were evaluated for adoption viability:

- **OpenAI Agents SDK**: Strong trace and handoffs, but its trace model is OpenAI-specific and would require a parallel persistence layer alongside los's session_events.
- **LangGraph**: Mature graph execution with state persistence, but its checkpoint/state model conflicts with los's PostgreSQL-first dual-ledger approach (run_specs + task_runs + session_events).
- **AutoGen**: Multi-agent conversation model is valuable as a reference, but its event-driven workflow assumes a different execution contract (agent-to-agent messaging rather than run-contract-driven dispatching).

None met the minimum bar: retaining los's PostgreSQL-first dual-ledger state model without introducing a parallel framework-owned persistence layer.

The patterns from these frameworks worth absorbing (tool streaming, structured handoff, graph-based planning) are implemented within los's own architecture rather than via framework adoption:
- Tool streaming: `providers/responses.ts` + `delta-repair.ts`
- Graph-based planning: `agent-task-graph.ts` + `agent-task-graph-read-model.ts`
- Verification gating: `verification-runner.ts` + `scheduler/verifier-task.ts`

## Relationship to Self-Bootstrapping Framework

This ADR's decision is the architectural precondition for the autonomous agent self-bootstrapping goal. The thin orchestration layer means los can implement Goal 闭环 (post-execution self-check), Tool 闭环 (alternative-tool routing), and Reflection 闭环 (error classification) entirely within its own execution pipe — no external framework boundaries to negotiate.

## Background

`los` 已经有自己的核心执行面：

1. `packages/agent/src/loop.ts` 负责 ReAct 循环、provider 调用、tool 执行和 session event 写入。
2. `packages/agent/src/tools/registry.ts` 负责工具注册、能力元数据、超时、重试和权限判断。
3. `packages/agent/src/scheduler.ts` 负责 task 生命周期、去重、取消和超时。
4. `packages/gateway/src/server.ts` 负责 HTTP / SSE 入口和任务编排。
5. `packages/agent/src/todos.ts` 负责计划账本，和 task_runs 分层。

外部现成框架的能力是有价值的，但它们的中心问题通常不是 los 的中心问题。

参考到的官方文档表明：

1. OpenAI Agents SDK 重点在 tools、handoffs、trace。
2. LangGraph 重点在 graph、state persistence、memory。
3. AutoGen 重点在 multi-agent conversation、event-driven workflow、distributed agents。

这些框架都能解决一部分 agent 编排问题，但它们都比 los 当前要解决的边界更宽。

框架和 CLI 参考不应该被一次性排除。更准确的约束是：不要让它们替代 los 的核心状态和证据模型；可以持续吸收它们在模型参数、工具调用、trace、sandbox、approval、harness 和恢复能力上的工程做法。

## Corrected Observation

`los` 不需要同时把 Reasonix CLI、Codex CLI 和内置 provider loop 都作为一等执行方式。

当前目标应该是：

1. 优先走 provider API 的内置 agent loop。
2. 让内置 loop 尽量按对应服务商和模型做调用优化。
3. Reasonix 的价值是 DeepSeek 调用行为参考：模型选择、effort/budget、缓存友好提示、transcript 和成本面板。
4. Codex 的价值是 coding agent 行为参考：sandbox/approval、工具边界、任务摘要和 PackyCode/OpenAI-compatible 路由经验。
5. 只有当内置 loop 无法合理复现某个关键能力时，才考虑引入 CLI runner fallback。

此外，los 必须保留自己的：

1. `task_runs` / `session_events` / `todos` 证据面。
2. PostgreSQL-first persistence。
3. capability-aware tool policy。
4. request/trace/dedupe 语义。

## Inference

如果把一个通用 tool framework 或外部 CLI runner 直接放进 `los` 核心，会出现四类重叠：

1. 它会再引入一层自己的状态机和 trace 语义，和 `task_runs` / `session_events` 重叠。
2. 它会把工具权限、重试、超时、handoff、memory 的语义重新定义一遍，和现有 registry 冲突。
3. 它会把 provider 选择、外部 CLI runner、任务调度混在同一个抽象里，后续更难拆分。
4. 它会增加第三方依赖的升级面，而 los 现在更需要稳定冻结自己的执行合同。

反过来，如果完全只靠一个通用 provider adapter，也会低估 agent loop 的实现要求：

1. 不同服务商对 tool call、reasoning、parallel tool calls、response usage、cache token、错误码和超时的语义并不一致。
2. 同一服务商的不同模型也可能需要不同 prompt shape、tool schema 严格度、repair 策略、max token、budget 和 retry 策略。
3. coding agent 的质量不只取决于模型调用，还取决于 sandbox/approval、文件补丁策略、命令执行边界、事件记录和失败恢复。
4. 没有 harness/eval 时，模型适配会变成按感觉调参，后续无法判断 DeepSeek、PackyCode/OpenAI-compatible 或其他 provider 的真实差异。

## Judgment

当前不建议把通用 agent/tool framework 或 Reasonix/Codex CLI 作为 los core runtime 依赖。

更合适的做法是：

1. 保持 `@los/agent` 作为唯一的核心编排层。
2. 继续把 provider、tool registry、scheduler、todo ledger 分开。
3. 优先补 provider/model profile：
   - provider endpoint
   - model id
   - protocol quirks
   - reasoning/effort 参数
   - cache-friendly prompt strategy
   - tool-call repair
   - usage/cost extraction
   - abort/timeout behavior
4. 只在必要时增加 thin adapter：
   - provider adapter
   - tool adapter
   - transcript importer
   - optional CLI fallback adapter
5. Reasonix/Codex 先作为参考实现或人工 fallback，不作为默认架构目标。

## Design Model

采用四层适配，而不是在 core 里直接绑定某个外部框架。

### Layer 1: Stable Agent Loop

`runAgent()` 继续只负责稳定循环：

1. build messages;
2. call provider;
3. parse model output;
4. execute approved tools;
5. append session events;
6. stop, retry, cancel, or summarize.

这层不应该包含某个具体模型的临时判断。

### Layer 2: Provider Adapter

Provider adapter 负责协议差异：

1. OpenAI-compatible Chat Completions;
2. Anthropic Messages;
3. future Responses-like APIs;
4. request/response normalization;
5. abort signal and HTTP timeout behavior.

### Layer 3: Model Profile

Model profile 负责服务商和模型级差异。建议字段包括：

1. `provider`
2. `model`
3. `apiShape`
4. `supportsTools`
5. `supportsParallelToolCalls`
6. `supportsReasoning`
7. `reasoningParam`
8. `cachePolicy`
9. `toolCallRepair`
10. `maxInputTokens`
11. `maxOutputTokens`
12. `defaultTemperature`
13. `usageMapping`
14. `costMapping`
15. `retryPolicy`
16. `knownFailurePatterns`

DeepSeek profile 应该吸收 Reasonix 可验证的模型调用经验。PackyCode/OpenAI-compatible profile 应该吸收 Codex 可验证的 coding agent 行为和 route 经验。

### Layer 4: Harness And Fallback

Harness 是模型适配的质量门，不是测试装饰。

1. compatibility harness：固定输入、工具目录、预期事件和成本/usage 断言。
2. behavior harness：coding task、read-only review、project-write patch、tool denial、timeout/cancel、malformed tool call repair。
3. route harness：配置面、有效运行面、认证面、quota/错误面分开记录。
4. fallback harness：当内置 loop 不满足某个能力时，用 Reasonix/Codex CLI 跑同一任务，比较事件和输出。

CLI fallback 的定位是应急和对照，不是默认实现。只有满足以下条件才进入 fallback：

1. provider API 缺少关键能力，且该能力短期无法在 adapter/profile 内复现；
2. fallback 的输入、cwd、权限、预算、transcript 和退出码能写入 `task_runs` / `session_events`;
3. fallback 不绕过 `toolMode`、tenant/project、dedupe 和 approval policy;
4. fallback 有退出策略：能力补回内置 loop 后可以停用。

具体 gate、事件形状、legacy `core-loop.mjs` 边界和非目标见 ADR 0018。

## Placement

这个决策应该落在：

1. `packages/agent/src/loop.ts`
2. `packages/agent/src/tools/registry.ts`
3. `packages/agent/src/scheduler.ts`
4. 后续新增的 `packages/agent/src/model-profiles/*` 或同等 provider profile 模块
5. `packages/gateway/src/server.ts`
6. `packages/agent/src/session-events.ts`
7. 后续新增的 `packages/agent/src/harness/*` 或同等 eval/compatibility 模块

## Task Split

建议把后续工作拆成五个独立任务：

1. 比较现成框架和 los 现有实现的重叠面。
2. 定义 provider/model profile 接口。
3. 对齐 Reasonix 的 DeepSeek 调用行为，但优先在 provider loop 内实现。
4. 对齐 Codex/PackyCode 的 coding agent 行为，但优先在 provider loop 内实现。
5. 把模型调用事件、usage、reasoning、工具修复和成本信息归一化写回 `session_events`。
6. 建 provider compatibility harness，作为模型适配和回归验证入口。
7. 定义 CLI fallback gate，只允许有证据、有权限边界、有退出策略的应急路径。
8. 建 framework reference watch，周期性复查 OpenAI Agents SDK、LangGraph、AutoGen、Reasonix、Codex 的可借鉴实现。

## Remaining To Verify

1. 先做一轮框架和 CLI 行为对比记录，确认哪些能力必须进入内置 loop。
2. 再用最小 provider/model profile 跑通 DeepSeek 与 PackyCode/OpenAI-compatible 路径。
3. 用 harness 证明不同模型 profile 的行为、成本、工具能力和失败路径可比较。
4. 最后再决定是否需要 CLI fallback 或 eval/tracing 层的局部第三方能力。
