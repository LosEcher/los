# 对抗式审查·全仓代码(2026-08-13)

相对 `2026-08-07-adversarial-review-total.md` 的第二次总盘点。
上次盯执行链路的语义假象与接线缺口；这次按**攻击者模型**走代码，
不依赖运行时探针。

范围: `packages/{gateway,agent,executor,web,infra,wechat-bot,telegram-bot}`
当前树(含工作副本 `agent-tools.ts` / `session-events.ts`)。
方法: 鉴权 / 状态机 / 工具与远程执行 / 密钥与观测 四条线并行假设检验,
关键断言回读源码。未跑 `pnpm gate`、未打 live gateway。

证据标记: `[E]` 源码行可复现 · `[I]` 由多处源码合成 · `[U]` 未验证假设。

## 攻击者模型

| 编号 | 身份 | 现实对应 |
| --- | --- | --- |
| A1 | 能打到端口、无凭证 | `SERVER_HOST=0.0.0.0` 且 `auth.enabled=false`(Zod 默认) |
| A2 | 已认证非 operator | JWT `role=user`,或只有 `LOS_AUTH_TOKEN` |
| A3 | 不可信模型 / 注入文档 | 默认 `toolMode=project-write` 的 agent |
| A4 | 持有共享 `executor.agentKey` 的节点 | 被劫持的 remote executor |

产品已有 JWT `user`/`operator` 分权(`auth-routes.ts`,`request-context.ts`),
但绝大多数写路由只过了 `auth-middleware` 这扇门,没有 `requireOperator`。
08-07 修过的 run approve / IM `#command` / WS steering **仍然 gated**,本次不重复。

---

## 一、P0 — A2 即可在 gateway 进程落地

### 1. `POST /chat` 接受任意 `mcpServers[].command`

- 文件: `packages/gateway/src/chat-route.ts:45,161`
  · `chat-normalizers.ts:75-97`
  · `packages/agent/src/tools/external/mcp-stdio-transport.ts:31-34`
- 模型: A2
- 素描: `{"prompt":"x","mcpServers":[{"command":"/bin/sh","args":["-c","id"]}]}`
  注册工具时 `spawn()` 该命令,并合并 `process.env`。`/chat` 无 `requireOperator`。
  `normalizeToolMode` 缺省是 `project-write`,显式可传 `all`。
- 严重度: P0 · 置信: [E]
- 修复: 从 `/chat` 去掉请求级 stdio MCP;只加载 operator 已 inspect/pin/enable 的 registry。
  `toolMode !== read-only`、`sandboxMode`、`allowedTools` 覆盖一律 `requireOperator`。

### 2. MCP registry 写路径同样可 spawn

- 文件: `packages/gateway/src/routes/tools/mcp-routes.ts:91-190`
- 模型: A2
- 素描: `POST /mcp-servers`(`transport=stdio`,`command=/bin/sh`)
  → `POST /mcp-servers/:id/verify` → `MCPClient.connect()`。
  全程无 `requireOperator`。后续任意 chat 会再拉起该 server。
- 严重度: P0 · 置信: [E]
- 修复: inspect / upsert / enable / verify / reload / delete 全部 `requireOperator`。

### 3. `POST /todos/:id/dispatch` 吃调用方 `toolMode` + `workspaceRoot`

- 文件: `packages/gateway/src/routes/data/todo-routes.ts:238-253`
  · `packages/agent/src/todo-dispatch.ts`(调度入口)
- 模型: A2
- 素描: 先 `POST /todos`(也不 gated),再 dispatch
  `{"toolMode":"all","workspaceRoot":"/"}` 启动 scheduled agent。
- 严重度: P0 · 置信: [E]
- 修复: dispatch / seed 走 `requireOperator`;非 operator 忽略客户端 tool/workspace。

### 4. Provider CRUD 写并回显 `apiKey`

- 文件: `packages/gateway/src/routes/providers/provider-crud-routes.ts:93-132`
- 模型: A2
- 素描: `POST /providers` `{name,apiKey,baseUrl}` 写入进程内 `Config` 并
  `return { provider: { …apiKey } }`。Grok account adopt(`:55`)有 gate,这条没有。
  把 `baseUrl` 指到攻击者即可偷后续 chat 的 key 和 prompt。
- 严重度: P0 · 置信: [E]
- 修复: POST/PATCH/DELETE `requireOperator`;响应只留 `hasApiKey`。

---

## 二、P0 / P1 — 策略旁路与混乱代理

### 5. `spawn_agent` 是 L0,子代理可升到 `project-write`

- 文件: `packages/agent/src/tools/core/registry-policy.ts:111-129`
  · `packages/agent/src/tools/core/agent-tools.ts:250-293,462-490,588-590`
- 模型: A3(只读 chat 里的模型);工作副本注释与代码相反
- 素描: 父 `toolMode=read-only` → `maxRiskLevel=L0`。`spawn_agent` 在
  `READ_ONLY_BUILTIN_TOOLS` 且标 L0。注释写「child 永远只读、不能再 spawn」。
  `createSpawnAgentRunner` 却用 `request.toolMode ?? 'read-only'`,
  不钳制父策略。只读子代理仍注册 `spawn_agent`,可再开一个 write 子代。
  `inheritRunContractMetadata` 只克隆合同,不管工具集。
- 严重度: P0(策略边界被设计注释证伪) · 置信: [E]
- 修复: 子 `toolMode` ≤ 父;从只读清单和子 registry 去掉 `spawn_agent`;
  `project-write` 至少 L1 且要求父已有写权限。

### 6. 节点命令 / file-sync 用共享 `agentKey` 打调用方 URL

- 文件: `packages/gateway/src/routes/orchestration/node-command-routes.ts:54-94`
  · `packages/gateway/src/routes/infrastructure/file-sync-routes.ts:68-91`
  · `packages/agent/src/scheduler/executor-client.ts`(URL 只做 `http://` 补全)
- 模型: A2(路由无 operator);A4(改 heartbeat `commandUrl` / `healthUrl`)
- 素描: `POST /nodes/:id/commands` 无 `requireOperator`。若节点
  `connectConfig.agent_http.commandUrl` 存在,gateway `fetch` 并带
  `Authorization: Bearer ${executor.agentKey}`。Heartbeat 改 URL 会清
  `verified`(执行候选失效),但 file-sync / command proxy **不看** `execution.candidate`。
  `POST /nodes/:id/ssh-run` 与 `PATCH /nodes` **有** gate,形成缺口。
- 严重度: P1;有 live `commandUrl` 时升 P0 · 置信: [E]
- 修复: POST 命令与 file-sync `requireOperator`;出站 URL 必须是已 probe 白名单;
  每节点独立 key;禁止把 `agentKey`/`nodeUrls` 从 schedule body 原样收下。

### 7. 项目浏览 / 绑定任意目录,再当 workspace 写

- 文件: `packages/gateway/src/routes/infrastructure/project-routes.ts:78-110`
  · `packages/gateway/src/chat-normalizers.ts:21-25`(`path.resolve`,无 jail)
- 模型: A2
- 素描: `GET /projects/browse?path=/` → `POST /projects/bind {workspacePath:"~/.ssh"}`
  → `/chat`。`safeWorkspacePath` 只相对调用方给的 root。
- 严重度: P1 · 置信: [E]
- 修复: browse / bind / default / delete `requireOperator`;浏览限制在配置根下。

### 8. `http_request` / `web_fetch` SSRF,且为 L0

- 文件: `packages/agent/src/tools/external/web-tools.ts:200-254,406-419`
- 模型: A3(默认 coding + project-write 就有 web 工具)
- 素描: `isSafeUrl` 只做 hostname 正则。`http://127.1`、`[::ffff:127.0.0.1]`、
  十进制 IP、DNS 指回环、`redirect:'follow'` 到内网都不拦。
  `http_request` 允许自定义 `Authorization` + POST/PUT/DELETE。
  `checkCapability` 只对 **L1** 关写(`registry-policy.ts:169`),L0 带 sideEffect 的 HTTP 仍过。
- 严重度: P1 · 置信: [E]
- 修复: 解析后拦 IP(含映射 IPv6);每次 redirect 再查;写 HTTP 升 L2。

### 9. `needsApproval` 只是元数据,broker 自动放行

- 文件: `packages/agent/src/los-tool-broker.ts`(allowed → 直接 `running`)
  · `packages/agent/src/tools/builtin/job-tools.ts`(`run_background` `shell:true`,无沙箱)
- 模型: A3,前提是请求把 `toolMode=all`(默认不是;见发现 1)
- 严重度: P1(默认路径达不到;A2 打开 L2 后变 P0) · 置信: [E]
- 修复: 真正排队审批,或从 in-loop 目录删除 `run_background` / `run_runtime_task`。

---

## 三、P1 — 租户 / 身份绑定仍可被 body 绕过

`request-context.ts:57-65` 在 `auth.enabled` 时已把非 operator 的
`x-tenant-id`/`x-project-id` 钉死为 local/default。[E]
这是 07-10 M-09 的**部分**关闭。下列路由重新读 body/query/header,丢掉 `ctx`:

| 表面 | 位置 | 效果 |
| --- | --- | --- |
| `/chat` | `chat-route.ts:140-189` | `body.projectId` / 原始 `x-project-id` 进 intake |
| `POST /todos` | `todo-routes.ts:80-94` | `body.tenantId` 覆盖 `ctx.tenantId` |
| work-items / inbox | `work-item-routes.ts` | `body/query.projectId` |
| MCP list/pin | `mcp-routes.ts` | query/body tenant |
| SaaS todo dispatch | `saas-todo-routes.ts:97` | 路径参数即租户,无 operator |
| feed-analysis | `integration-routes.ts:191-207` | 服务 token 之后故意收 header(独立信任域) |

严重度: P1 · 置信: [E]

同簇、仅过门、无 operator 的敏感写(均为 [E]):

- `POST /work-items/:id/start`(result-decision 有 gate)
- skills / rules upsert、`sync-to-dir`
- `POST /memory/compact`、`/memory/sync-md`
- `DELETE /sessions/:id`、`POST /sessions/import`、`POST /runs/:id/claim`
- `GET /sessions`(无租户过滤)
- `POST /services/:id/drain|promote`
- `POST /tasks/:id/cancel`
- `GET /logs`、`/diagnostics*`(整行日志 / `SELECT *`)
- `GET /projects/browse`

原则: 身份只来自 JWT/`requestContext`;scope 覆盖仅 operator。

---

## 四、P1 — 状态机、租约、AP12

相对 07-10 / AP 文档,生产路径**不再**直接 `updateTaskRun({status})` /
`updateRunSpecStatus`。[E] 但 AP1 **没有关死**。

### 10. tool-call fallback 可改写终态

- 文件: `packages/agent/src/scheduler/tool-call-state-persistence.ts:69-95`
  · `tool-call-states.ts:140-180`
- 失败模型: SM 拒绝非法跳转后,catch 无条件 `updateToolCallState`,`SET state`
  无 from-state、无终态守卫。晚到的 NDJSON 可把 `succeeded` 写成 `failed`,
  或清掉 `completed_at`。
- `recovery-follow-up.ts:102-127` 并行写 `retrying`,只补审计事件。
- 严重度: P1 · 置信: [E]
- 修复: fallback 仅允许缺行或非终态;`UPDATE … WHERE state=$expected`。

### 11. AP1 CI 门扫不到多行 import

- 文件: `tools/check-state-machine-bypass.sh:46-57`
- `recovery-follow-up.ts` 单独一行 import `updateToolCallState`,不在
  `ALLOWED_FILES`,门仍绿。
- 严重度: P2(让 10 能合进去) · 置信: [E]

### 12. 调度 run 双持有者可「偷失败」

- 文件: `packages/agent/src/scheduled-work/runner.ts:176-227`
  · `store.ts:246-257,396-426` · `recovery.ts:104-118`
- 失败模型: `transitionScheduledWorkRun` 乐观更新、无 `lease_version`。
  租约过期后 reaper 把行给 B;`A` 终态跳转非法,catch 写成 `failed`,
  并推高 circuit。`createManualScheduledWorkRun` 冲突时 `RETURNING` 已有
  claimed/running 行再 `execute`。
- 严重度: P1 · 置信: [E] 转移数学 / [I] 现场频率(30m+heartbeat)
- 修复: 终态写必须带 `claim_owner`+fence;丢租约的 owner no-op,不要 `failed`。

### 13. Chat 成功路径:SM 抛了 todo 仍 `done`(AP3+AP12)

- 文件: `packages/gateway/src/chat-route-persist.ts:68-94`
  · `chat-run-completion.ts:36-69`
- `applyDirectRunCompletionStatus().catch(() => undefined)`。
  抛错时 `runCompletion` 为 undefined → `blockedIds.length ?? 0 === 0`
  → todo 写成 `done`,run_spec 留在非终态。
- 严重度: P1 · 置信: [E]
- 修复: 只在 committed transition 之后回写;走 `applyTodoOutcome`。

### 14. run-resume 不回写成功/取消(AP12)

- 文件: `packages/gateway/src/run-resume-dispatch.ts:70-88,143-174`
- `onTaskEvent` 只处理 running/failed/blocked;`completed`/`cancelled`
  转 run_spec,todo 留 `in_progress`。
- 严重度: P1 · 置信: [E]

### 15. `blocked` 不是真状态

- `scheduled-task-terminal.ts` worker-block 只改 metadata,task_run 仍 `running`。
- `blocked` 不清 lease;reaper 看不见;之后无 fence 的
  `blocked → running → succeeded` 任意进程可做。
- 严重度: P1 · 置信: [E]

### 16. agent-task recover 在 SM 外写状态

- `agent-task-graph/lease.ts` SQL `running → queued|failed`,无 outbox。
- `updateAgentTaskStatus` 无 fence 时 `WHERE id=$1`。
- 严重度: P1 · 置信: [E]
- 注: 07-10 写的「heartbeat/recover 未接线」已过时 — reaper 与
  executor fencing **已接线**。[E]

### 17. 子 run_spec 只写 `result_json`,status 停在 `created`

- 文件: `agent-tools.ts:232-236,608-630`
- 无 `canMarkSucceeded`、无 outbox。`query_agent` 从 result 猜完成。
- 严重度: P2(治理/回放) · 置信: [E]

---

## 五、P1 — 密钥、可见性、默认部署

### 18. session 脱敏只认 key 名,数组丢掉父 key

- 文件: `packages/agent/src/session-events.ts:583-597`
- `{stdout:"export OPENAI_API_KEY=sk-…"}`、`privateKey`、数组里的 key 原文入库。
  `cacheKey` 列不脱敏。无 `SECRET_KEY_RE` 单测。
- 严重度: P1 · 置信: [E]

### 19. visibility 分类了,读端几乎不用

- `sessionEventVisibility()` 把 `tool_call_state.*` 标 internal,
  governance/ops/child.agent 标 audit。
- `listSessionEvents` 默认 `includeInternal !== false` → 全账本。
- SSE/WS/run/trace 不滤。HTTP `?includeInternal=1` 无 operator 门。
- `insertSessionEvent`(AP1 路径)不写 `visibility`,NULL 当 public —
  工作副本分类**盖不住** SM 插入。
- 严重度: P1 · 置信: [E]

### 20. 日志无脱敏;`GET /logs` 非 operator

- `packages/infra/src/logger.ts` 原样铺 meta。
- `log-routes.ts` 返回绝对路径 + `entries[].raw`。
- 严重度: P1 · 置信: [E]

### 21. AP8: 默认 auth 关 + compose 绑 0.0.0.0

- Zod `auth.enabled` 默认 `false`(`config.ts:62`)。
- `docker-entrypoint.sh` 强制 `SERVER_HOST=0.0.0.0`;compose 发布 8080,
  auth 环境变量注释掉;DB 密码 `los-dev` 写死。
- 本机 checkout 的 `.env` 已开 auth — 这是**默认部署**洞,不是当前进程洞。
- 严重度: P1(默认镜像) · 置信: [E]
- 修复: 非 loopback bind 且 auth 关则拒启动;compose 强制 token。

### 22. Query token + 门用 `===`

- `auth-middleware.ts:48-63,88-103` 接受任意路由上的
  `?operator_token` / `?access_token`,字符串 `===`。
- `request-context` 只看 header 且 timing-safe → query operator
  **进得了门、拿不到 `isOperator`**(requireOperator fail-closed)。
- Web EventSource/WS 把两个 token 放进 URL。
- 严重度: P1(日志/Referer/历史) · 置信: [E]

### 23. Web: token 在 localStorage;markdown 无 sanitize;默认无 CSP

- `packages/web/src/api/client.ts:199-240` 存 `los-auth-token` 和
  `los-operator-token`。一次 XSS = 全权。
- `markdown-renderer.tsx` 无 `rehype-sanitize`;`a.href` 原样过。
- `security-headers.ts` 默认不发 CSP。
- 严重度: P1(链路) / P2(单点 markdown) · 置信: [E]/[I]

---

## 六、P2 与加固

| 项 | 证据 | 说明 |
| --- | --- | --- |
| 首个 `/auth/register` 非原子 | `auth-routes.ts:44-57` | 空库并发两个不同用户名都可成 operator |
| JWT 7 天、不可吊销、role 在票内 | `auth-store.ts:35,77-96` | 降权要等过期。自实现 HMAC,header `alg` 不用 — 不是 alg-none |
| 公开 `GET /settings`、`/auth/status` | `auth-middleware.ts:17-21` | 泄露 provider 名、`hasApiKey`、userCount。`/health` 前缀匹配 `/health*` |
| `safeWorkspacePath` 不 `realpath` | `path-safety.ts:3-13` | workspace 内 symlink 逃出 |
| ADR 0034 sandbox 未落地 | `shell-sandbox.ts:186-225` | macOS `(allow file-read*)`;Linux `--ro-bind / /`。`sandbox` 是 workspace-write 别名 |
| seatbelt cwd 插值 | 同上 | 路径含 `)` 可能破 profile [I] |
| 子/父 `runSpecId` 混用 | `agent-tools.ts:582,657` | 子事件挂到父 spec |
| `query/kill/list_agents` 进程全局 | `agent-tools.ts:298-419` | 跨 session 读 prompt / 杀子代理 |
| artifact `isHumanAttestation` 请求体布尔 | `artifact-routes.ts` | 用户 JWT 可自称 human |
| `sql_query` 关键字过滤 | `sql-query-tool.ts` | 非默认 toolset;`pg_read_file` 不拦 |
| operator runtime `extraArgs`/`env` | `runtime-adapter-routes.ts` | Codex/Claude 可 argv 注入;Grok 已禁 |
| WeClaw QR/status 无 operator | `communication-routes.ts:227` | UUID 不可猜,但 id 泄露则世界可读 |
| outbox 无毒丸/DLQ | `execution-outbox.ts` | 永久失败一直 pending;NOTIFY 与 transition 双发 |
| probe kill-switch 进程内 | `node-auto-probe.ts` | N gateway ⇒ N 倍探测 |
| `check-security.sh` 盲区 | `tools/check-security.sh` | secret 只 WARN;不扫 authz / `shell:true` / localStorage |

---

## 七、已证伪 / 仍关闭(相对 07-10 与 08-07)

| 假设 | 结果 |
| --- | --- |
| run approve/revise/verify/recover/answer 无 operator | 否 · `run-routes.ts:188-366` |
| `POST /runtimes/:kind/run` 无 operator | 否 · `runtime-adapter-routes.ts:95` |
| settings PATCH / private GET 无 operator | 否 |
| OpenAI `#command` / WS steering 跳过 operator | 否 |
| Telegram / WxPusher 入口无认证 | 否(07-10 P0 仍关) |
| `/api/integrations/*` 裸奔 | 否 · 自有 timing-safe token;未配置则 503 |
| heartbeat 在配置了 `agentKey` 时对用户开放 | 否 · `auth-middleware.ts:38-41` |
| 非 operator 伪造 `isOperator` | 否 |
| 生产仍 `updateTaskRun({status})` | 否 |
| `canMarkSucceeded` 可被 `run_spec → succeeded` 跳过 | 否 · transition 事务内 FOR UPDATE |
| due-slot 双 claim | 否 · `FOR UPDATE SKIP LOCKED` + unique slot |
| 08-07 远程通道未接线 / 随机选点 / 同步 approve | 仍关(PR #203+) |

07-10 文档里「heartbeat/recover 未接线」应改 — 现已接线。[E]

---

## 八、与 08-07 待办对照

| 08-07 项 | 2026-08-13 |
| --- | --- |
| quality 快照不触发改进 | 仍开,本次未加深 |
| 经验→技能全人工 | 仍开 |
| 长期 in_progress todo | **代码层确认**:chat persist + run-resume(发现 13/14) |
| session_events 体积 | 仍开;可见性分类未接到读端 |
| sandbox 升级 | 仍开;ADR 0034 未实现,且 L2 工具可绕过 |
| 对抗式审查制度化 | job 在;本次补了**代码攻击面**,不是 metric 语义 |

---

## 九、建议修复顺序

1. **立刻(A2 RCE / 凭据)**
   - 去掉 `/chat` 请求级 `mcpServers`;MCP registry + provider CRUD + todo dispatch + 节点命令 + file-sync + project bind/browse 全部 `requireOperator`。
   - 响应永不回 `apiKey`。
2. **策略边界**
   - 钳制 `spawn_agent`;从只读清单和子 registry 删除。
   - 非 operator 禁止 `toolMode=all` / 自定义 sandbox / workspace 覆盖。
3. **状态**
   - 禁止终态 fallback 覆写;修 AP1 门;调度终态带 fence;chat/resume 走 `applyTodoOutcome`。
4. **身份**
   - 所有路由的 tenant/project 只信 `requestContext`。
   - query token 仅限 WS/SSE;门与 privilege 共用 timing-safe。
5. **观测 / 默认部署**
   - 读端默认 `visibility=public`;logger + `/logs` 脱敏并 operator-only。
   - 非 loopback 禁止关 auth 启动。
6. **工具加固**
   - 真 SSRF;`realpath` workspace;落实 `needsApproval` 或删 L2 in-loop 工具。

---

## 十、本次未做

- 未跑 `pnpm gate` / 包测试 / live `/health`。
- 未对 WeClaw 二进制是否拉取 `media_url` 做动态确认 [U]。
- 未在浏览器验证 React 19 是否拦截 `javascript:` href [U]。
- 未审计 `packages/cli` MCP serve 的跨租户头转发(测试里有 `x-tenant-id`)。
- 工作副本另有研究文档 `docs/research/2026-08-13-agent-collab-raft-vs-grok-los.md`,与本审查无关。

残留风险:单机、只给自己 operator JWT、且不把 8080 暴露到局域网时,
P0 需要先偷到 `LOS_AUTH_TOKEN` 或 XSS 抽 localStorage。
一旦存在第二个 JWT `user`、或共享 access token 发给非 operator,
上表 P0 全部可打。
