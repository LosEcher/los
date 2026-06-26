# ADR 0024: Tool-Call / Protocol Repair Pipeline

## Status

Steps 1–3 + 2 (the universal stages) implemented and verified (2026-06-26).
Step 5 (reasoning round-trip) verified as a **non-issue** for los's current
default model — see Open Question 1. Step 6 scavenge dropped (DeepSeek-R1 not
used; operator confirmed 2026-06-26 everything is v4-pro/v4-flash). Step 6
flatten and step 4 (wire fixtures) remain open, low priority. Where this ADR
and the implementation disagree, the implementation is runtime truth.

## Implementation Evidence (Steps 1–3 + 2)

- `packages/agent/src/providers/repair/healing.ts` — `fixToolCallPairing()`
  drops unpaired assistant tool_call messages + orphan tool messages before
  send. Universal (all profiles). Counter `unpaired_tool_call_dropped` via
  `repair-telemetry`. (Steps 1 + 3.)
- `packages/agent/src/providers/repair/storm.ts` — `StormBreaker` class.
  Window 6 / threshold 3 (tunable via `LOS_STORM_WINDOW` / `LOS_STORM_THRESHOLD`);
  mutating calls (`sideEffect: true`) clear prior read-only entries; suppressed
  calls dropped from dispatch + assistant message so pairing holds. Counter
  `storm_suppressed`. (Step 2.)
- `packages/agent/src/providers/repair-pipeline.ts` — `healBeforeSend()`
  orchestration (in-place mutation, los convention) + `repairToolCalls()`
  running storm breaking (scavenge / truncation-philosophy placeholder for
  later steps).
- `packages/agent/src/loop.ts` — `healBeforeSend` before both `provider.chat()`
  call sites; `StormBreaker` constructed per `runAgent` call (one user turn);
  `repairToolCalls(res.toolCalls, repairCtx)` after each response, with
  `repaired.calls` used for the assistant message, `runToolCalls`, and turn
  summary. Exit check unchanged (`res.toolCalls.length === 0`) so all-suppressed
  turns continue the loop rather than exit.
- Tests: `repair/healing.test.ts` (8), `repair/storm.test.ts` (9) — all pass.
  Existing provider/loop suites (50) unaffected: 59/59 pass.
- Verification: `tsc --noEmit` clean for new files (one pre-existing unrelated
  error in `governance-jobs.test.ts`); `check-structure.sh` and
  `check-unwired-exports.sh` clean (loop.ts 506 lines is pre-existing
  grandfathered).

Open Question 2 resolved: los's `ToolRegistry` already carries `sideEffect:
boolean` (`tools/core/registry.ts`, `loop/tool-resolver.ts`
`READ_ONLY_BUILTIN_TOOLS`) — storm's `isMutating` maps to `sideEffect: true`,
so step 2 (storm) is unblocked.

Reference implementation studied: `/Users/echerlos/syncthing/project/DeepSeek-Reasonix`
(`src/repair/`, `src/loop/healing.ts`, `src/loop/streaming.ts`,
`src/loop/dispatch.ts`, `src/loop/reasoning-retention.ts`). Reasonix is
DeepSeek-only and couples to one backend by design; los adapts the *pipeline
shape*, not the coupling.

## Context

los 已有声明式 `ModelProfile`（ADR 0007）和一批散装的 protocol repair 函数，
但 repair 逻辑分散在多个 provider 文件里，没有统一入口和执行时序。对比
Reasonix 的四阶段 repair 管线（healing / scavenge / truncation / storm），
los 在 **streaming delta 合并** 和 **finish_reason 归一** 上更鲁棒，但在
**请求前 healing** 和 **响应后 repair 编排** 两块有结构性缺口。

历史协议层 bug（DeepSeek idle loop、PackyCode phantom `call_1`、DeepSeek
malformed args、orphan tool call）目前是 bug-by-bug 修补的。本 ADR 的目标
是把散装 repair 组织成一条可测试、可插拔、profile-gated 的管线，使下一个
协议层 bug 要么被某阶段修复，要么被 wire 级 fixture 拦住，而不是再写一条
if-branch 补丁。

## Decision

引入一个 repair 编排层，把现有散装函数组织成五阶段形状，并关闭四个缺口。
**不照搬 Reasonix 的硬编码**——所有 repair 阶段必须通过 `ModelProfile`
gate，守住 ADR 0007 确立的"加厂商不改 repair 代码"的线。

核心动作四件：

1. **管线形状**：新建 `packages/agent/src/providers/repair-pipeline.ts`
   编排层，把现有 `delta-repair.ts` / `openai-utils.ts` / `index.ts` 流末
   repair 接成统一的 pre-send heal → stream buffer → post-response repair
   → pre-dispatch storm → dispatch 时序。
2. **四个缺口**：补 storm（通用）、fixToolCallPairing（通用）、reasoning
   retention（profile-gated）、scavenge + flatten（DeepSeek-only，按需）。
3. **Profile gate**：新阶段一律读 `ModelProfile`（`supportsReasoning`、
   `reasoningParam`、`knownFailurePatterns`），禁止 `if (model === '...')`。
4. **Wire 级回归网**：把 `session-trace-fixtures.ts` 的 golden 模式下沉到
   协议层，新建 SSE chunk → expected `ToolCall[]` fixture 集，按 profile
   参数化。

## Current State (Pre-ADR)

los 已有的 protocol-layer repair，全部集中在 `packages/agent/src/providers/`：

| 能力 | 位置 | 说明 |
|---|---|---|
| Streaming delta 合并 | `providers/delta-repair.ts` `mergeToolCallDeltas` / `mergeSplitToolCalls` | 按 index + id fallback，处理 PackyCode index quirk 和 split tool call。比 Reasonix 更鲁棒 |
| Malformed args 修复 | `providers/openai-utils.ts` `repairJson` / `repairToolCallArguments` | fences / trailing-commas / bracket-balance / unquoted keys |
| Phantom tool call 检测 | `providers/index.ts` 流末 | 空 name/args 告警 + `incrementRepairCounter('phantom_tool_call')` |
| finish_reason 归一 | `providers/types.ts` `normalizeFinishReason` | 跨厂商 stop 词汇统一 |
| Truncation 继续 | `loop.ts` `finishReason==='length'` 分支 | 不收尾、记 `truncated_response`、继续循环 |
| Orphan tool call 检测 | `session-trace.ts` `validateTraceCompleteness` | 事件层检测无 result 的 tool.call，**仅检测不修复** |
| Repair telemetry | `providers/repair-telemetry.ts` `incrementRepairCounter` | 经 `GET /diagnostics/provider-health` 暴露 |
| Parallel tool dispatch | `loop/tool-runner.ts` | 按 side-effect 边界分批，read-only 并发，mutating 前 flush |
| Golden trace（事件层） | `session-trace-fixtures.ts` + `session-trace.test.ts` | 会话事件层 fixture，非 wire 层 |

缺口（对照 Reasonix 四阶段 + flatten + reasoning retention）：

| 缺口 | 通用 / 厂商专属 | los 现状 |
|---|---|---|
| fixToolCallPairing + stampMissingIds（请求前） | 通用 | 缺（仅事件层检测，不请求前修复 → 400 风险） |
| shrinkOversizedToolResults / args（请求前） | 通用 | 缺 |
| reasoningRetention + 空 reasoning 防 400 | 字段 per-vendor，模式通用 | 缺（`loop.ts` 根本不写回 reasoningContent） |
| Scavenge（响应后回收泄漏 JSON） | R1 leak 厂商专属，裸 JSON 回收通用 | 完全缺 |
| Storm breaker（重复抑制） | 通用 | 完全缺 |
| Schema flatten（DeepSeek 丢深 schema） | DeepSeek 专属 | 缺（deferred-registry 是 context 节流，不是 flatten） |
| Truncation "不可恢复保留原值"哲学 | 通用 | 部分（现 `_repair` 标记，但未对齐"不静默填 {}"） |
| Wire 级 golden fixture | 通用 | 半个雏形（`responses-adapter.test.ts` `mockSseResponse`） |

## Adoption and Rejection Criteria

| 准则 | 结论 |
|---|---|
| 状态模型归属 | **必须** 不引入第二条会话状态。Repair 是 `ChatMessage[]` 纯变换，不写 DB |
| Profile gate | **必须** 所有阶段读 `ModelProfile`，禁止硬编码模型名。沿用 ADR 0007 |
| Audit trail | **必须** 每次 repair 通过 `incrementRepairCounter` 记录，键名进 `provider-health` |
| 回归网 | **必须** 每阶段至少一条 wire fixture，按 profile 参数化。沿用 ADR 0014 |
| 现有 repair 保留 | **必须** 不重写 `mergeToolCallDeltas` / `repairJson` / `normalizeFinishReason`，只编排不重造 |
| 不照搬 Reasonix 耦合 | **拒绝** Reasonix 的 `isThinkingModeModel()` 硬编码方式；只取管线形状 |
| 不引入新运行时依赖 | **优先** 零新 npm 依赖（DSML 正则、bracket-balancer 自实现） |

**为什么不全盘照搬 Reasonix**：Reasonix 是 DeepSeek-only，耦合是它的 feature。
los 是多厂商 gateway，硬编码模型名会破坏 ADR 0007 的 profile 扩展模型。
Reasonix 的 `ports/model-client.ts` 抽象点存在但未被使用（loop 直接依赖
`DeepSeekClient`）——los 不复制这个反模式。

**为什么不用外部库做 JSON repair**：los 已有 `repairJson` 覆盖 DeepSeek
malformed args 场景（lsclaw 验证过）。外部库（如 `jsonrepair`）引入新依赖
且行为不可控。本 ADR 只补 truncation 的"不可恢复保留原值"哲学，不替换现有
实现。

## Pipeline Design

新建 `packages/agent/src/providers/repair/` 子目录承载新阶段，编排层
`providers/repair-pipeline.ts` 在 agent loop 的三个接入点调用：

```
请求前  healBeforeSend(messages, profile)          接入点: loop.ts 推 assistant msg 后、provider.chat() 前
  1. shrinkOversizedToolResults            [新·通用]
  2. fixToolCallPairing + stampMissingIds  [新·通用]  ← 复用 session-trace.validateTraceCompleteness 的检测，从"检测"升级为"修复"
  3. reasoningRetention(profile)           [新·profile-gated]
       - stripDroppable: lastUser 之前无 tool_calls 的 assistant 轮剥 reasoning
       - stampEmpty: thinking-mode 且 tool_call 轮补空 reasoning_content（防 400）
  4. flattenCheck(profile)                 [新·DeepSeek-only gate]

流式中  streamBuffer                               不动，复用 mergeToolCallDeltas

响应后  repair.process(calls, profile)             接入点: index.ts 流末 phantom 检测处
  1. scavenge(reasoning+content, allowedNames) [新·R1 gate]  MAX_SCAVENGE_INPUT=100KB 防 ReDoS
  2. truncationRepair(args)                   ← 包装现有 repairJson，补"不可恢复保留原值"
  3. stormBreaker.inspect(calls)              [新·通用]

Dispatch                                            不动，复用 tool-runner.ts

回合边界  resetStorm()                             接入点: loop.ts 检测新 user turn 处
```

### Gate 映射（用 ModelProfile，不硬编码）

| Repair 阶段 | Gate 字段 |
|---|---|
| reasoningRetention / stampEmpty | `profile.supportsReasoning` + `profile.reasoningParam` |
| flatten | `profile.knownFailurePatterns` 新增 `drops_deep_schema` |
| scavenge | `profile.knownFailurePatterns` 新增 `leaks_toolcall_to_reasoning` |
| storm | 无 gate，通用，所有 profile 开 |
| fixToolCallPairing / shrink | 无 gate，通用 |

## Gap Closures

### 1. Storm breaker（通用，最高优先级）
- 落点：`providers/repair/storm.ts`
- 逻辑：滑窗 6 / 阈值 3；`isMutating` 调用清除 readOnly 记录；`stormExempt`
  放行；suppressed 调用 drop + `incrementRepairCounter('storm_suppressed')`
- 优先级理由：los agent loop 已能多轮跑 tool，重复风暴是必然遇到的失败
  模式（模型卡在失败 tool 上反复调）。这是唯一"不接 DeepSeek 也会炸"的缺口

### 2. fixToolCallPairing（通用，高优先级）
- 落点：`providers/repair/healing.ts`
- 逻辑：带 tool_calls 的 assistant 若缺匹配 tool result → 丢弃该 assistant +
  orphan tool 消息；bare call 补 `stampMissingIds`（`z-ext-{ts}-{seq}`）
- 关键复用：`session-trace.ts` `validateTraceCompleteness` 已有检测逻辑，
  提取为共享 helper，从"事后告警"升级为"请求前修复"
- 规避：session 恢复后 DeepSeek 400 on unpaired（当前 los 只检测不修）

### 3. Reasoning retention + round-trip（profile-gated，中优先级）
- 落点：`providers/repair/reasoning-retention.ts`
- 逻辑：`lastUser` 之前无 tool_calls 的 assistant 轮剥 `reasoning_content`；
  tool_call 轮保留；thinking-mode 补空 `reasoning_content:""`
- 前置改动：los 当前 `loop.ts` 不写回 reasoningContent。需先在 assistant
  message 增字段存 reasoning（按 `profile.reasoningParam`），再谈剥离
- gate：`profile.supportsReasoning`
- 关联历史 bug：DeepSeek idle loop（已修 finish_reason 透传，round-trip 仍是缺口）

### 4. Scavenge + Flatten（DeepSeek-specific，低优先级，按需）
- 取决于业务上 DeepSeek-R1 占比。los 已有 deferred-registry 部分缓解 deep
  schema 问题
- **Scavenge**：`providers/repair/scavenge.ts`，DSML + 裸 JSON 两模式，
  `MAX_SCAVENGE_INPUT=100KB` 防 ReDoS。gate: `leaks_toolcall_to_reasoning`
- **Flatten**：`providers/repair/flatten.ts`，`analyzeSchema`（depth>2 /
  leaves>10）→ dot-path → `nestArguments` 还原。**只在 tool 注册时跑一次**。
  gate: `drops_deep_schema`

## Wire-Level Regression Net

把 golden trace 从会话事件层下沉到协议 wire 层。复用
`session-trace-fixtures.ts` 的常量 + deepEqual + completeness 校验形状。

- 落点：`providers/repair-fixtures.ts` + `providers/repair.test.ts`
- fixture 形状：`{ name, sseChunks: string[], profile, expected: { toolCalls, finishReason, repaired? } }`
- 共享 helper：提取 `responses-adapter.test.ts` `mockSseResponse()` 成可复用构造器
- 每阶段至少一条 fixture，且**按 profile 参数化**：同一段 SSE 在
  deepseek / anthropic / openai profile 下期望不同（验证 gate 机制）

## Historical Bug Avoidance Mapping

| 历史 bug | 现状 | 迁移后 |
|---|---|---|
| DeepSeek idle loop（reasoning 有产出 content 空，finish_reason 透传） | 已修 finish_reason | + reasoning-retention 补 round-trip，多轮 thinking-mode 防 400 |
| PackyCode phantom `call_1`（index 0→1） | 已修 delta-repair | + fixToolCallPairing 作第二道网 |
| PackyCode `wire_api=responses` 400 | 已修 discovery | 不在 repair 范畴（配置层） |
| DeepSeek malformed args（lsclaw） | 已修 repairJson | + truncation 补"不可恢复保留原值"，避免 {} 静默执行 |
| Anthropic/Responses 静默截断 | 已修 normalizeFinishReason | 不变 |
| orphan tool call | 仅事件层检测 | + fixToolCallPairing 请求前修复，从"告警"升级为"治" |
| 重复 tool call 风暴 | 无 | + storm breaker |
| DeepSeek 丢深 schema → 空 args | 无（latent） | + flatten（按需） |
| R1 leak tool call 到 reasoning | 无（latent） | + scavenge（按需） |

## Implementation Phasing

| 步骤 | 内容 | 依赖 |
|---|---|---|
| 1 | 建 `repair-pipeline.ts` 编排层，把现有散装函数接进去（不改逻辑） | 无 |
| 2 | Storm breaker + golden fixture | 步骤 1 |
| 3 | fixToolCallPairing（复用 `validateTraceCompleteness` 逻辑升级）+ fixture | 步骤 1 |
| 4 | Wire 级 fixture 框架（提取 `mockSseResponse`） | 步骤 2/3 |
| 5 | Reasoning retention（先改 message 写回，再剥/补）+ fixture | 步骤 1，message 结构改动 |
| 6 | Scavenge + Flatten（仅当业务用 R1） | 步骤 4 |

步骤 1–4 是通用价值，不依赖 DeepSeek 业务占比；5–6 按业务决定。

## Relationship to Other ADRs

- **ADR 0007 (Provider Loop First With Model Profiles)**：本 ADR 是其
  repair 层的延伸。`ModelProfile` 是所有 repair gate 的数据源，守住"加厂商
  不改代码"的线。
- **ADR 0014 (Testing Strategy and Regression Gates)**：wire 级 fixture
  框架遵循 0014 的 regression gate 要求，按变更类型挂检查。
- **ADR 0017 (Advisory Provider Promotion Playbook)**：新 repair 阶段的
  `knownFailurePatterns` 字段是 provider 兼容性证据的一部分，进 promotion
  流程。

## Open Questions

1. **Reasoning round-trip — RESOLVED as a non-issue for los (step 5 not needed).**
   DeepSeek's docs (`api-docs.deepseek.com/guides/thinking_mode`) state that a
   tool-call turn's `reasoning_content` MUST be passed back or the API returns
   400. los's `Message` type has no `reasoning_content` field, so los never
   round-trips it — structurally non-compliant with the documented requirement.
   **Verification (2026-06-26)**: ran a 2-turn tool-call conversation against
   `deepseek-v4-flash` via los's exact `createProvider` + `provider.chat` path
   (turn 1 emitted a tool call with 80-char `reasoning_content`; turn 2 sent
   the assistant message back WITHOUT `reasoning_content` + the tool result).
   **Turn 2 returned `finishReason: stop` — no 400.** v4-flash does not
   enforce the documented round-trip requirement in los's flow (the mandate
   may apply to v4-pro or be stricter in the docs than the implementation).
   Conclusion: step 5 is forward-compatibility only, not a live bug. Do not
   implement it speculatively — re-evaluate if los switches to v4-pro as
   default or if DeepSeek tightens enforcement. Lesson: the same
   "don't build for a phantom failure mode" principle that dropped
   `stampMissingIds`.
2. **Storm 的 mutating 标记来源**：`ToolRegistry` 是否已有 `isMutating` /
   `readOnly` 元数据？若无，需先补 tool 定义层（参考 Reasonix
   `ToolRegistry.isMutating`）。步骤 2 前需确认。
3. **Scavenge dropped — DeepSeek-R1 not used.** Operator confirmed
   2026-06-26: R1 is not in use; everything is v4-pro/v4-flash. Scavenge
   (recovering tool-call JSON leaked into `reasoning_content` by R1) is
   therefore out of scope. **Flatten** (DeepSeek dropping schema depth>2 /
   leaves>10) is not R1-specific and could still apply to v4-pro/flash, but
   whether los actually hits it is unverified. Low priority — re-evaluate if
   tool-call args come back empty/wrong for deeply-nested schemas on
   DeepSeek.
4. **Anthropic streaming**：`providers/anthropic.ts` 当前非流式。若
   reasoning-retention 要覆盖 Claude thinking，需先补流式分支——是否在本
   ADR 范围内，还是单开 ADR。
