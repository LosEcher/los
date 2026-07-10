# los 修复任务 DAG、责任边界与模型路由计划

日期：2026-07-10  
依据：`docs/governance/2026-07-10-full-project-audit-and-iteration-plan.md`  
目标：把审计问题转换为可分派、可验收、可回滚的实施任务；本文件不授权生产数据修改、provider promotion 或写权限升级。

## 1. 执行结论

1. P0 先处理日志泄密、operator 权限、通道入口、RunContract 状态真实性和默认测试稳定性，不与结构重构混做。
2. 主代理必须持有跨入口权限模型、状态机不变量、生产数据修复决策、契约/迁移边界和最终集成验证。
3. 子代理只承接文件边界独立、验收面明确、不会修改生产数据的任务；每个任务只对应一个 intent。
4. DeepSeek 当前只适合短小、只读、可重复的复核任务；Grok 当前不满足最小工具兼容要求。
5. 所有代码任务开始前重新调用 `loadSpecsForFiles(editableSurfaces)`，检查 AP1/AP2/AP3/AP5/AP7/AP10；每次有意义编辑后执行 `pnpm check`。

### 1.1 P0 完成状态

| 任务 | 状态 | 合并证据 |
|---|---|---|
| P0-01 日志与 secret | 完成 | PR #125 |
| P0-02 OperatorPrincipal | 完成 | PR #129/#131 |
| P0-03A Telegram ingress | 完成 | PR #132 |
| P0-03B WxPusher ingress | 完成 | PR #130 |
| P0-03C 跨入口权限回归 | 完成 | PR #129/#131 |
| P0-04 计划持久化不变量 | 完成 | PR #126 |
| P0-05 成功验证与状态一致 | 完成 | PR #126 |
| P0-06 历史漂移数据处置 | 完成 | PR #128 |
| P0-07 默认测试稳定性 | 完成 | PR #127 |

整体验收：`pnpm test` 连续三轮 13/13 tasks 通过；`pnpm gate` 9/9 phases、0 failures。正式本地 migration drift 因 PostgreSQL 角色缺少 `CREATEDB` 返回 `42501`，各 P0 PR 的 CI `gate-drift` 均通过。

## 2. 责任边界

### 2.1 必须由主代理处理

| 任务域 | 原因 | 主代理职责 |
|---|---|---|
| 日志与 secret 遏制 | 涉及泄露判断、token 轮换和日志留存 | 删除泄密点、定义脱敏规则；操作者批准后由 `auth:rotate` 自动轮换，日志清理由操作者确认 |
| `OperatorPrincipal` | 横跨 HTTP、OpenAI compat、WS、IM、Telegram、WxPusher | 定义 principal/capability contract，决定 effectful intent 清单，完成最终接线审查 |
| RunContract 不变量 | 同时涉及 plan persistence、phase/status、verification 和 session event | 修改核心状态语义，保证迁移、事件和事务行为一致 |
| 生产数据修复 | 已存在空计划和 `succeeded/plan_approved` 数据漂移 | 生成只读报告；逐类决定修正、回退或标记 legacy，不静默批改 |
| 契约与 package 决策 | 是否新增 `@los/contracts` 会改变 monorepo 边界 | 编写 ADR，确定标准、生成物位置、版本规则和兼容策略 |
| Outbox 与 lease 语义 | 涉及可靠交付、历史水位、双 owner/fencing | 决定语义和切换方式；审核 publisher/reaper 的运行风险 |
| 最终验证与 VCS 治理 | 多任务会触及共享 barrel、迁移号和运行入口 | 协调迁移编号、检查跨任务行为、执行 gate 和 branch closeout |

### 2.2 可分派给子代理

| 子任务 | 建议边界 | 禁止事项 |
|---|---|---|
| Telegram ingress hardening | `packages/telegram-bot/` 及专项测试 | 不修改 `MessageRouter` 权限模型，不启动公网 webhook |
| WxPusher ingress hardening | `packages/wechat-bot/src/channel/` 及专项测试 | 不自行定义 operator principal，不启用无可信来源的 up-call |
| 测试 DB 稳定化/隔离 | 根测试脚本、各包 test setup、经批准的 infra test harness | 不连接生产库，不用 `LOS_ALLOW_LIVE_TEST_DB=1` 绕过 |
| 契约 checker/codegen | `contracts/`、`tools/check-contracts*`、生成包 | 不自行更改业务语义，不批量迁移全部契约作为首个任务 |
| Outbox 模块与测试 | outbox schema/module/focused tests | 不处理历史 2,328 行，不接生产启动入口 |
| Lease API 与双心跳 | agent task lease、scheduler heartbeat、focused tests | 不启用周期 reaper，不改历史 task 数据 |
| CBM cache | `chat-cbm-symbol-cache.ts` 及测试 | 不顺带引入 Redis或重构 memory package |
| Provider defaults | defaults/profile/discovery 的受控统一 | 不更换默认 provider/model，不执行 promotion |

## 3. 依赖 DAG

```text
P0-01 日志与 secret 遏制
  └─> P0-02 OperatorPrincipal 与统一权限门
        ├─> P0-03A Telegram ingress
        ├─> P0-03B WxPusher ingress
        └─> P0-03C OpenAI/IM/WS 接线回归

P0-04 计划持久化不变量
  └─> P0-05 成功验证与 phase/status 原子一致
        └─> P0-06 既有漂移数据处置

P0-07 默认测试串行稳定化（可与 P0-01 至 P0-06 并行）

P1-C0 契约单源 ADR
  ├─> P1-C1 修复 false-green checker
  └─> P1-C2 run-spec/run-stream codegen 试点
        └─> P2-C3 迁移其余契约

P1-O0 Outbox 语义与历史水位决策
  └─> P1-O1 publisher/schema
        └─> P1-O2 启动接线、监控和故障测试

P1-L0 双租约 fencing 决策
  └─> P1-L1 ownership-aware lease API
        └─> P1-L2 双心跳与 lease-loss abort
              └─> P1-L3 周期 reaper、重试上限和 DLQ

P1-T1 测试 schema 隔离依赖 P0-07，且应在大规模并行任务前完成
P1-V1 双网关/崩溃/长任务验收依赖 P1-O2 与 P1-L3
```

## 4. P0 任务卡：0-48 小时

### P0-01 日志与 secret 遏制

**归属：主代理实施；token 轮换和历史日志处理由操作者确认。**

**状态：2026-07-10 已完成。** `LOS_AUTH_TOKEN` 已自动轮换并同步 WeClaw；Gateway 原始 header 日志已删除，10 处历史 Authorization 值已清理，认证与 OpenAI-compatible smoke 通过。操作记录见 `docs/operations/2026-07-10-local-auth-token-rotation.md`。

- 文件：`packages/gateway/src/openai-compat-route.ts`、logger/安全专项测试。
- 修复要点：删除完整 `req.headers` 输出；只记录 request id、route、content length 等 allowlist 字段；增加 Authorization、cookie、token 字段的负向测试。
- 运维动作：轮换 `LOS_AUTH_TOKEN`；确认 operator/bot token 是否复用；审计并按留存策略清理含 secret 的日志副本。
- 验收：日志扫描中 `authorization`、`x-los-auth-token`、`x-los-operator-token` 的值命中为 0；OpenAI-compatible 请求仍可追踪 request id。

### P0-02 OperatorPrincipal 与统一权限门

**归属：主代理。该任务不能拆给多个代理同时修改。**

**状态：2026-07-10 已完成。** PR #129 建立 OperatorPrincipal，PR #131 关闭直接 MessageRouter、OpenAI/IM/WS 等剩余 principal 缺口；actor 由 principal 生成，普通 auth 无 operator capability。

- 文件：`packages/gateway/src/request-context.ts`、`packages/gateway/src/routes/orchestration/run-routes.ts`、OpenAI-compatible short path、`packages/agent/src/message-router/`。
- 修复要点：
  1. 定义来源、认证强度、subject、capabilities、tenant/project 的 `OperatorPrincipal`。
  2. `approve/revise/verify/recover/answer` 等 effectful route 先调用统一 operator gate。
  3. `MessageRouter` 的 RunContract、steering、todo create/dispatch、governance sweep、external runtime spawn 在 handler 前做 capability gate。
  4. `actor` 从 principal 生成，不接受 body 或 channel id 自报。
  5. OpenAI `#command` 不能因持有普通 auth token 获得 operator 权限。
- 验收：普通 auth 对所有 operator 写入口均返回 403；operator token 可执行；拒绝请求不产生 RunSpec、todo、steering 或 session event 写入。

### P0-03A Telegram ingress hardening

**归属：独立子代理。依赖 P0-02 的 principal contract。**

**状态：2026-07-10 已完成。** PR #132 落地 chat/user 双 allowlist、webhook secret、PG action claim/recovery、Gateway owner/lease/reclaim、decision group 互斥与长 `/chat` heartbeat/fencing；Telegram 测试 28/28。

- 文件：`packages/telegram-bot/src/index.ts`、新增 package test script 与入口测试。
- 修复要点：删除 `/start` 自动加入 `authorizedChats`；使用静态 chat allowlist；配置和校验 `X-Telegram-Bot-Api-Secret-Token`；callback 再校验 chat；限制 body；默认 loopback bind。
- 验收：无/错 secret、未知 chat、伪造 callback 均不调用 gateway；`/start` 不修改授权集合；合法 callback 只执行一次。

### P0-03B WxPusher ingress hardening

**归属：独立子代理。依赖 P0-02 的 principal contract。**

**状态：2026-07-10 已完成。** PR #130 落地 callback auth/proxy gate、PG claim state machine、at-most-once effect、future timestamp retention 和 production fail-closed；WeChat focused tests 15/15。残余运维要求是 proxy/LB/APM 不得记录 query token。

- 文件：`packages/wechat-bot/src/channel/weixin.ts`、相关配置和测试。
- 修复要点：up-call 默认关闭；校验 appId、operator UID allowlist、时间窗、重放和 body schema；若平台无可验证签名，公网 callback fail-closed，只允许 loopback 加认证反向代理/mTLS 等可信入口。
- 验收：错误 appId/UID、过期时间、重复请求、超大或畸形 body 均不触发 handler；缺完整可信来源配置时不能公网监听。

### P0-03C 跨入口权限回归

**归属：主代理集成。**

**状态：2026-07-10 已完成。** PR #129/#131 完成 effectful intent 的入口与 Router 双层 capability gate 回归。

- 覆盖 HTTP、OpenAI compat、WS、Telegram、WxPusher 和直接 MessageRouter 调用。
- 验收：每个 effectful intent 至少有一组 anonymous/ordinary/operator 三态测试；入口 transport auth 与 Router capability gate 同时生效。

### P0-04 计划持久化不变量

**归属：主代理。**

**状态：2026-07-10 已完成。** PR #126 强制非空 plan、revision lineage、当前 revision verification mapping，并将审批/修订、session event、outbox 纳入原子事务。

- 文件：`packages/agent/src/run-specs.ts`、`run-contract.ts`、run routes、IM handlers 和测试。
- 修复要点：
  1. `approveRunSpecPhase()` 接收并验证非空、结构合法的 `PlanStep[]`，或只批准已经持久化的非空 plan。
  2. standard/execution 模式的 plan 与 required verification mapping 缺失时拒绝审批。
  3. revision 必须保留 lineage；`#revise-plan` 不得在没有新 plan 时制造空修订。
  4. plan 持久化和 phase 变更在同一事务内完成，之后才发 `run.plan_approved`。
- 验收：空 plan 审批失败且无 event；合法 plan 可恢复读取；并发审批只有一个有效 revision；新增数据中空 plan approval 为 0。

### P0-05 成功验证与 phase/status 原子一致

**归属：主代理。**

**状态：2026-07-10 已完成。** PR #126 规定成功前必须进入 `verifying`，`canMarkSucceeded()` 只读取当前 `planRevision`；`assertion/operator_review` 在结构化完成 API 落地前保持 fail-closed。

- 文件：`packages/agent/src/execution-store.ts`、`run-contract.ts`、`scheduler.ts` 及 focused tests。
- 修复要点：
  1. 将 `canMarkSucceeded()` 下沉到 `transitionExecutionState(run_spec -> succeeded)` 的事务内前置校验。
  2. 同一事务更新 `run_specs.status` 与 `run_contract_json.phase`，避免双真相。
  3. graph completion 不再吞 transition 错误；验证不足时进入 `blocked` 或 `verifying`，并记录明确 event。
  4. 所有成功路径使用同一 invariant，不只修 scheduler 调用点。
- 验收：required verification 未通过时任何路径均不能 succeeded；成功 transition 后 status/phase 一致；失败原因可从 session event 重放。

### P0-06 既有漂移数据处置

**归属：主代理生成报告；操作者批准数据动作。**

**状态：2026-07-10 已完成。** PR #128 执行 repair `p0-run-state-20260710-v1`：8 条 `empty_plan_not_executed`、1 条 `empty_plan_succeeded_legacy`、51 条 `legacy_missing_phase`；写入 60 条 session event 和 60 条 outbox，`unresolved=0`，actor=`operator:local`。

- 先输出 9 个空计划审批和所有 status/phase 漂移行的只读清单，关联 task run、verification、session event 和时间。
- 分类：有充分证据则补 phase；证据不足则回退 status；历史不可重建则标记 legacy/needs_review。
- 禁止：按当前字段机械批量同步、删除历史 event、伪造 verification record。
- 验收：每条处置有 decision、actor、reason 和前后值；修复后 drift query 为 0 或全部为显式 legacy。

### P0-07 默认测试串行稳定化

**归属：独立子代理；主代理决定临时策略。**

**状态：2026-07-10 已完成。** PR #127 恢复 root test 确定性；最终 `pnpm test` 连续三轮 13/13 tasks 通过，`pnpm gate` 9/9 phases、0 failures。

- 文件：根 `package.json`。
- 修复要点：`test` 与 `_test` 统一为 `turbo test --concurrency=1`；不修改测试 DB 数据模型。
- 验收：`pnpm check`、`pnpm test` 连续 3 次、`pnpm gate` 全部通过；不使用 live DB bypass。
- 限制：该任务只恢复确定性，当前约 4 分 50 秒，不能替代 P1-T1 schema 隔离。

## 5. P1 任务卡：第 1-2 周

### P1-T1 跨包测试 schema 隔离

**归属：单一子代理完整实施；新增 infra 文件需 package-level approval。**

- namespace 使用 `packageId + testRunId`；连接初始化前固定 `search_path`，不得回退读取 `public`。
- 每包 setup 只重置自己的 schema；删除单表 DROP 和吞错；gateway 增加统一 setup。
- 保留包内串行，恢复 Turbo 包级并行；CI 增加真实 root `pnpm test`。
- 验收：`turbo test --concurrency=4` 连续 3 次；两个 root test 同时运行成功；public schema 前后不变；test schema 可清理。

### P1-C0/C1/C2 可执行契约

**C0 归属主代理，C1/C2 可交同一子代理。**

- C0：ADR 决定 OpenAPI 3.1/JSON Schema、生成包、版本和兼容规则。
- C1：用 YAML parser/meta-schema 替换 grep 主校验；修正失效 SSE 路径；逐 route/event 比较，不能用 wildcard relay 证明覆盖。
- C2：以 run-spec/run-stream 试点生成 request type、runtime validator 和 event union。
- 验收：删除真实 route、修改 contract 未生成、非法请求均能使相应 gate 失败；生成可复现且无 dirty diff。

### P1-O0/O1/O2 Outbox 可靠通知

**O0 和 O2 归属主代理；O1 可交子代理。**

- 决策：建议 outbox 负责事务后可靠通知，`session_events` 负责 durable replay。
- O1：增加 `session_event_id`、attempt、next attempt、last error；publisher 使用 `FOR UPDATE SKIP LOCKED`，允许重复 notify，由 cursor 幂等。
- 历史 2,328 行必须使用 operator-approved watermark 归档或标记 legacy，禁止启动时全量广播。
- 验收：通知失败可重试；双 publisher 不重复 claim；积压量和最老年龄进入 health/diagnostics。

### P1-L0/L1/L2/L3 双租约 fencing

**L0/L3 归属主代理；L1/L2 可交同一子代理。**

- claim 时递增 `lease_version`；heartbeat 和终态更新必须匹配 `node_id + lease_version`。
- scheduler 同时续 `task_runs` 与 `agent_tasks`；任一 lease 丢失触发 abort，旧 owner 不能覆盖新 claim。
- 完成 fencing 后再启用周期 reaper；reaper 统一 max attempts、blocked/DLQ 和 session event。
- 验收：长任务不被误回收；两实例竞争只有一个有效 attempt；旧 owner 写入失败；达到上限进入失败/DLQ。

### P1-CA1 CBM cache 隔离

**归属：独立子代理。**

- key 改为 `sessionId -> callId`；按 session drain；增加 TTL、容量上限、失败清理和 metrics。
- 验收：并发 session 不互相 clear；失败 session 最终回收；过期和容量驱逐可观测。

### P1-PD1 Provider defaults 单源

**归属：子代理实施；DeepSeek 可生成只读差异草案，主代理审核。**

- 现有 `provider-defaults.ts` 只覆盖部分 provider，`model-profiles.ts`、discovery scanner、OAuth scanner 仍重复 URL/model。
- 补全 catalog；profile/discovery 只引用 canonical defaults；unknown provider fallback 不再静默落到 OpenAI `gpt-4o`。
- 验收：同 provider 在 config/profile/discovery 的 effective URL/model 一致；新增 provider 只需修改一个 catalog；默认 provider/model 不因重构改变。

## 6. P2/P3 后续任务

1. `P2-C3`：迁移其余契约，状态 vocabulary 生成到 server/Web/DB constraint。
2. `P2-S1`：迁移成为 schema 唯一真相，`ensure*Store()` 只做版本检查或调用 migration。
3. `P2-A1`：按 execution/provider/tooling/governance/integration 拆 agent 内部 bounded context；不先拆服务。
4. `P2-M1`：修复 answer resume 的 durable wake/retry，并增加 resident recovery evidence。
5. `P3-V1`：双 gateway、进程崩溃、长任务、通知失败、lease loss 的组合故障测试。
6. `P3-SEC1`：tenant/user 与已认证身份绑定，完成对外多租户隔离。

## 7. 子代理实施编排

### Wave A：P0 已完成

- 子代理 A：P0-03A Telegram，仅触及 telegram package。
- 子代理 B：P0-03B WxPusher，仅触及 wechat channel/config/tests。
- 子代理 C：P0-07 根测试稳定化。
- 主代理：P0-01、P0-02 设计与 P0-04/P0-05 核心不变量。

### Wave B：下一阶段 P1

- 子代理 A：P1-T1 测试 schema 隔离。
- 子代理 B：P1-C1/C2 contract checker/codegen 试点。
- 子代理 C：P1-L1/L2 lease API 与双心跳。
- 主代理：C0/O0/L0 决策；P0-06 数据处置和跨入口回归已完成，不再进入 P1 队列。

### Wave C：决策完成后

- Outbox 子代理实施 O1；主代理接 O2。
- 独立子代理实施 CBM cache 和 provider defaults，避免与状态机/契约任务重叠。
- 主代理执行 V1、全量 gate、运行 smoke 和 branch closeout。

## 8. los / DeepSeek / Grok 路由结论

### 8.1 实测证据

| Provider | 任务 | 结果 | 判断 |
|---|---|---|---|
| DeepSeek `deepseek-v4-flash` | 标准 `read-context` compatibility probe | 通过；`list_directory`、`read_file` 2/2 成功 | 可执行短小只读任务 |
| DeepSeek `deepseek-v4-flash` | provider defaults 复杂只读审计，12 loops | 第 12 轮工具参数 JSON 非法，task failed；未形成最终报告 | 不适合无人监督长任务 |
| xAI `grok-4.3` | 标准 `read-context` compatibility probe | 未完成，0 tool calls，缺少两个期望工具 | 当前 blocked，不分派仓库任务 |

### 8.2 允许的模型任务

- DeepSeek：单一问题、只读、4 loops 左右、输出可由代码/命令复核的 inventory、diff review、测试失败摘要。
- DeepSeek 生成的 codegen 或机械迁移只能作为草案，必须由主代理审查，并在独立分支/任务中运行 gate。
- Grok：修复兼容路径并通过 `read-context` 与 `patch-preview` 前，不进入任务 DAG。

### 8.3 禁止的模型任务

- 不授予 `project-write`/`all`，直到 `patch-preview` 通过、provider 仍按 operator consent 流程评估且写入工具 policy 可证明。
- 不允许模型轮换 secret、修改生产数据库、处理历史 outbox、执行 provider promotion 或决定 schema/契约边界。
- 不用模型“完成”的聊天输出作为成功证据；必须依赖 task run、session event、verification record、测试或 live probe。

## 9. 每个任务的完成模板

每个实施任务提交前必须记录：

1. 任务 ID、唯一 intent、editable surfaces 和明确不处理范围。
2. 已加载的 spec/ADR/anti-pattern 条目。
3. contract 是否先改；是否涉及 operator consent、infra 新文件、迁移或生产数据。
4. focused test、`pnpm check`、必要的 `pnpm gate` 或 live probe 结果。
5. 状态变更是否通过 `transitionExecutionState()`；成功是否经过 `canMarkSucceeded()`；plan 是否先持久化。
6. residual risk、回滚方式、运行观测指标和后续任务 ID。

## 10. 决策状态与下一阶段入口

1. `LOS_AUTH_TOKEN` 已轮换，原始 header 日志已移除；后续使用 `pnpm run auth:locate` 查找配置来源，使用 `pnpm run auth:rotate && pnpm restart` 自动轮换并重启，命令不回显明文 token。
2. P0-07 的确定性策略已实施并通过三轮测试；P1-T1 负责恢复隔离后的安全并行。
3. `@los/infra` test DB harness 和可能的 `@los/contracts` 包仍需按 package-level approval/ADR 进入 P1，不因 P0 完成而自动获得授权。
