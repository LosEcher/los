# los 架构全维度盘点与迭代规划（2026-06-24）

> 审计对象：`los` monorepo（TypeScript 单仓单语言，pnpm workspace + turbo）
> 体量：11 个包，约 87k 行 TS；核心 `@los/agent` 49.4k 行
> 审计基线：2026-06-24 当前工作树（含 4 个未提交改动文件）
> 用途：项目复盘 + 迭代规划基线文档，配合 `todos` 与 ADR 持续追踪。

## 一、项目整体现状盘点

### 1. 运行状态、成熟度、已落地能力、短板

**结论：项目处于「自我治理基建期」，runtime 内核已成型，正在密集补 CI/治理/漂移检测脚手架，而非加新功能。**

已落地能力（成熟）：
- **ReAct Agent 内核**：`loop.ts` 主循环 + provider 抽象（OpenAI-compat / Anthropic / Responses API）+ 工具注册表（能力分级 L0/L1/L2、并行批处理、重试退避）。`packages/agent/src/loop/tool-runner.ts:54-100` 的「副作用感知并行批处理」是亮点。
- **契约优先骨架**：`contracts/` 11 份 YAML + `tools/check-contracts.sh` 双向事件覆盖校验 + 8 阶段 `ci-gate.sh`。
- **状态机**：`execution-transitions.ts` 正式迁移表 + `transitionExecutionState()` 事务型 outbox（单事务 BEGIN/COMMIT/ROLLBACK）+ `check-state-machine-bypass.sh` 白名单拦截直改状态。
- **PG 队列**：3 套独立队列均用 `FOR UPDATE SKIP LOCKED` + advisory lock + lease/heartbeat + 死信表。
- **治理子系统**：11 类审计 job、drift sweeper、hotspot detector、GA 自修复循环 + 熔断器、PG LISTEN 唤醒。
- **记忆**：PG 全文检索 + 观测 + 压缩（ADR 0020）+ MEMORY.md 同步 + 语义驱逐 + 上下文水位监控。
- **多通道**：Telegram / WeClaw / WxPusher / Web 移动面板，operator SSE 推送 + 审批按钮。
- **mesh 执行器**：独立 executor 节点 + 文件同步队列 + node-command 运维。

未完善短板：
- **input-preprocessor 整包未接入**：21 文件、5.5k 行，无 runtime 消费者——过早建设的孤岛。
- **Architect/Editor 双模型**：config/setup/message-builder 全接好，唯独 `loop.ts` 从不引用它（grep 零命中）——commit `8dadeb6` 宣称的能力**核心编排没实现**。
- **deferred-registry**：192 行实现，`preloadDeferredEntries` 函数体只有注释，全仓无人调用——死代码。
- **契约→类型生成缺失**：AGENTS.md 写明 `contracts/ → generated types → implementation`，codegen 这一步不存在，类型手写靠 grep 粗校验。
- **operatorToken 半接线**：config schema 定义了 `auth.operatorToken`，`auth-middleware.ts` 只查 `auth.token`，operator consent 闸门无强制点。
- **syncMemoryMd**：文档串「每次新增观测自动更新」，实际 `addObservation` 不调用它。

### 2. 近期变更内容、影响范围、潜在风险

近 15 commit 三条主线：

| 主线 | 代表 commit | 影响面 | 风险 |
|---|---|---|---|
| 治理/CI 加固 | `d6a3fda`(#79)、`44a7731`、`a07f817`、`4b4b96e` | PG 队列扫环替代 setInterval、3 个新审计 job、CI 安全+耦合门、语义驱逐/压缩钩子/延迟工具/退避 | 低-中：新机制更稳但是新代码，延迟工具实际未接线 |
| Bot/消息路由 | `317969e`(#78)、`026bdf9`(#77) | WeClaw 重复进程修复、`#jobs/#sweep/#governance` 治理指令 | 低：增量式 |
| Agent runtime | `4cce965`、`8dadeb6`、`8e42dde` | finishReason 截断检测、双模型分离、file-sync 500 分片防 PG 绑定参数溢出 | 中：核心路径 |

**未提交的 4 文件 diff（+23/-9）**：真实 bug 修复，风险低，应当提交：
- `governance-auditors.ts`：`filesOver600/400` 从计数改为对象数组（供趋势检测），新增 `*Count` 数值字段。
- `governance-drift-sweeper.ts` / `hotspot-drift-detector.ts`：读侧加向后兼容回退。
- `server-maintenance.ts`：修复 **onClose 钩子竞态**——原来在 `setTimeout` 异步回调里注册 `onClose`，服务若 30s 内关闭就漏注册、泄漏 PG 队列监听；改为同步注册 + 闭包捕获 teardown。

**潜在引入风险**：
- `4cce965` finishReason 只处理 `'length'`，Anthropic 返回 `'max_tokens'`——**Anthropic 模型触顶会静默截断完成**。
- `8e42dde` 分片改变批行为，500 是保守值（7 参/条，上限约 9362），安全。
- `#79` PG 队列扫环是新调度机制，依赖幂等兜底。

### 3. 技术债务、遗留问题、隐性风险汇总

- **架构腐化迹象**：`@los/agent/src/` 根目录平铺 80+ 文件，其中 25+ 个 `governance-*`/`ga-*` 散落无子目录。
- **barrel 耦合**：`index.ts` 重导出 ~70 符号，`governance-jobs.ts` 纯转发桶。
- **文件顶到 600 行红线**：`memory/core/store.ts`、`memory/core/compaction.ts` 均 600 行，再加一行即触发 CI block。
- **配置旁路**：executor 多处 `process.env.*` 直读绕过 `@los/infra/config`；`config.executor` 缺 `host/port/artifactRoot`。
- **三源状态枚举**：YAML 契约、`execution-transitions.ts`、读侧字符串匹配各定义一份。
- **provider URL/模型名 2-4 处重复**（AP8）：`config.ts` + `scanners.ts` + `model-profiles.ts`。
- **开发机绝对路径写死进源码**（`firing-range-scan.ts`、`todo-seeds-runtime-core.ts`）。
- **`.env` 弱 token** `test-token-123` 且 `LOS_AUTH_ENABLED=true` 已强制。
- **WeClaw curl-pipe-to-shell 自动安装**默认开启——供应链风险。

## 二、各模块逐一盘点

| 包 | 定位 / 职责边界 | 对外能力 | 依赖 | 职责单一性 | 问题 |
|---|---|---|---|---|---|
| **@los/infra** | 横切层：Zod config、PG pool、logger、provider discovery、迁移 | `config/db/logger/discovery/migrate` | pg/zod/yaml | 清晰 | `.dependency-cruiser.json` 跨包导入仅 `warn`；config 默认值与 Zod `.default()` 双份 |
| **@los/agent** | ReAct 循环、provider、工具、session、spec-loader、治理 | `runAgent`、scheduler、message-router 子路径 | @los/infra | 内部腐化 | 治理 25+ 文件无目录；双模型未接线；deferred-registry 死码；`as any` 多处 |
| **@los/memory** | PG 全文记忆 + 观测 + 压缩 + MEMORY.md + CBM 图客户端 | ~40 导出 | @los/infra/agent | 基本清晰 | store/compaction 顶 600 行；`addObservation` 每次 `count(*)`；双 schema 管理；syncMemoryMd 未自动调用；'simple' 分词 |
| **@los/gateway** | Fastify HTTP + SSE/WS + React UI + 路由组合 | `createServer` | infra/agent/memory + fastify | 大体清晰 | `server.ts` 内联 `/workspace` 路由违规；`chat-service.ts` 592L；operatorToken 未接线；los-mcp-server 默认端口 3000 错；communication-routes weclaw 18011 硬编码 |
| **@los/executor** | 独立 mesh 执行节点：agent task、node-command、file-sync | `startExecutor` | infra/agent | 清晰 | `process.env` 旁路 config；`node-command-runner` cwd 脆弱；无 key 时生成临时 key |
| **@los/cli** | 网关 HTTP 客户端 CLI | `los <cmd>` 16 子命令 | agent/memory | 薄客户端 OK | `index.ts` 522L 单体 |
| **@los/input-preprocessor** | LLM 输入预处理：类型检测 + 降噪 + 安全不变量 | `preprocessInput` | infra/zod | 设计良好 | **整包未接入 runtime**，过早建设；`safety.ts:90` 模块级可变计数器非并发安全 |
| **@los/media** | TTS/图/视频生成 + 持久化 | `executeMediaOperation` | infra | 聚焦 | `media-runtime.ts` 540L；persist `bytes:0` TODO |
| **@los/telegram-bot** | SSE→Telegram 告警 + 审批按钮 | 独立进程 | agent(message-router) | 424L 尚可 | 默认网关端口 3000 错；webhook 无密钥校验；`as any` |
| **@los/wechat-bot** | WeClaw+WxPusher+移动 Web 多通道 | 独立进程 | agent/media/infra | 通道抽象好 | 默认端口 3000 错；**curl-pipe 自动安装**；SSE 解析与 telegram 重复 |
| **@los/web** | React SPA（20 页） | Vite 构建产物 | React19/TanStack | 页面切分干净 | `chat-page.tsx` 592L；vite.config 18 处重复 gateway URL |
| **tools/** | 8 阶段 CI 门 + 结构/契约/安全/耦合/状态机/未接线检查 | shell 脚本 | bash/dep-cruiser | 各司其职 | `check-security.sh` 用 `git grep`；`ci-gate.sh` 阶段编号重复 |
| **deploy/systemd** | executor 单元 | `los-executor.service` | systemd | 单文件 | 硬编码 `/opt/los`、`User=los`、端口 8090；内存 256MB 过低；ExecStart pnpm glob 脆弱 |
| **bin/los** | 薄壳 → @los/cli | 可执行 | tsx | 12 行 | dev 下强制走 tsx，无法切生产模式 |

**职责越界/重叠**：
- `governance-wake.ts` 与 `governance-drift-sweeper.ts` 唤醒路径重叠。
- `session-events.ts` 混 store CRUD + 可观测性投影。
- `governance-sweeper.ts` 混扫环编排 + todo 生成。
- ADR 0020 说压缩实现切片在 `packages/agent/src/memory-compaction.ts`，实际在 `packages/memory/src/core/compaction.ts`。
- telegram/wechat 两 bot 的 SSE 解析、告警格式化、operator action 流程高度重复，应下沉共享包。

## 三、架构合理性专项检查

### 1. 分层、领域划分、依赖流向
**整体合理**：infra → {agent, memory} → gateway → {cli, web, bots}；executor 作为 mesh 节点平行。contract-first + Zod config + PG-first 三原则贯彻。

**不合理点**：
- `.dependency-cruiser.json:14-22` 的 `no-cross-package-direct-import` 设为 `severity:"warn"`，**CI 不阻断**，等于原则 3（infra 强制横切）只靠自觉。应升 `error`。
- executor 直读 `process.env` 绕过 config（`index.ts:58,60,67,68,337`），config schema 又缺 `executor.host/port/artifactRoot`——配置层有洞。

### 2. 分层/分包/目录规范
- `@los/agent/src/` 根平铺 80+ 文件，`governance-*`/`ga-*` 25+ 个无目录——**最大结构债**。
- `server.ts` 内联 `/workspace` 路由实现（`server.ts:132-135`），违反「server.ts 只做注册组合」。
- `governance-jobs.ts` 纯转发桶，多一跳无逻辑。

### 3. 抽象/下沉/复用/扩展
- **好的下沉**：工具能力分级、事务型 outbox、advisory lock 复用、stream lease 防双网关脑裂。
- **复用不足**：两 bot 的 SSE/告警/operator 流程重复；provider URL/模型名 3-4 处重复。
- **可扩展性**：契约 YAML + 审计 job 类型可插拔，扩展点设计到位。

### 4. 过度设计 / 设计不足 / 架构腐化
- **过度设计**：`input-preprocessor` 21 文件全栈建好却无消费者；`deferred-registry` 实现了没人用；`preloadDeferredEntries` 空函数。
- **设计不足**：契约 codegen 缺失；file-sync 队列无 DLQ/无 max-retry；`addObservation` 全表 count。
- **腐化**：治理文件平铺、barrel 巨大、`as any` 在 loop/governance 关键路径、ADR 与代码位置漂移。

## 四、硬编码专项全局排查

### 高危
| 项 | 位置 | 问题 |
|---|---|---|
| 开发机绝对路径 | `agent/src/firing-range-scan.ts:24,29`、`todo-seeds-runtime-core.ts:19-20` | `/Users/echerlos/...` 写死，换机即崩 |
| curl-pipe-to-shell | `wechat-bot/src/bridge/weclaw.ts:87-89` | `curl -sSL .../install.sh \| sh` 默认开启，供应链风险 |
| 网关默认端口错 | `gateway/los-mcp-server.ts:32`、`telegram-bot/index.ts:38`、`wechat-bot/index.ts:79` | 默认 `localhost:3000`，实际网关 8080 |

### 中危
| 项 | 位置 | 问题 |
|---|---|---|
| provider URL/模型名重复 | `infra/config.ts:56-60,76,378`、`discovery/scanners.ts:242-301,347-351`、`agent/model-profiles.ts:142-219` | 同一组 URL/模型 2-4 处定义（AP8） |
| 内联状态字符串 | `run-state-vocabulary.ts`、`agent-task-graph-read-model.ts`、`scheduler.ts`、`saas-todo-routes.ts:40`、`compaction-rows.ts:65` | 状态字面量散落 5+ 文件，非枚举 |
| WeClaw 端口/URL | `gateway/communication-routes.ts:159,178`、`wechat-bot/bridge/weclaw.ts:40` | `127.0.0.1:18011` 硬编码 |
| 魔法数字 timeout | `gateway/server-maintenance.ts:88,166`、`communication-routes.ts:139`、`wechat-bot/index.ts:371` | 裸 `setTimeout` 数值 |
| 工具结果截断 | `agent/loop/tool-runner.ts:95` | `slice(0, 8000)` 硬截断且不告知模型 |
| systemd 硬编码 | `deploy/systemd/los-executor.service:32-39` | `/opt/los`、`User=los`、`EXECUTOR_PORT=8090` |
| UI 文案内联 | `web/src/chat-helpers.ts:172` | `处理 Todo: ...` 应抽 i18n/常量 |

### 低危（可接受或已配置化）
- 网关 8080 / executor 8090 / 本地 provider 端口——均有 env 覆盖。
- `/etc/los/*` 系统路径——文档化的 layer-1 发现路径。
- 测试 fixture key——测试数据。
- `.env` 已正确 gitignore，`.env.example` 占位规范；但 `LOS_AUTH_TOKEN=test-token-123` 弱口令需替换。

**整改方案**：
1. 开发机路径 → env/配置驱动（`LOS_FIRING_RANGE_ROOTS`）。
2. provider URL/模型 → 单一 `provider-defaults.ts`，三处引用。
3. 状态字符串 → 从 `execution-transitions.ts` 导出 typed enum，读侧统一引用。
4. curl-pipe → 默认关闭自动安装，`WECLAW_AUTO_INSTALL` 改 opt-in，并校验 install.sh 哈希。
5. 端口默认 → 统一 `@los/infra` 的 `config.server.port`，bot/mcp 复用。
6. systemd → 模板化 + env 文件，`%i` 实例化。

## 五、缓存、队列、执行顺序、状态机专项校验

### 1. 缓存设计
**无应用级缓存层**（PG-first），穿透/击穿/雪崩防护 N/A。存在的「类缓存」机制：

| 机制 | 位置 | 评估 |
|---|---|---|
| 语义驱逐 | `semantic-eviction.ts` | 按尺寸+工具名前缀驱逐大结果为 stub，全量可经 location 回取。**无失效/TTL**，驱逐后该 session 永久 stub——设计如此，可接受 |
| 上下文水位 | `context-monitor.ts` | 3 档 0.60/0.75/0.85，去重回调——正确 |
| 熔断器 | `ga-circuit-breaker.ts` | no-op 3→降级/5→暂停，失败 3→half_open/5→open/24h 恢复——正确 |
| stream lease | `stream-lease.ts` | TTL 30s、心跳 ~10s、跨网关防脑裂——**实现优秀** |

**风险**：若未来引入应用缓存，需补 TTL、空值缓存、互斥重建、过期抖动。当前语义驱逐无失效是最近的「类缓存」隐患。

### 2. 消息队列
3+1 套 PG 队列，均 `FOR UPDATE SKIP LOCKED` + advisory lock + lease：

| 队列 | 位置 | 优点 | 缺口 |
|---|---|---|---|
| agent-task-graph | `agent-task-graph.ts:201-275` | lease 钳位 [1s,24h]、attempt 计数、过期→死信 | 无 heartbeat 刷新 |
| task-runs | `task-runs.ts:221-310` | `heartbeatTaskRun`、`pg_try_advisory_lock` 防并发回收 | 回收直接置 `failed`，**无显式 max-retry→DLQ 阈值** |
| file-sync | `executor/file-sync/store-queue.ts` | 500 分片防溢出、`reapStaleTransferring` 5min 回收 | **无 DLQ、无 max-retry、无 heartbeat 延展**——永久失败文件无限重扫 |
| governance-jobs | `governance-jobs-crud.ts:221-250` | 单 CTE claim 模式 | — |

**死信**：`dead-letter.ts` 持久表 + ack + `operator_attention_required` 事件——**到位**。
**幂等**：`findActiveTaskRunByDedupeKey` + 契约 `X-Idempotency-Key`——到位。

**不合规点**：
1. file-sync 队列无 DLQ/max-retry——永久失败文件死循环（M）。
2. task_runs 回收路径无重试计数阈值（M）。
3. file-sync 无 heartbeat 延展，长传输会被误回收（M）。
4. agent-task-graph 无 heartbeat 刷新（L）。

### 3. 业务执行流程与时序
- ReAct 主循环 `loop.ts:58-433`：setup → pre-exec phases → `provider.chat()` → 工具调用 → 压缩 → 循环。时序合理。
- **高危时序问题**：`finishReason` 截断处理（`loop.ts:273-295`）只识别 `'length'`，但 `providers/anthropic.ts:168` 把 `stop_reason` 原样传入——Anthropic 触顶返回 `'max_tokens'`，**不触发截断分支，静默以截断文本完成**。OpenAI 返回 `'length'` 才正常。跨 provider 语义未归一。
- 工具结果 `slice(0,8000)` 静默截断，模型不知被切。
- GA 自修复循环 `ga-loop-runner.ts:97-245` 每个 job 最多调 `runJobAudit()` 7 次，全工作区扫描型 job 成本高。
- `server-maintenance.ts` onClose 竞态已在未提交 diff 中修复。

### 4. 状态机实现
**实现质量高，接近最佳实践**：
- 正式迁移表：`RUN_SPEC_TRANSITIONS`(6态)、`TASK_RUN_TRANSITIONS`(7态)、`TOOL_CALL_STATE_TRANSITIONS`(9态)、`VERIFICATION_RECORD_TRANSITIONS`(5态)。
- `evaluateExecutionTransition`/`assertExecutionTransition` 校验 + 拒终态 + 非法迁移抛 `ExecutionTransitionError`。
- `transitionExecutionState` 单一入口，单事务 outbox。
- `validatePhaseStatusConsistency` 防 phase/status 漂移；`canMarkSucceeded` 前置校验。
- `check-state-machine-bypass.sh` 白名单拦截——**强 CI 门**。

**不合规点**：
- 读侧字符串匹配状态而非 typed enum——重命名即静默崩（L）。
- 契约、迁移表、读侧三处分别定义状态，无单一源（M，结构性）。

## 六、业务&代码实现漂移检查

| 漂移项 | 设计/文档 | 实际代码 | 严重度 |
|---|---|---|---|
| 契约→类型生成 | AGENTS.md「contracts → generated types → implementation」 | 无 codegen，类型手写靠 grep 粗校验 | M |
| Architect/Editor 双模型 | commit `8dadeb6` 宣称分离 | config/setup/message-builder 接好，`loop.ts` 零引用，切换逻辑不存在 | H |
| deferred tools | commit `a07f817` 提及 | `deferred-registry.ts` 死码，`preloadDeferredEntries` 空函数 | M |
| operatorToken | config schema 定义 + operator consent 闸门 | `auth-middleware.ts` 只查 `auth.token` | H |
| ADR 0020 压缩位置 | `packages/agent/src/memory-compaction.ts` | `packages/memory/src/core/compaction.ts` | L |
| syncMemoryMd 自动更新 | 文档串「每次新增观测自动更新」 | `addObservation` 不调用 | M |
| .los/spec agent/loop | 称 loop.ts ~595 行近 600 门 | 实际 433 行，spec 过时 | L |
| 路由 vs 契约 | 11 契约路由 | 全部注册，无缺失端点 | 清洁 |
| 状态枚举一致性 | run-spec.yaml 6 态 | `execution-transitions.ts` 完全一致 | 清洁 |

## 七、现状总结与问题定级

### 高危（影响核心正确性/安全，需立即处理）
1. **Architect/Editor 双模型未接线**——`loop.ts` 缺切换编排。
2. **Anthropic finishReason 截断静默**——`'max_tokens'` 不触发 `'length'` 分支，跨 provider 语义未归一。
3. **operatorToken 未强制**——operator consent 闸门形同虚设。
4. **WeClaw curl-pipe-to-shell 默认开**——供应链 RCE 风险。
5. **开发机绝对路径写死源码**——换机即崩。
6. **跨包导入门只 warn 不 error**——infra 强制横切原则未 CI 强制。

### 中危（维护/环境切换/隐性风险，近期处理）
7. file-sync 队列无 DLQ/max-retry/heartbeat。
8. provider URL/模型名 2-4 处重复（AP8）。
9. 状态字符串三源、读侧非枚举。
10. 网关默认端口 3000 错误（MCP + 两 bot）。
11. `memory/store.ts` & `compaction.ts` 顶 600 行红线。
12. `addObservation` 每次全表 `count(*)`。
13. 双 schema 管理（ensure-DDL vs migrate.ts 可漂移）。
14. executor `process.env` 旁路 config + schema 缺字段。
15. 契约 codegen 缺失。
16. 治理 25+ 文件平铺无目录。
17. input-preprocessor 整包未接入。
18. `.env` 弱 token `test-token-123`。

### 低危（规范/卫生，择机处理）
19. bot 间 SSE/告警重复代码；`as any` 多处；barrel 巨大；stale spec；systemd 硬编码；check-security `git grep` 脆弱；ci-gate 阶段编号重复；vite.config 18 处重复 URL；`setWorkspaceRoot` 死导出。

## 八、后续迭代规划与落地计划

### P0（本周，正确性/安全止血）
1. **归一 finishReason**：provider 层把 Anthropic `max_tokens`/OpenAI `length` 统一映射成内部 `truncated`，loop 只判内部态。补单测覆盖三家 provider。
2. **接线或下架 Architect/Editor**：若保留，在 loop 每轮按 `promptToolMode` 切换 architect/editor 提示与模型；若暂不做，从 config/setup 拆除避免假能力。
3. **operatorToken 强制**：`auth-middleware.ts` 增查 `x-los-operator-token`，补 e2e。
4. **WeClaw 自动安装改 opt-in + 哈希校验**：默认 `WECLAW_AUTO_INSTALL=0`。
5. **开发机路径抽 env**：`LOS_FIRING_RANGE_ROOTS`、`LOS_SEED_ROOTS`。
6. **提交未提交的 4 文件 diff**（onClose 竞态 + 数据形状修复，已是正确修复）。

### P1（2-3 周，债务偿还）
7. **dependency-cruiser 升 error** + 补 executor config 字段（`host/port/artifactRoot`），消除 `process.env` 旁路。
8. **file-sync 队列补 DLQ/max-retry/heartbeat**，对齐 task_runs 模式。
9. **provider-defaults 单一源**：抽 `@los/infra/provider-defaults.ts`，config/scanners/model-profiles 引用。
10. **状态 typed enum**：从 `execution-transitions.ts` 导出枚举，读侧统一引用。
11. **端口默认统一**：bot/mcp 复用 `config.server.port`，删 3000。
12. **契约 codegen**：YAML → Zod/TS 类型生成脚本，接入 ci-gate。
13. **`.env` token 轮换** + 文档 `LOS_AUTH_ENABLED/TOKEN`。

### P2（1-2 月，结构治理）
14. **治理子目录化**：`agent/src/governance/` 收拢 25+ 文件，拆 `governance-jobs.ts` 桶。
15. **拆 600 行红线文件**：`memory/store.ts`、`compaction.ts`、`chat-service.ts`、`cli/index.ts`、`media-runtime.ts`。
16. **bot 共享包**：抽 `@los/bot-core`（SSE 解析 + 告警格式 + operator action）。
17. **input-preprocessor 接入 agent loop** 或冻结待用。
18. **schema 单一管理**：`ensure*Store` 的 DDL 迁入 `migrate.ts`。
19. **`addObservation` 计数优化**：缓存计数或近似计数。
20. **ADR 0020 位置修订** + stale spec 更新。

### P3（持续，规范卫生）
- 清理 `as any`、死导出（`setWorkspaceRoot`、`preloadDeferredEntries`）、legacy index.html。
- `check-security.sh` 去 `git grep` 依赖；`ci-gate.sh` 阶段编号修正。
- systemd 模板化；vite.config URL 抽常量。
- 治理 GA 循环审计调用次数优化。

### 专项治理节奏
| 专项 | 落地窗口 | 关键动作 |
|---|---|---|
| 状态机 | P1 | typed enum + 读侧统一 |
| 队列 | P1 | file-sync DLQ/重试/heartbeat |
| 硬编码 | P0+P1 | 路径/URL/端口/状态四类 |
| 缓存 | P2 规划 | 引入应用缓存时一并补三防 |
| 契约漂移 | P1 | codegen + ADR 位置修订 |
| 结构腐化 | P2 | 治理目录化 + 拆红线文件 |

---

## 修复执行追踪

P0 项逐个落地记录见 `todos` 与下方日志。每项遵循 AGENTS.md Pre-Action Gate：`loadSpecsForFiles` → 查 anti-patterns → 编辑 → `pnpm check` → 400/600 行门。

| P0 项 | 状态 | 证据 |
|---|---|---|
| 1. finishReason 归一 | ✅ 完成 | `providers/types.ts` 加 `normalizeFinishReason`；anthropic/responses/openai 三家适配器归一；`loop.ts` 不改（词汇无关）。新增 `finish-reason.test.ts`(15) + 扩展 `responses-adapter.test.ts`(3)，28/28 通过；`pnpm check` 通过；结构门 exit 0（providers/ 11 文件 warn，与同级目录一致，非阻断）。 |
| 2. Architect/Editor 接线或下架 | ✅ 完成（完整接线） | 修 `getDefaultSystemPrompt` 死分支（ARCHITECT/EDITOR prompt 现已生效）；新增 `loop/architect-phase.ts`（无工具 architect 前置阶段 + `---plan-end---` 检测 + maxTurns 上限）；`setup.ts` 主循环改为 editor（editor provider + editor prompt）；`loop.ts` 跑 architect 阶段→注入 plan→editor 循环执行；`scheduled-task-runner.ts` 加激活桥 `runContract.mode==='architect-editor'`→`enabled`。新增 `architect-phase.test.ts`(7)，全量 467/467 通过，type-check 干净，loop.ts 481 行 < 600 门。 |
| 3. operatorToken 强制 | ✅ 完成 | 审计定位修正：operatorToken 已在 `request-context.ts` 用 timing-safe 校验（非访问门，是特权标志）；真 hole 是 operator 端点不检查 `isOperator`。新增 `requireOperator(req,reply)` 共享 helper（`auth.enabled && !isOperator`→403），应用到 `/sessions/:id/operator-events`(steering/followup)、`/operator/events/live`(SSE)，并对齐 `/security/scan*`（修复其 auth 关闭时也 403 的过严行为）。telegram/wechat/web 三处 `losHeaders` 现发送 `x-los-operator-token`；`.env.example` 文档化 `LOS_AUTH_*`/`LOS_OPERATOR_TOKEN`。新增 `operator-gate.test.ts`(5)，gateway 65/65 通过，两 bot type-check 干净。**运维跟进**：项目 `.env` 当前未配 `LOS_OPERATOR_TOKEN`，需设置后 bot 审批流才可用（auth 已启用）。 |
| 4. WeClaw 自动安装 opt-in | ✅ 完成 | `WECLAW_AUTO_INSTALL` 默认翻转为 opt-in（`=== '1'`，原 `!== '0'`）。`installWeclaw()` 不再裸 curl-pipe：下载脚本到内存 → sha256 校验 `WECLAW_INSTALL_SHA256`（必须 pin）→ 从临时文件执行；加 `WECLAW_INSTALL_URL` 的 https 校验。auto-install 现需双 opt-in（`WECLAW_AUTO_INSTALL=1` + `WECLAW_INSTALL_SHA256=<hash>`）。所有 hint 消息更新。新增 wechat-bot `test` 脚本 + `weclaw.test.ts`(6)，6/6 通过，type-check 干净。 |
| 5. 开发机路径抽 env | ✅ 完成 | `firing-range-scan.ts` 的 TARGETS 改 env 驱动（`LOS_FIRING_RANGE_PI_ROOT`/`LSCLAW_ROOT`）默认回落到 workspace 同级目录（`REPO_ROOT/../<project>` 命中 los-workspace 符号链接），不存在则跳过并提示；用法注释改相对路径。`todo-seeds-runtime-core.ts` 的 `analysisInputs` 绝对路径改可移植 `los-workspace://` 引用。全仓 grep 确认源码无残留 `/Users/echerlos/`。type-check 干净。 |
| 6. 提交未提交 diff | ✅ 完成 | 原始 4 文件治理修复 + P0-1..P0-5 共 6 组变更，按 bounded-context 原子拆分为 6 个 jj commit（父提交 4cce965）：①治理修复(onClose竞态+审计数据形状) ②finishReason归一 ③Architect/Editor接线 ④operator gate+WeClaw opt-in(安全加固) ⑤开发机路径抽env ⑥审计文档。每 commit 后 `pnpm check` 全门通过(exit 0)。未 push（待人工 review）。 |
