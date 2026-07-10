# los 项目全维度审计与迭代计划

审计日期：2026-07-10  
原始审计基线：`main` / `e3bed9c0` / PR #124 合并后  
P0 闭环基线：`main` / `d4aac258` / PR #132 合并后  
审计方式：规格与 ADR 复核、静态代码审计、版本历史审计、运行健康探针、生产库只读聚合、完整检查与串行测试  
证据标识：`[E]` 为命令、代码或数据库直接证据；`[I]` 为基于证据的架构判断。

### P0 闭环摘要

- [E] P0-01 至 P0-07 已通过 PR #125-#132 分 intent 合并；日志/token、执行不变量、测试稳定性、历史数据、operator principal、WxPusher 和 Telegram 均已完成专项修复。
- [E] `pnpm test` 连续三轮通过，均为 13/13 tasks，耗时分别为 4m49s、4m50s、4m46s；`pnpm gate` 9/9 phases 通过，0 failures，耗时 338s。
- [E] 数据修复 `p0-run-state-20260710-v1` 处理 `empty_plan_not_executed=8`、`empty_plan_succeeded_legacy=1`、`legacy_missing_phase=51`，写入 60 条 session event 和 60 条 outbox，`unresolved=0`，actor 为 `operator:local`。
- [E] 正式 `check:migration-drift` 已读取项目配置并连接 PostgreSQL，但本机角色在创建临时数据库时返回 `42501 permission denied to create database`；PR CI 的 `gate-drift` 已通过，故本地结论是“环境权限未满足”，不是发现 schema drift。
- [I] 当前高危项已闭环，但 P1/P2 的契约生成、schema 单源、outbox、双租约、CBM cache、provider defaults 和多租户身份绑定仍未完成，项目成熟度仍维持“受控单机 Beta”。

## 一、项目整体现状盘点

### 1.1 整体运行状态与成熟度

**结论：项目已达到“受控单机 Beta 可用”，但未达到生产级多租户或可靠 mesh 运行标准。**

- [E] Gateway 与 Executor 均由本地脚本托管并通过健康检查：Gateway `0.0.0.0:8080`，Executor `127.0.0.1:8090`，PostgreSQL 连通。
- [E] Executor 节点 `mbp-executor-1` 为 `online/candidate=true`，但当前有 `resource:memory_pressure` 告警。
- [E] `pnpm check` 通过，包级类型检查、结构检查、状态机旁路检查、契约存在性检查和接线增量检查均无新增阻断项。
- [E] 默认 `pnpm test` 已固定为确定性执行并连续三轮 13/13 tasks 通过；跨包 test schema 隔离仍列为 P1，以恢复安全并行。
- [E] 生产库当前有 108 个 session、7,656 个 session event、86 个 run spec、78 个 task run、446 个 tool call state、295 个 provider telemetry 记录。
- [E] 当前 6 个 provider 被发现并处于 advisory 可用状态；最近 24 小时有 129 条 provider call telemetry。
- [I] 代码功能面较完整，证据面、权限面、契约执行力和并发恢复能力仍不足，因此不应把“服务健康”和“检查通过”解释为“生产就绪”。

### 1.2 已落地能力

- Agent ReAct loop、工具注册/策略、provider 适配、上下文监控、模型诊断、tool-call repair、self-check。
- RunSpec、TaskRun、ToolCallState、VerificationRecord 四类执行实体和统一状态迁移入口。
- PostgreSQL session ledger、stream checkpoint、run replay、SSE/WS、operator steering、OpenAI-compatible ingress。
- Todo、agent task graph、调度决策、恢复读模型、dead letter、idempotency、cancellation、worker ask/answer。
- Memory observation、检索、compaction、procedural candidate、retention/integrity、MEMORY.md 同步。
- Executor node registry、heartbeat、HTTP/NDJSON 执行、node command、artifact/file-sync。
- Web 运维控制台、CLI、微信、Telegram、media provider 等外围入口。
- 结构、耦合、安全、契约、未接线导出、删除安全等治理脚本。

### 1.3 P0 闭环后的核心短板

- Contract gate 仍以文档/静态检查为主，尚未形成 schema 驱动的类型生成和 runtime validator。
- migration 与 `ensure*Store()` 仍为双 schema source；本地 drift gate 依赖 `CREATEDB`，开发者默认角色无法独立执行。
- Outbox 发布语义、agent task 双租约 heartbeat/fencing、answer resume durable retry 仍待 P1 治理。
- `assertion` / `operator_review` 尚无结构化完成 API；当前审批逻辑采用 fail-closed，不会把缺少完成证据的验证误判为通过。
- 已有能力不等于已验证能力：生产库 `agent_tasks=0`、`observations=0`，DAG 与默认记忆持久化缺少真实运行证据。
- 39 个生产文件超过 400 行警戒线，250 个未接线导出被 baseline 豁免。

### 1.4 近期变更与影响范围

| 变更 | 主要内容 | 影响范围 | 新增风险 |
|---|---|---|---|
| PR #120 | governance、memory sync、operatorToken、IM/Web 修复 | agent/infra/memory/gateway/executor | 变更面大，涉及配置、持久化和运行入口 |
| PR #121/#122 | Web ApprovalCard、WS steering、AP6 child contract 隔离 | web/gateway/agent | operator 权限边界扩大，需端到端鉴权回归 |
| PR #123/#124 | IM RunContract 命令、Bearer auth、`#command` short path、smoke | gateway/agent/wechat | 普通 auth 可触发 operator 动作；请求头日志泄密 |
| `ac101985` | 为 wiring gate 取消内部 helper export | agent/gateway | 仅修静态接线噪声，不改变权限和运行语义 |
| PR #125 | token 自动轮换、配置定位、原始 header 日志移除 | gateway/infra/docs | token 消费方需同步重启，已提供 `auth:locate`/`auth:rotate` |
| PR #126/#128 | RunContract 不变量、迁移 029、历史状态修复 | agent/gateway/infra | 执行语义与历史数据同时变更，已有事务测试和修复审计事件 |
| PR #127 | root test 确定性执行 | root scripts/test setup | 牺牲包级并行，P1 恢复 schema 隔离后再并行 |
| PR #129/#131 | OperatorPrincipal 与跨入口权限缺口收口 | agent/gateway/bots | effectful intent 统一鉴权，普通 auth 不再获得 operator 能力 |
| PR #130/#132 | WxPusher/Telegram ingress hardening，迁移 027/028/030/031 | wechat/telegram/gateway/infra | proxy 日志仍须避免记录 query token；外部副作用不可由 AbortSignal 撤销 |

### 1.5 技术债与隐性风险汇总

- **安全债**：P0 日志、operator gate 和通道入口已闭环；租户头仍未与受认证身份绑定。
- **状态债**：P0 成功门、计划持久化和历史漂移已闭环；状态字符串及结构化人工验证完成能力仍待治理。
- **数据债**：迁移和 `ensure*Store()` 双定义、outbox 无 publisher、14 条 DLQ 未确认。
- **结构债**：agent 包职责过宽；server/chat/config/compaction 等热点接近 600 行。
- **治理债**：所有契约仍为 `draft/0.1.0`；检查器以 grep 为主；默认 test 已通过 P0 串行恢复稳定，包级并行与 schema 隔离仍属 P1。
- **证据债**：DAG、observations、verification_records 在生产库无有效使用证据。

## 二、各模块逐一盘点

### 2.1 包依赖总览

`infra <- agent <- executor`，`infra <- agent <- memory`，`gateway -> agent + memory + infra`，`cli -> agent + memory`，`media -> infra`，`wechat-bot -> agent + infra + media`，`telegram-bot -> agent`，`web -> HTTP/WS/SSE gateway`。

- [E] `check-coupling.sh` 未发现循环依赖、infra 向上依赖或禁止导入。
- [I] 代码依赖方向整体可控，但 memory 为使用 MCPClient 依赖 agent，说明协议端口放置偏高；建议把 MCP transport port 下沉到独立 integration port 或 infra adapter。

### 2.2 模块明细

| 模块 | 定位与对外能力 | 核心调用链与依赖 | 职责评价 |
|---|---|---|---|
| `@los/infra` | Zod config、PostgreSQL、migration、logger、provider discovery | 所有后端包的叶子依赖 | 边界正确；`config.ts` 584 行，provider 默认值仍多源 |
| `@los/agent` | loop、scheduler、provider、tools、state machine、todo、DAG、eval、governance、auth、message router | gateway/CLI/executor/bot 的核心领域层 | **职责过载**；621 个 TS/TSX 源文件含测试，已成为事实上的平台总包 |
| `@los/memory` | observations、retrieval、compaction、procedural memory、retention、CBM | gateway 调用；依赖 infra 和 agent MCP/store | 功能聚合合理，但与 agent 的依赖使独立演进受限 |
| `@los/gateway` | Fastify、REST、SSE/WS、OpenAI compat、启动恢复、服务编排 | `server -> routes/chat-service -> agent/memory` | 路由拆分已有成效；`server.ts` 568 行仍包含内联设置/工作区等实现 |
| `@los/executor` | 独立 HTTP/NDJSON executor、节点心跳、命令、file-sync | agent contract/store + infra DB/config | 运行边界清楚；与“一 Node 进程 modular monolith”设计不一致，应正式定义为 satellite service |
| `@los/web` | React 运维控制台、chat、sessions、runs、nodes、memory、provider 等页面 | 仅通过 gateway API/WS/SSE | UI 功能广；测试以源码边界断言为主，缺真实浏览器/E2E |
| `@los/cli` | provider、run、node、artifact、memory、governance 操作 | 直接依赖 agent/memory，部分走 gateway | 混合本地库操作和远程客户端语义，后续易与 HTTP contract 漂移 |
| `@los/media` | media provider catalog、actions、delivery、runtime | infra config/logger | 边界独立；`media-runtime.ts` 539 行且无测试脚本 |
| `@los/wechat-bot` | WeClaw、WxPusher、移动 Web、IM command | agent MessageRouter + gateway operator API | P0 已增加 callback auth/proxy gate 与 PG claim；proxy query token 日志策略仍需运维保证 |
| `@los/telegram-bot` | operator attention 推送和 inline action | agent intent + gateway operator API | P0 已增加 allowlist、webhook secret、PG claim、decision group 与 lease fencing；包级测试已纳入 root test |
| `contracts/` | 跨包字段、路由、事件和 source-of-truth 声明 | 由 shell gate 做存在性/grep 校验 | 仍是文档型契约，不是可生成、可执行契约 |
| `.los/spec/` | 开发前置规则与质量检查 | spec-loader 按路径注入 | 机制有价值，但 executor、Web proxy、测试数量等内容已陈旧 |
| `tools/` | 启停、结构、安全、契约、耦合、迁移、wiring、CI | pnpm scripts/CI | 治理覆盖广；部分检查依赖 baseline 或环境权限，存在假绿/不可运行 |

### 2.3 关键业务调用链

1. **Chat**：HTTP/SSE 或 OpenAI-compatible -> Gateway auth/request context -> `runChat()` -> scheduler -> ReAct loop -> provider/tool -> session events/checkpoints -> completion projection。
2. **Graph execution**：Todo/graph route -> claim ready agent task -> provider selection -> `runScheduledAgentTask()` -> task heartbeat/tool state -> verifier/recovery -> graph completion -> RunSpec transition。
3. **Memory**：chat/session evidence -> observation -> compaction -> procedural candidate -> manual promotion -> retrieval/injection。
4. **Remote executor**：scheduler selects verified node -> HTTP/NDJSON request -> executor runs agent/tools -> streamed state -> gateway persists tool/task evidence。
5. **Operator**：SSE/WS/IM alert -> operator action -> gateway/operator route or MessageRouter -> steering/phase/verification write -> session event。

## 三、架构合理性专项检查

### 3.1 合理部分

- infra 保持叶子依赖，耦合 gate 通过，跨包直接第三方依赖控制有效。
- PostgreSQL 作为单机和 mesh 的统一持久化路径，避免 SQLite/PostgreSQL 双运行模式。
- Gateway 路由已大体移入 `routes/`，agent loop 也拆出 setup/phases/tool-runner 等子模块。
- TaskRun 与 Todo 分离、session event ledger、stream replay、idempotency 和 lease 模型符合可恢复执行方向。
- file-sync 使用 `FOR UPDATE SKIP LOCKED`、attempt cap、DLQ 和 heartbeat，队列基础实现较完整。

### 3.2 不合理与腐化点

1. **架构名实不符**：AGENTS 声明“一 Node 进程 modular monolith”，实际已有 gateway、executor、微信、Telegram 多进程。[M]
2. **核心包过载**：agent 同时承载领域、基础协议、governance、自修复、OAuth、artifact、message router，边界已经超过单一 bounded context。[M]
3. **生命周期表示仍复杂**：RunSpec status 与 RunContract phase 仍并存，但 P0 已把成功门、phase/status 更新、event/outbox 纳入同一事务并修复历史漂移；长期仍应减少双真相维护成本。[M]
4. **双 schema source**：迁移与运行时 DDL 同时维护，启动流程还以 ensure 自愈漂移，掩盖 schema 管理失败。[M]
5. **契约不足**：无 codegen/validator，契约状态均为 draft，版本号固定，无法可靠驱动实现。[M]
6. **过度设计与接线不足并存**：有 250 个 baseline orphan、0 条生产 agent task，却已存在多套 governance/GA/runtime adapter 能力。[M]
7. **身份边界仍未生产化**：OperatorPrincipal 已贯穿 effectful 入口，但 tenant/user 与认证主体的强绑定仍待 P3。[M]

### 3.3 抽象、复用与扩展性评估

- `transitionExecutionState()`、request context、provider profile、MessageRouter、coordination backend 是正确抽象点。
- `canMarkSucceeded()` 已进入成功 transition invariant；当前剩余缺口是 `assertion/operator_review` 的结构化完成 API，未完成前保持 fail-closed。
- provider catalog/default/profile/discovery 重复持有相同 endpoint/model，说明“默认值端口”尚未真正统一。
- Gateway 和 bot 各自构造 URL/header/重连策略，建议抽统一 channel client，但不建议引入独立微服务或外部 MQ 作为第一步。

## 四、硬编码专项全局排查

### 4.1 扫描结果

- [E] 生产源与脚本中有 138 处 `process.env.*` 直读，分布于 33 个文件。
- [E] 状态字面量匹配约 516 处，说明类型虽存在，但读侧和流程判断仍大量依赖字符串。
- [E] 原始基线中 loopback URL/host 硬编码约 76 处、`console.*` 调用约 410 处；P0 已删除已确认的服务端原始 header 输出，其他服务日志仍需分类治理。
- [E] `deepseek-v4-flash` 出现在 6 个生产文件，OpenAI URL 出现在 4 个生产文件。
- [E] `governance-jobs-schema.ts` 仍包含开发机绝对路径 `/Users/echerlos/...`。
- [E] 原始审计基线中本地 `.env` 的 `LOS_AUTH_TOKEN` 长度仅 14，且已可能进入 10 条 gateway 日志；P0 已自动轮换并清理历史值，本文始终不记录明文。

### 4.2 风险分类

| 类型 | 示例 | 风险 | 整改 |
|---|---|---|---|
| 密钥/认证 | auth token、bot token、operator token | 泄露、权限扩大 | 立即轮换；secret store/系统 env；日志字段级脱敏 |
| 地址/端口 | 8080、8090、18011、4318、8899、local model ports | 环境切换失败、测试与生产不一致 | 统一进入 Zod schema；通道 client 从 config 注入 |
| Provider 默认值 | URL、模型、API shape | 同 provider 不同入口行为不一致 | `provider-defaults` 成为唯一 source，其他模块只引用 |
| 状态值 | run/task/tool/todo/file-sync 字符串 | 非法状态、读写语义漂移 | 合同 schema -> 生成 union/enum -> DB constraint |
| 业务阈值 | 5 次重试、30s lease、15min cooldown | 调优困难、环境不适配 | 按 bounded context 配置化，并记录 effective value |
| 文案/身份 | IM 提示、system prompt、错误文案 | 多语言和身份漂移 | identity 继续走 loader；UI/IM 文案抽 message catalog |
| 路径 | 本机绝对目录 | 不可移植、误扫描 | 改为项目配置或 seed metadata，不给出机器默认值 |

## 五、缓存、队列、执行顺序、状态机专项最佳实践校验

### 5.1 缓存

- 项目没有通用业务缓存或 Redis；当前主要依赖 PostgreSQL、provider prefix cache telemetry 和少量进程内 Map。单机阶段无需为“行业最佳实践”强行引入 Redis。
- `chat-cbm-symbol-cache.ts` 使用全局 `Map<callId,...>`，任一 session 成功会 `clear()` 全部数据；失败 session 不清理且无 TTL。[M]
- 影响：并发 session 可能互相清空缓存，失败流量可能造成内存增长，符号证据可能丢失或串会话。
- 整改：key 改为 `sessionId -> callId`；按 session 精确 drain；增加 TTL/LRU 上限和命中/驱逐指标。
- 缓存穿透/击穿/雪崩目前不构成主要问题；未来为 memory retrieval/provider catalog 加缓存时再引入 negative cache、single-flight、jitter TTL。

### 5.2 队列与消息

- **file-sync**：具备 FIFO created_at 排序、`SKIP LOCKED`、attempt、5 次上限、DLQ、heartbeat、人工 requeue，整体符合 PostgreSQL queue 基线。
- **task_runs**：有 lease heartbeat、启动恢复、cancellation polling；恢复只在 gateway 启动时执行，缺 resident reaper 指标。
- **agent_tasks**：claim 时写 lease，但执行期间只刷新 task_run lease；`heartbeatAgentTask()` 未调用。第二个 gateway 启动或未来周期 reaper 可能重领长任务。[H/M]
- **execution_outbox**：2,328 行全部 `published_at IS NULL`，代码已取消 publisher，实际 live 通道改为 EventEmitter + PG NOTIFY。[M]
- **dead letter**：22 条中 14 条未确认（2 lease_expired、12 unrecoverable_error），说明有积压但缺 SLA/告警闭环。[M]
- 整改：明确 outbox 是 durable delivery 还是 audit mirror；若前者实现 publisher/consumer ack，若后者删除 `published_at` 语义并以 session_events 为唯一 replay source。

### 5.3 执行顺序

- 正常链路：migration -> ensure stores -> service heartbeat -> expired recovery -> seed -> route serving，顺序合理。
- Scheduler 单任务链路先检查 plan gate，再运行 agent，再验证/self-check，再迁移 task succeeded，符合 B0 设计。
- Graph completion 已统一进入 verification gate 和事务状态迁移；required verification 未完成时先进入 `verifying`，不能直接 `succeeded`。[已闭环]
- `/runs/:id/answer` 的 resume 为 fire-and-forget，失败后无 resident retry，只留日志，弱网或进程抖动会使 task 持续 blocked。[M]

### 5.4 状态机

**符合项**：显式 transition map、非法迁移拒绝、事务内 entity/event/outbox 原子写、terminal state、DB status constraint。

**P0 闭环与剩余不符合项**：

1. 成功前 verification invariant 已下沉，且仅接受当前 `planRevision` 的 verification records。[已闭环]
2. plan 审批/修订、phase/status、session event、outbox 已事务化，旧 revision 不能重新变为 required。[已闭环]
3. 历史空计划和 phase 漂移已由带 actor/reason/evidence 的 repair 处理，未解决数为 0。[已闭环]
4. `assertion/operator_review` 缺结构化完成 API，审批暂时 fail-closed。[M]
5. recovery/fallback 路径仍有受控低级 update，并依赖白名单和审计补偿。[M]
6. 状态字符串在读侧、UI、route、SQL 多处重复，新增状态易漏 projector/contract/UI。[M]

## 六、业务与代码实现漂移检查

### 6.1 已确认漂移

| 设计/契约 | 当前实现或数据 | 判断 |
|---|---|---|
| AP2：审批前持久计划 | 非空 plan、revision lineage 和 verification mapping 已强制 | **P0 已闭环，PR #126** |
| AP3：成功前 `canMarkSucceeded()` | 所有成功路径先进入 `verifying` 并检查当前 revision | **P0 已闭环，PR #126** |
| AP4：status/phase 一致 | 事务更新并完成历史 repair，`unresolved=0` | **P0 已闭环，PR #126/#128** |
| Operator actions require consent | OperatorPrincipal 与跨入口 capability gate 已接线 | **P0 已闭环，PR #129/#131** |
| infra logger 禁止 raw secret | 原始 header 日志删除、token 已轮换、历史值已清理 | **P0 已闭环，PR #125** |
| Contract-first + generated types | 契约为 draft YAML，类型手写，无 codegen | **中危架构漂移** |
| Contract event coverage | checker 扫描已不存在的旧 SSE 路径，并用 relay wildcard 判定覆盖 | **中危治理漂移** |
| Modular monolith one process | gateway/executor/bot 为多个进程 | **中危设计陈旧** |
| Executor spec | 标题和质量检查仍写 Go/1 test | **低危文档漂移** |
| Gateway web spec | 声称 `/runs` 等 proxy 缺失，实际已覆盖 | **低危规格陈旧** |
| AGENTS package inventory | 仅列 5 包，实际 10 包 | **低危结构文档漂移** |

### 6.2 接口、表结构与枚举漂移

- Contract gate 不解析 YAML schema，也不对 route request/response 类型做双向校验；“contract check passed”只代表文件与关键字符串存在。
- migration 与 runtime DDL 并存；本地正式 drift 检查已确认因 PostgreSQL `42501`/缺少 `CREATEDB` 无法创建 scratch DB。PR CI `gate-drift` 已通过，但开发者本地默认可执行性仍是 P1 问题。
- 生产库 `verification_records=0`，而 run/status/phase 已进入真实使用；验证模型仍未成为普遍运行事实。
- `request-context` 在 auth enabled 时对缺失 tenant/user 仅告警并写 `unknown`，也允许调用方自行声明 tenant/user，尚不具备 SaaS 隔离语义。

## 七、现状总结与问题定级

### 7.1 高危问题

| 编号 | 问题 | 影响范围 | 紧急度 |
|---|---|---|---|
| H-01 | 原始 header 日志与已泄露 token | auth token、所有受保护 API | **已关闭：PR #125** |
| H-02 | operator 写入口权限缺口 | 计划、验证、执行控制 | **已关闭：PR #129/#131** |
| H-03 | Telegram/WxPusher ingress 信任边界 | operator alert 与 steering | **已关闭：PR #130/#132** |
| H-04 | plan_approved 可无 plan | 执行可审计性、恢复 | **已关闭：PR #126/#128** |
| H-05 | 成功验证与 status/phase 漂移 | RunSpec 真实性、恢复、UI | **已关闭：PR #126/#128** |
| H-06 | 默认测试 DDL race | CI/pre-push 可信度 | **已关闭：PR #127；P1 恢复安全并行** |

### 7.2 中危问题

| 编号 | 问题 | 影响范围 | 紧急度 |
|---|---|---|---|
| M-01 | 契约均为 draft，grep gate 与 stale path 产生假绿 | API/事件/客户端 | 1 周 |
| M-02 | migration/ensure 双 schema source，drift check 不可默认运行 | 数据升级与回滚 | 1-2 周 |
| M-03 | outbox 无 publisher、2,328 条未发布，语义不明确 | mesh 通知与恢复 | 1-2 周 |
| M-04 | agent task lease 无执行期 heartbeat，恢复仅启动时 | 长任务与多 gateway | 1 周 |
| M-05 | 全局 CBM cache 无 session 隔离/TTL | 并发 chat、内存与证据 | 1 周 |
| M-06 | provider、URL、端口、阈值和 env 多源 | 环境切换、维护 | 2-4 周 |
| M-07 | 39 个大文件、250 个 baseline orphan | 变更风险、认知成本 | 持续偿还 |
| M-08 | 14 条 DLQ 未确认，无处置 SLA | 运维积压 | 1 周 |
| M-09 | tenant/user 由 header 自报且缺失只告警 | SaaS 隔离 | 对外部署前 |
| M-10 | 生产 DAG/observation 为 0，能力缺运行证据 | 成熟度判断 | 2 周 |

### 7.3 低危问题

- executor/Web/AGENTS 等规格内容陈旧；测试数量注释失真。
- CLI 和 media 测试深度仍不足，Web 无浏览器级 E2E；Telegram 已新增包级测试并纳入 root test。
- baseline 已继续缩小但未更新：当前 39 个 grandfathered 大文件、250 个 grandfathered wiring finding。
- 服务端仍有较多 `console.*`；应区分 CLI 输出与服务日志并逐步治理。

## 八、后续迭代规划与落地计划

### 8.1 P0：安全与状态真实性（0-48 小时）

**状态：2026-07-10 全部完成。** P0-01 至 P0-07 已按 one branch, one intent 合并，PR 为 #125-#132；详细任务与验收映射见修复 DAG 文档。

1. 删除 raw header 日志，轮换 `LOS_AUTH_TOKEN`，审查/清理 gateway 日志副本；增加“日志不得含 Authorization/token”回归测试。
2. 给 run approve/revise/verify/recover/answer、OpenAI `#command`、WS/IM RunContract handler 建立统一 `OperatorPrincipal`，所有写操作强制 `requireOperator()`。
3. Telegram 使用 chat/user 双 allowlist，`/start` 不修改授权集合，Webhook 校验 Telegram secret token；WxPusher 使用 callback auth/proxy gate，缺可信来源配置时 fail-closed。
4. `approveRunSpecPhase()` 强制非空 plan 与 verification mapping；修复 smoke 工具，不再批准空计划。
5. 将 `canMarkSucceeded()` 下沉到 `transitionExecutionState(run_spec -> succeeded)` 的事务前 invariant；禁止调用方绕过。
6. 为既有 `succeeded/plan_approved` 数据生成审计报告，按证据决定修正 phase、回退 status 或标记 legacy，不静默批量改写。
7. P0 先设置 Turbo `test` concurrency=1 恢复确定性；独立 test schema/database 和安全并行作为 P1-T1 继续实施。

**验收**：普通 auth 请求所有 operator 写接口均为 403；日志扫描为 0；无空计划审批；新增 required verification 的 graph run 在验证前不能 succeeded；默认 `pnpm test` 连续 3 次通过。

### 8.2 P1：契约、数据与恢复治理（第 1-2 周）

1. 选择 JSON Schema/OpenAPI parser，生成 TypeScript types 和 runtime validator；停止 grep 充当主契约校验。
2. 把 contract status 从 draft 升级为明确生命周期；每次字段/事件变更要求版本变化和 compatibility test。
3. 迁移文件成为 schema 唯一真相；`ensure*Store()` 只做 migration version 检查或调用 migration，不再复制完整 DDL。
4. 改造 migration drift 工具：避免要求普通开发角色具备 `CREATEDB`，并保持 CI `gate-drift` 的 fresh/legacy 覆盖。
5. 明确 outbox ADR：实现带 retry/backoff/ack 的 publisher，或删除伪发布语义并统一到 session_events + checkpoint replay。
6. 给 agent task 增加与 task_run 同频 heartbeat；增加周期 reaper、最大恢复次数和 DLQ。
7. 给 answered ask resume 增加 durable wake/retry，不再仅 fire-and-forget。

**验收**：fresh DB migration 与 runtime schema diff 为 0；契约字段删改能使 CI 失败；跨 gateway 中断后事件可重放；长任务不会因 agent lease 过期被重复领取。

### 8.3 P2：结构与配置治理（第 3-6 周）

1. 拆 agent 为内部 bounded contexts：execution、provider、tooling、governance、integration；保持单仓，不急于拆服务。
2. 优先拆 `chat-service.ts`、`config.ts`、`compaction.ts`、`session-events.ts`、`run-contract.ts`、bot entrypoint。
3. 统一 provider defaults、model profile、discovery mapping；加入“同 provider effective defaults 一致”测试。
4. 把 executor/bot/OTel/WeClaw URL 和 threshold 纳入 Zod config，禁止业务模块新增直接 env 读取。
5. 把状态 vocabulary 从 contract 生成到 DB constraint、server types、Web types 和 projector。
6. CBM cache 改为 session-scoped TTL cache；增加 size/hit/eviction metrics。
7. 按风险清理 wiring baseline：先处理 lease/recovery/security/governance 入口，再删除纯 test helper export。

**验收**：无新增 >400 行文件；核心 6 个热点降至 400 行内；provider defaults 单源；关键状态无手写重复 union；orphan baseline 每迭代下降至少 10%。

### 8.4 P3：生产化与版本路线（第 6-12 周）

| 版本 | 目标 | 退出条件 |
|---|---|---|
| `0.2.1` | 安全热修复 | H-01/H-02/H-03 关闭，token 已轮换 |
| `0.3` | 状态与测试可信 | AP2/AP3/AP4 无漂移，默认 gate 稳定 |
| `0.4` | 可执行契约与 schema 单源 | codegen/validator/migration drift 全入 CI |
| `0.5` | mesh hardening | heartbeat/reaper/outbox/chaos smoke 通过 |
| `1.0` | 生产就绪 | 多租户身份绑定、审计留存、SLO/告警、灾备演练完成 |

### 8.5 持续治理指标

- 安全：日志 secret 命中数 0；operator API 非 operator 403 覆盖率 100%。
- 状态：phase/status 漂移数 0；空 plan approval 数 0；无 verification 成功违规数 0。
- 队列：lease expiry、retry、DLQ age、replay success、重复领取数可观测。
- 质量：默认 gate 成功率 >= 99%；flaky test 7 日为 0；关键包行覆盖率 >= 75%。
- 架构：>400 行文件和 orphan baseline 单调下降；跨包禁止依赖为 0。
- 运行证据：每个宣称 live 的能力至少有最近 30 天 task/session/event/harness 证据，不再以 UI 或文档标记替代。

## 审计验证记录

- `loadSpecsForFiles(...)`：8 个 package/layer spec 成功加载；另读 identity spec 与 anti-patterns。
- `pnpm run status`、`pnpm run doctor`、`pnpm run executor:status`：服务与数据库健康，executor memory pressure 告警。
- `pnpm check`：通过；39 个大文件 warning，250 个 wiring finding 被 baseline 豁免，无新增 state-machine bypass 或 unwired export。
- `./tools/check-security.sh`：通过但有 1,319 个低精度 warning；未发现 critical dependency vulnerability。
- `./tools/check-coupling.sh`：通过，无循环依赖。
- `pnpm test`：连续三轮通过，13/13 tasks；耗时 4m49s、4m50s、4m46s。
- `pnpm gate`：9/9 phases，0 failures，耗时 338s。
- `pnpm run check:migration-drift`：首次因 shell 未注入 `SERVER_URL/DATABASE_URL` 停止；通过 `loadConfig()` 读取项目配置复跑后连接成功，但创建 scratch DB 时 PostgreSQL 返回 `42501 permission denied to create database`。PR CI `gate-drift` 已通过。
- token 配置定位：`pnpm run auth:locate`；自动轮换并重启：`pnpm run auth:rotate && pnpm restart`。配置查找顺序为 process env/CLI、最近 `.env`、`~/.los/config.yaml`、`/etc/los/config.yaml`、内置默认值；命令只输出路径和 fingerprint，不输出明文 token。
- 原始生产库只读聚合确认 status/phase 漂移、空计划审批、outbox 未发布、DLQ 积压和 live evidence 缺口；前两项已由 PR #128 repair 至 `unresolved=0`，当前剩余 outbox、DLQ 和 live evidence 风险。
