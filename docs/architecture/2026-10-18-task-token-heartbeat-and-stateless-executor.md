---
subject: 任务令牌心跳迁移、远端 executor 去 DB 化、工具 scope 治理
auditedRev: 8461a263be68 (los git HEAD，2026-10-18)
readOnly: true
method:
  - 源码阅读（task-token / task-routes / executor index / lease-fencing / executor-client / node-enrollment / registry-policy / los-tool-broker）
  - 真库/运行态探针（LOS_TASK_TOKEN_SECRET 未配置；node34/M3 executor 在线）
  - 用户提供的已合并提交与测试结果（标注为 [用户提供]）
---

# 任务令牌心跳、远端 executor 去 DB 化、工具 scope 治理

## 1. 结论

1. **任务令牌本身不是缺口；缺的是“投递 + 消费 + 失败语义”。**
   网关已经能 mint/verify，heartbeat 端点也已经只认 `x-los-task-token`；但 token 从未进入 dispatch body，executor 也从未调用该端点。生产里确实只有测试在用它，没有“接了但没用”的假绿。

2. **“executor 接上 heartbeat”与“远端撤掉 DATABASE_URL”不是同一步。**
   心跳只解决 task lease；executor 仍用 DB 做 agent task lease、artifact 索引、file-sync 清单、迁移和 store 初始化。把 DB 撤掉是一个“无状态远端 executor”项目，至少要分 4 个阶段。

3. **任务令牌只能替代 executor→网关的“续租”凭据，不能替代网关→executor 的 dispatch 凭据。**
   `EXECUTOR_AGENT_KEY` 仍用于网关调用 `/v1/tasks/run-agent`；要撤掉它需要 mTLS 或 per-node dispatch token，属于另一条线。

4. **scope 覆盖不要“给 47 个工具都补 scope”。**
   scope 只对“参数里可能出现 tenant/project/run/session/task id”的工具才有意义；其余 `[]` 是正确声明。缺的是**分类、分母、按工具启用 block、以及 `los tools --check` 的静态摘要**。

5. **两条线并行、一个共同门禁**：
   Track A = 工作区交接（Batch 1.2/1.3 → Lease）；Track B = 执行身份（任务令牌 → 无状态远端 executor）。两者都通过后，才允许把远端 agent run 作为默认路径。

## 2. 现状核对

| 项 | 现状 | 判据 |
|---|---|---|
| 任务令牌 mint/verify | 已有 `lst1` HMAC，payload `{tid,lv,exp}`，TTL 60s–1h | `packages/gateway/src/task-token.ts` |
| heartbeat 端点 | `POST /tasks/:id/heartbeat` 只认 `x-los-task-token`；过期 401、跨 task 403、旧 lease 409 | `packages/gateway/src/routes/orchestration/task-routes.ts:193` |
| 令牌签发端点 | `POST /tasks/:id/token` 仅 operator；当前无生产调用方 | 同上 `:145` |
| secret 配置 | `LOS_TASK_TOKEN_SECRET` **未在 `.env` 配置**；未配置时端点 503 | `.env` 检查 |
| dispatch body | 无 `taskToken` 字段 | `packages/agent/src/scheduler/executor-client.ts:254` |
| executor 续租 | `heartbeatTaskRun` / `heartbeatAgentTask` 直接写 PG | `packages/executor/src/index.ts:352`、`lease-fencing.ts:10` |
| executor 启动 | `initDb` + `migrateDir` + `ensureAllAgentStores` | `packages/executor/src/index.ts:6-7,80-90` |
| 节点凭据 | 30 天 TTL、24h 双凭据重叠轮换 | `packages/agent/src/node-enrollment.ts`（[用户提供] 提交 c2ccdcc3/4b0821ed/cc6f1e16） |
| scope 声明 | 注册期要求 `scope` 存在；声明的 id 必须在 `parameters.properties`，不要求 required | `packages/agent/src/tools/core/registry-policy.ts:220-240` |
| scope 读取 | `evaluateScopeGate` 只比对“参数里真的给了值”的 id；context 缺失记为灰区 | 同上 `:287` |
| scope 强制 | 默认 warn；`LOS_TOOL_SCOPE_ENFORCEMENT=block` 才拒；block 下 contextMissing 也拒 | `packages/agent/src/los-tool-broker.ts:96-125,249` |
| scope 覆盖 | [用户提供] 47 工具中仅 3 个 todo 工具非空；warn 事件 0；分母 6 次 `todo_list` | `tools/scope-mismatch-report.sh` |
| `los tools --check` | 未实现 | CLI 无该命令 |

## 3. Track B：任务令牌心跳迁移

### 3.1 目标

让远端 executor 在**不持有数据库凭据**的前提下续租 task run：

```text
gateway ──dispatch(taskToken)──> executor
executor ──POST /tasks/:id/heartbeat (x-los-task-token)──> gateway
gateway ──heartbeatTaskRun()──> Postgres
```

同机 `mbp-executor-1` 可保留 direct-DB 路径；远端节点走 HTTP。

### 3.2 阶段 A（向后兼容，先接线）

1. **把 `task-token.ts` 移到共享包**（`packages/agent/src/task-token.ts` 或 `packages/infra`），gateway 保留 re-export，避免 gateway/agent 双实现。
   理由：mint 要在 scheduler 里发生，而 scheduler 属 `@los/agent`；不能反向依赖 gateway。
2. **dispatch body 增加 `taskToken?`**：`runAgentOnExecutor` 入参 + body；token 只放在 dispatch envelope，**不放进 `config`、不放进 prompt、不写 session event**。
3. **mint 点**：`scheduled-task-execution.ts` 在调用 `runAgentOnExecutor` 前，用 `getConfig().executor.taskTokenSecret` + `taskRunId` + `leaseVersion` mint；secret 未配置则 `undefined`（阶段 A 兼容）。
4. **executor 选择 transport**：
   - `body.taskToken` 存在 ⇒ HTTP heartbeat；
   - 不存在 ⇒ 现状 direct DB；
   - 存在但 `gatewayUrl` 为空：`required` 模式 **fail-loud**；`auto` 模式只告警并保留 direct DB（仅过渡期本地 executor，远端必须设 `required`）。
5. **HTTP heartbeat 客户端**：
   - `POST ${gatewayUrl}/tasks/${taskRunId}/heartbeat`
   - header `x-los-task-token`
   - body `{ leaseMs }`
   - 成功返回 `{ok, leaseVersion, heartbeatAt, leaseExpiresAt, taskToken?, expiresAt?}`
6. **初始心跳**：agent 启动前也必须走同一 transport；失败则任务不启动。
7. **健康面**：`/health` 增加 `leaseTransport: "http-when-token"|"db"`、`taskTokenMode`（不泄露 token）。

### 3.3 失败语义（必须机械验收）

| 情况 | 行为 |
|---|---|
| 401 `invalid_task_token` / `expired` | **立即 abort**，不回落 DB；任务进 failed，事件带 reason |
| 403 `task_token_scope_mismatch` | 立即 abort；这是 bug/攻击，不能重试 |
| 409 `lease_lost_or_expired` | 立即 abort；旧 lease 不得继续写 |
| 网络错误 / 5xx / 超时 | 指数退避重试；到 lease 截止仍失败才 abort |
| token 存在但 gatewayUrl 缺失 | `required`：fail-loud；`auto`：告警 + direct DB（仅过渡期本地 executor） |
| token 不存在 | 维持 direct DB（仅阶段 A） |

**关键**：token 存在时，任何失败都不得回退到 DB。否则“过期令牌⇒401”会被静默回退掩盖，重演 C1 的假绿。

### 3.4 长任务：token 续签

当前 TTL 上限 1h；长构建/长 agent run 会超过。建议：

- heartbeat 响应在剩余 TTL < 15min 时返回**新 token**（同一 taskRunId + leaseVersion）；
- executor 原子替换内存中的 token；响应丢失时旧 token 仍有效到 exp，下一次心跳再换；
- 不新增 operator 端点，避免把“续签”变成人工动作；
- 如果 leaseVersion 换代，旧 token 自然失效，新 token 必须等新 dispatch。

### 3.5 secret 轮换

`LOS_TASK_TOKEN_SECRET` 轮换会让所有在跑任务立刻 401。需要与节点凭据同型的**双 secret 重叠窗口**：

- 配置 `LOS_TASK_TOKEN_SECRET` + `LOS_TASK_TOKEN_SECRET_PREVIOUS`；
- verify 先试 current，再试 previous；两者都只在该窗口内有效；
- mint 只用 current；窗口结束后移除 previous；
- 观测：`task_token_verify_total{result=...}`，轮换期间 previous 命中数应逐步归零。

### 3.6 阶段 B：无状态远端 executor（不是一步）

删掉 `DATABASE_URL` 前，先列出 executor 的 DB 依赖并逐项替代：

| 依赖 | 当前用途 | 替代路径 |
|---|---|---|
| `heartbeatTaskRun` | task lease | HTTP heartbeat（阶段 A） |
| `heartbeatAgentTask` | agent task lease | 新增 HTTP 端点或在 task heartbeat 里带 agentTaskLease |
| `loadTaskRun` | lease 丢失时判断 cancelled | heartbeat 响应带 status，或 409 即视为 lost |
| `ensureAllAgentStores` / `migrateDir` | 启动建表 | 无 DB 时不执行；本地 store 用 SQLite/文件 |
| `artifacts` | 索引 + 本地文件 | 本地 artifact store + 网关索引；或 executor 只做 put/get，索引回传网关 |
| `file_sync_*` | 扫描清单/队列 | 本地 SQLite 或仅本地 manifest + 网关汇总 |
| `node_commands` | 节点运维 | 网关控制面，不需要 DB |
| `maintenance.ts` | 本地运维 CLI | 仅 local executor 使用 |

建议阶段：

- **B1**：task lease HTTP；DB 仍保留（agentTaskLease/artifacts/file-sync）。
- **B2**：agent task lease HTTP；无 agentTaskLease 的任务可完全脱离 DB 续租。
- **B3**：artifact / file-sync 本地化或网关化；远端 executor 启动不再 `initDb`。
- **B4**：远端节点撤 `DATABASE_URL`；启动断言：
  - `EXECUTOR_TASK_TOKEN_MODE=required`
  - `GATEWAY_URL` 必填
  - `DATABASE_URL` 为空时 `health.db = "none"`，且 `leaseTransport=http`
  - 负向控制：无 token 的 dispatch 被拒绝。

**验收**：node34 上跑一个 10 分钟任务，进程环境无 `DATABASE_URL`，`ss/lsof` 无 55432 连接，任务仍能续租、完成、回传 artifact；gateway 重启期间任务进入明确 blocked/retry，不静默丢。

## 4. Track C：scope 治理

### 4.1 先分类，不要 blanket 补 scope

对每个工具做三分类：

| 类型 | 判据 | 处理 |
|---|---|---|
| **应声明非空 scope** | `parameters.properties` 含 `tenantId/projectId/runSpecId/sessionId/taskRunId`，且工具会用它定位资源 | 声明对应 id；加负向测试 |
| **不应声明** | 工具只操作 workspace 路径/命令/文件，不触达上下文 id | 保持 `[]`，并在 `los tools --check` 里显示“已判定为空” |
| **需要契约改造** | 工具隐含项目/租户但参数没有 id | 先加可选参数或从 context 注入，再声明；不要声明一个没人读的 id |

当前 44 个 `[]` 里，大部分应属第二类；不能把“空”当成“漏”。

### 4.2 分母与证据

- 合成 harness：构造 project A / tenant A / session A / task A 的 run，调用每个 scoped 工具，分别传 A（通过）、B（mismatch）、缺省（contextMissing）。
- 断言：warn 模式产生事件且 handler 执行；block 模式拒绝且 handler 不执行。
- 观察期分母至少覆盖每个 scoped 工具 ≥ 20 次，而不是只看 `todo_list` 6 次。
- 报表保留 `contextMissing` 与 `mismatch` 两个口径；block 前先决定 contextMissing 是拒还是放。

### 4.3 按工具启用 block

当前只有全局 `LOS_TOOL_SCOPE_ENFORCEMENT`。建议：

- `ToolCapability` 增加 `scopeEnforcement?: 'warn' | 'block' | 'off'`；
- 优先级：工具级 > 全局 env > 默认 warn；
- 先对 todo 三件套开 block；证据足够再逐个扩；
- `off` 只用于确实不触达上下文的工具，且必须在 `los tools --check` 里可见。

### 4.4 `los tools --check`

新增 CLI（`packages/cli/src/tools.ts`）：

```text
los tools --check
los tools --check --json
```

输出摘要：

- total / scoped / empty / needsApproval / sideEffect / risk 分布；
- 每个工具的 `scope`、`permissions`、`riskLevel`、`sideEffect`、`parallelizable`；
- lint：
  - scope id 不在 schema properties（boot 已 fail，这里做静态复验）；
  - schema 有 context id 但 scope 为空（WARN，需人工判定）；
  - `sideEffect=true` 但 permissions 为空（WARN/FAIL 按基线）；
  - `needsApproval=true` 但无 sideEffect/permissions（FAIL，boot 已拦）。
- `--check` 退出码 1 表示有未登记漂移；基线文件 `tools/tool-scope-baseline.json` 只减不增。

## 5. 与现有 Batch 的关系

推荐改成两条并行主线 + 三条支线：

```text
Track A（工作区）  Batch 1.2 artifact 推拉 → 1.3 20x/M3 → 2.0 Lease
Track B（身份）    Batch 2.1 token 投递 → 2.2 失败语义/续签 → 2.3 无状态 executor B1-B4
Track C（工具治理）Batch 3.1 inventory → 3.2 分母 harness → 3.3 按工具 block → 3.4 tools --check
Track D（体验）    Batch 4 统一 inbox / 移动审批 / push
Track E（安全）    Batch 5 shared key→mTLS/per-node dispatch、Tailscale ACL、provider 边界
```

**共同门禁（远端 agent run 默认化的前提）**：

1. 内容身份：输入 digest、workspace prepare/seal、patch 可重建；
2. 执行身份：远端无 DB 凭据、task token heartbeat、旧 lease 不能写；
3. 策略：scope/approval/verification 在远端真实生效；
4. 证据：run/task/session/artifact/trace 可 join；
5. 失败：离线、取消、重复提交、租约过期均有明确状态。

**顺序建议**：

- Batch 1.2 与 Batch 2.1 可并行（不同文件：workspace artifact vs task token）。
- Batch 2.1 完成后，Batch 2.2 与 1.3 并行。
- Batch 2.3（无状态 executor）必须在 Batch 1.3 通过后启动，否则会把“工作区没跑通”和“去 DB 没跑通”混在一起。
- Batch 3 可与 2.x 并行，但 block 切换必须在有分母之后。
- Batch 4/5 最后。

## 6. 拒绝清单

1. 不在没有 token 投递路径时，先给 executor 加一个“可选 token 参数”然后宣称已接。
2. 不在 token 失败时回退 direct DB（会把 401 变成假绿）。
3. 不把 `EXECUTOR_AGENT_KEY` 和 task token 混为一谈：前者是网关→executor dispatch，后者是 executor→网关租约。
4. 不在只接上 task heartbeat 后就宣布“可以撤 DATABASE_URL”。
5. 不给 47 个工具 blanket 补 scope；`[]` 是合法声明。
6. 不在分母不足时把全局 scope 切 block。
7. 不把 `los tools --check` 做成 grep 式门禁；它应读 registry 的 capability，输出可复核摘要。

## 7. Batch 2.1 实施记录（本轮）

已落地的**最小切片**（只覆盖阶段 A，不宣称去 DB 化完成）：

1. `task-token.ts` 从 gateway 移到 `@los/infra/task-token`；gateway 保留 `task-token.ts` re-export，既有 import/测试不变。
2. `executor.taskTokenMode`（`auto|required|off`，可选，默认按 `auto` 处理）；env `EXECUTOR_TASK_TOKEN_MODE`。
3. `runAgentOnExecutor` 从 dispatch 输入解析 token：
   - 显式 `taskToken` 优先（测试用）；
   - 否则在 `taskTokenSecret` 存在且模式不为 `off` 时 mint；
   - `required` 且无 secret ⇒ 抛错，不静默派发。
4. dispatch body 增加 `taskToken`；**不进入 `config`/prompt**。SSH 路径也把 token 放进 payload。
5. executor：
   - `RunAgentRequest.taskToken?`；
   - `_renewTaskRunLease` 支持 HTTP，401/403/409/503 映射为明确 reason；
   - `_renewTaskLease` 在 HTTP 路径上**不查 DB、不回退 DB**；
   - 初始心跳与 interval 心跳共用同一 transport；
   - 启动断言：`required` 必须有 `GATEWAY_URL`；`auto` 下 token 无 `GATEWAY_URL` 只告警并保留 DB（过渡期本地 executor）；
   - `/health` 增加 `taskTokenMode`、`leaseTransport`。

**验证**：

| 测试 | 结果 |
|---|---|
| `packages/infra/src/task-token.test.ts` | 9/9（含 previous-secret 轮换窗口） |
| `packages/agent/src/scheduler/executor-client.test.ts` | 8/8（含 token 只在 envelope、不在 config） |
| `packages/executor/src/lease-fencing.test.ts` | 4/4（含 HTTP 200/401/409；401 不回落 DB；200 带新 token 会替换） |
| gateway `task-token-routes + task-token-heartbeat-db` | 8/8（含续签窗口内返回新 token） |
| `pnpm --filter @los/{infra,agent,executor,gateway} check` | 全部 exit 0 |

### 7.1 Batch 2.2 已做（续签 + 双 secret）

- heartbeat 响应在剩余 TTL ≤ 15min 时返回新 `taskToken` / `taskTokenExpiresAt`；executor 收到后原子替换 `http.taskToken`，旧 token 仍有效到自己的 `exp`。
- `taskTokenSecretPrevious` / `LOS_TASK_TOKEN_SECRET_PREVIOUS`：验证接受 current 或 previous，mint 只用 current。
- 客户端不再只能等 1h 到期：长任务在每次心跳时自然续签。

### 7.2 2026-10-18 实机验证（gateway + 独立 executor）

**Gateway 实机**（重启后 `pid=57380`、`version=0.1.0+b03c971b9c64b`，`.env` 已配置 `LOS_TASK_TOKEN_SECRET`）：

| 探针 | 结果 |
|---|---|
| `POST /tasks/:id/token`（`ttlSeconds=60`） | 200，返回 token |
| `POST /tasks/:id/heartbeat`（带 token） | 200，`leaseExpiresAt` 前进，返回新 `taskToken`（续签窗口生效） |
| 同一 heartbeat 不带 token | 401 `invalid_task_token / malformed` |
| A 的 token 续 B | 403 `task_token_scope_mismatch` |
| `lease_version` 从 1 改 2 后旧 token 续租 | 409 `lease_lost_or_expired` |

测试任务已从 `task_runs` 删除（`count=0`）。

**Executor 实机**（独立进程：`EXECUTOR_NODE_ID=token-verify-node`、`:18090`、`EXECUTOR_TASK_TOKEN_MODE=required`、`GATEWAY_URL=http://127.0.0.1:18080` 指向 mock gateway）：

| 探针 | 结果 |
|---|---|
| `/health` | `taskTokenMode=required`、`leaseTransport=http-when-token` |
| 带 token dispatch | mock 收到 `POST /tasks/verify-task/heartbeat`，header `x-los-task-token: tok-live-123`；随后因故意使用不存在的 kernel 返回 500（心跳已发生） |
| 不带 token dispatch | 500 `task token is required...`；mock 没有新增 task heartbeat（在派发前拒绝） |
| mock 返回 401 | 500 `execution lease lost ... (token_invalid)`，**没有回落 DB** |
| mock 返回 409 | 500 `execution lease lost ... (lease_lost)` |

> 这证明 executor 的新代码在真实进程里会发 HTTP heartbeat，并且 401/409 走 abort。它**没有**证明 node34/M3 已部署；远端节点仍是旧版本。

### 7.3 Batch 3.4 已做：`los tools --check`

- 新增 `packages/cli/src/tools.ts`；`registerBuiltinTools(..., { skipMcp: true })` 构建与运行时同一个 registry，不连 MCP。
- 输出摘要：`total / scoped / empty / errors / warnings`；逐工具输出 scope、permissions、risk、sideEffect。
- 当前实测：`total=38 scoped=3 empty=35 errors=0 warnings=0`（**built-in only**；47 的口径包含 MCP 工具，不在本命令内）。
- `--strict` 把 warning 也变成 exit 1；`--json` 输出 `los.cli.tools/v1`。

**仍未做（不要误报为完成）**：

- `agentTaskLease` 仍直连 DB；
- artifact / file-sync 仍直连 DB；远端撤 `DATABASE_URL` 未开始；
- 尚未把新 executor 部署到 node34/M3（gateway 已重启并配置 secret；独立 executor 只在 mock gateway 上验证）；
- SSH 路径只透传 token，远端是否消费取决于其版本。

## 8. 未决问题

1. ~~`task-token.ts` 放 `@los/agent` 还是 `@los/infra`？~~ 已选 `@los/infra`（gateway/agent 都依赖 infra，gateway 保留 re-export）。
2. ~~token 续签放在 heartbeat 响应，还是单独 refresh 端点？~~ 已选 heartbeat 响应内续签，少一个鉴权面。
3. 远端 executor 的 artifact/file-sync 本地化，优先 SQLite 还是纯文件 manifest？建议先纯文件 + 网关索引，避免又引入一个本地 DB。
4. `scopeEnforcement` 是工具级字段还是 registry 配置？建议工具级字段，默认继承全局。
5. Batch 2.3 的“无 DB”是否包括 file-sync？如果 node34 仍要跑 file-sync，B3 不能省。
