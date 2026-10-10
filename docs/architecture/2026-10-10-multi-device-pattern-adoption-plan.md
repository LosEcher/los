# 多设备机制迁移：分期执行计划（2026-10-10）

- **依据**：`docs/research/2026-10-10-cindy-multi-device-mechanism-audit.md`（参考实现机制审计；15 条 `可直接落地`、4 条 `作决策依据`、4 条 `仅设计原则`、10 条 `不可迁移`）
- **首个决策**：`adr:0048`（路由准入分类与读模型作用域）
- **执行纪律**：每批**一个 change / 一个 bookmark / 一个 intent**（`AGENTS.md` Change Rules）。每批有**出口判据**，不满足不进下一批。**B1 运行期行为零变化**——这是刻意的：先把"谁允许访问什么"变成可机械核对的事实，再改行为。

---

## 一、批次总览

| 批次 | 主题 | 迁移项 | 依赖 | 运行期行为变化 | 出口判据（机械） |
| --- | --- | --- | --- | --- | --- |
| **B1** | 路由准入分类 + 门禁 | D3、D3b | 无 | **无**（纯 `tools/` 门禁；不碰 `packages/**`） | 已完成（`file:tools/check-route-admission.mjs:1`）：265 条集合相等、34 条送审名单、自检 8/8、端到端探针被咬、接入 `file:package.json:40` |
| **B2** | 读模型作用域 + fail-closed | D10、D11（作用域侧） | B1（分类表给出"谁是非 operator 主体"） | **有**（`WHERE` + 未分类路由启动失败） | B2A 已完成（`file:packages/gateway/src/routes/orchestration/tool-gate-routes.ts:193`）：控制面 8 条收紧，operator 59→67，送审名单 74→64；B2B-1 已完成（`file:packages/gateway/src/request-context.ts:200`）：`/tasks`+`/sessions` 的 list/detail 加 tenant 作用域，隔离回归 3 处；B2B-2 已完成（`file:tools/route-admission-operator-required.txt:1`）：29 条运维观测读收紧，operator 67→96，G4 锁定 96 条；B2C 已完成（`file:packages/gateway/src/route-admission-guard.ts:1`）：运行期守卫告警档 + G5 生成物无 diff 门禁，真实 server 零告警，并实证补上插件路由盲区；**B2B-3 待做**（产品资源读的准入分类，需产品 vs 运维的线） |
| **B3** | 节点身份接线 | D9、D14 | B2（作用域先于身份粒度） | B3-step-1 **无**（纯增量发送侧）；step-2 有（心跳鉴权收紧） | step-1 已完成（`file:packages/executor/src/executor-heartbeat.ts:26`）：节点配了凭据就发头、没配不发；网关闭环 4 例（有效 200／错配 401 不建行／伪造 401／缺失 200 过渡宽松）。step-2（缺失即拒）待 operator 定时机 |
| **B4** | 客户端语义 | D1、D2/D12、D11、D13 | 无（可与 B2/B3 并行） | **有**（UI/订阅） | D1 已完成（`file:packages/web/src/nodes-registry-filter.ts:20`）；D11 两个渠道已完成（`file:packages/agent/src/operator-event-stream-cursor.ts:1`）；D12 已具备 + 新增边界门禁（`file:packages/web/src/data-access-boundary.test.mjs:1`）；**D13 / D2 核定后不做或延后**（各有触发条件，见对应核定） |

**依赖图**

```
B1 ──> B2 ──> B3
        │
B4 ─────┘（B4 独立；但"给手机加视图"必须等 B2 的作用域，否则是放大暴露面）
```

- **B1 可独立开工**（纯增量 + 门禁，零行为变化）。
- **B4 不阻塞任何人**，但它的**产品化排序**依赖 B2：先把任务面安全地暴露给非 operator 主体，再加手机形态。
- **B3 在 B2 之后**：节点身份是"授权粒度"的前提，但作用域先错的话，per-node 身份只会让错误的授权更精细而已。

---

## 二、B1：路由准入分类 + 门禁（本批）

### 目标

把"每条路由对谁开放"从**散落在 259 个注册点的隐含事实**变成**一张可机械核对的声明表**，并让"新增端点未分类"在 CI 失败而不是在生产被任何 `role=user` 主体读到。

### 落点（实现形态，2026-10-10 定稿）

原设计把分类表放在 `packages/gateway/src/route-admission.ts` 并由运行期守卫消费。实现时改为**纯 `tools/` 门禁 + 数据文件**，原因是 `file:tools/check-wiring-topology.ts:99` 的接线门禁要求 `src/` 的新导出必须有非测试调用方：只为测试而导出的表会被判为孤儿导出，而运行期守卫（B2）尚未落地。因此 B1 刻意**不碰 `src/`**，保持"运行期行为零变化"。

| 动作 | 路径 |
| --- | --- |
| 新增（扫描 + 三门禁 + 负向控制） | `tools/check-route-admission.mjs` |
| 新增（生成物：路由清单，265 条） | `tools/route-admission-inventory.txt` |
| 新增（生成物：送审名单，34 条，棘轮只减不增） | `tools/route-admission-review.txt` |
| 编辑（接入 `pnpm check`） | `package.json` |

### 设计要点

1. **三档分类**（`public` / `authenticated` / `operator`），公开面**不另立一份真源**：脚本从 `file:packages/gateway/src/auth-middleware.ts:10` 的三个常量文本解析，因此公开面只有一处定义。
2. **G1 完备性（集合相等）**：源码里的每条路由都在清单中，反向也成立 → 新增路由必然在 review diff 里出现一行。
3. **G2 送审名单（棘轮）**：**变更类方法 + 所属文件无 `requireOperator` + 不是公开路径** ⇒ 必须登记。当前 34 条，是 B2 收紧工作的输入清单。名单只减不增。
4. **G3 声明与执行一致**：operator 归属**由源码事实给出**（该文件是否真的调用 `requireOperator`），不是手写声明；文件删掉门禁会改变清单 → G1 失败。粒度为**文件级**，脚本头部显式声明该限制，不假装逐路由精度。
5. **扫描器自证**：注册点数必须等于解析出的路由数，否则失败（防止新注册形式被静默漏扫）——当前 265 = 265。
6. **运行期零变化**：不改 `preHandler`、不改 `auth-middleware` 内容、不改公开白名单。运行期守卫（告警档 → fail-closed）整体归入 B2。

### 出口判据（已达成，证据见右列）

| 判据 | 证据 |
| --- | --- |
| 分类表对扫描到的路由集合相等 | `file:tools/route-admission-inventory.txt:1`（265 行，`pnpm check:route-admission` 通过） |
| 声明/执行一致性断言成立 | operator 归属由源码 `requireOperator` 事实派生（`file:tools/check-route-admission.mjs:203`） |
| 送审名单存在且带棘轮 | `file:tools/route-admission-review.txt:1`（34 条） |
| 负向控制全部被咬住 | 自检 8/8（`file:tools/check-route-admission.mjs:264`）；端到端探针：新增一条未登记 `POST` ⇒ 门禁 exit 1 并同时报 G1+G2，移除后 exit 0 |
| 接入 CI 门禁 | `file:package.json:40`（`check` 末尾追加 `pnpm check:route-admission`） |
| 运行期行为零变化 | 本批没有 `packages/**` 源码改动（`jj diff --stat` 可复核） |

### 本批明确不做

- 不把已存在的宽松路由**收紧**（34 条送审名单就是留给 B2 的 diff）。
- 不动 `requireOperator` 的实现语义（含 `auth.enabled=false` 恒真这条，B2 处理）。
- 不逐路由判定 operator 归属（需要 AST；B1 的文件级判定已足以让"新增可写路由"必然送审）。

---

## 三、B2：读模型作用域 + fail-closed

### B2A（先做）：控制面写路由收紧 —— 已完成（`file:packages/gateway/src/routes/orchestration/tool-gate-routes.ts:193`）

**结论纠正（重要）**：B1 首版用**文件级**判定 operator 归属，把 111 条路由错报成"已有门禁"，因此当时报给 operator 的"34 条可写路由"是**低估**。升级为**逐路由窗口判定**后，真实数字是 **74 条**。这正是"门禁自己也会说谎"的实例，已修。

| 项 | 值 |
| --- | --- |
| 收紧的路由（8 条，控制面） | `POST /operator/tool-gate`、`POST /operator/tool-feedback`、`POST /operator/tool-gate/fragile-files`、`POST /services/:id/drain`、`POST /services/:id/promote`、`POST /ops/daily-digest/push`、`POST /tenants/:tenantId/projects/:projectId/todos/dispatch`、`POST /tenants/:tenantId/projects/:projectId/todos/reconcile` |
| 收紧方式 | 每条 handler 首行加 `if (!(await requireOperator(req, reply))) return;`（与 `file:packages/gateway/src/routes/orchestration/node-command-routes.ts:55` 同款） |
| 分类计数变化 | operator 59 → 67；送审名单 74 → 64 |
| 门禁自身修正 | 逐路由窗口判定（`file:tools/check-route-admission.mjs:151`）；新增 `self-authenticated` 档，排除 `POST /nodes/heartbeat`（`agentKey` 自证）与 `POST /nodes/enroll`（一次性 token 自证）两个假阳性 |
| 自检 | 9/9（新增"自证端点不进送审名单"断言） |
| 类型检查 | `pnpm --filter @los/gateway check` 通过 |
| 受影响测试 | `service-routes.test.ts` / `usage-routes.test.ts` / `tool-gate-routes.test.ts` 共 9 项通过（须带 `--import ./src/test-setup.ts`，否则 `getConfig()` 未加载会 500——这是调用方式问题，不是回归） |

**语义边界（必须知道）**：`requireOperator` 在 `auth.enabled=false` 时**恒真**（`file:packages/gateway/src/request-context.ts:167`）。因此这 8 条门禁只在**启用鉴权**的部署里生效；本地单用户开发仍是 fail-open。这是既有语义，B2B 若要改必须单独决策。

**送审名单剩余 64 条的分布（B2B 的输入，未收紧）**：`/memory/*` 7、`/runs/:id/*` 6、`/execution-experiments/:id/*` 5、`/todos/:id/*` 4、`/rules/*` 4、`/skills/*` 9、`/pairwise-sample-gates/*` 3、`/providers/*` 3、`/runtimes/*` 2、`/tenants/.../todos/*`（已收紧，故为 0）、`/sessions/*` 2、`/run-evals/*` 3、`/work-items/*` 3、`/run-backlog`·`/eval-backlog/run`、`/external-summaries`、`/projects/:projectId/touch`、`/tasks/:id/cancel`、`/v1/chat/completions` 等。**产品资源面（memory / rules / skills / artifacts）按 operator 的选择留到下一步**：它们要么收紧为 operator-only（若 Web 以普通用户登录，会 403），要么加 `(tenant,project,user)` 所有权作用域。

### B2B-1（已完成）：`/tasks` 与 `/sessions` 的 tenant 作用域（`file:packages/gateway/src/request-context.ts:200`）

| 项 | 内容 |
| --- | --- |
| 新增助手 | `resolveReadScope(req)`：auth 关闭或 operator ⇒ `undefined`（跨租户可见）；已认证非 operator ⇒ 自身 tenant。**只按 tenant，不按 project**（见 `adr:0048` §3.1 实测） |
| 读模型 | `listTaskRuns(limit, scope?)`（`file:packages/agent/src/task-runs.ts:342`）、`listSessions(limit, scope?)`（`file:packages/agent/src/session.ts:115`）——可选参数；内部调用方（scheduler/governance/fleet）不传，视图不变 |
| 路由接线 | `GET /tasks`、`GET /tasks/:id`（`file:packages/gateway/src/routes/orchestration/task-routes.ts:89`）、`GET /sessions`、`GET /sessions/:id`（`file:packages/gateway/src/routes/data/session-routes.ts:71`） |
| 越权读的响应形状 | 跨租户直读单条返回与"不存在"相同的 `{ error: 'Not found' }`，不做存在性预言机 |
| 回归测试 | DB 隔离：`file:packages/agent/src/task-runs.test.ts:333`、`file:packages/agent/src/session.integration.test.ts:15`（各自断言"另一租户不泄漏 + legacy NULL 行对作用域读者 fail-closed + 无作用域视图不变"）；解析单测 3 例：`file:packages/gateway/src/request-context.test.ts:156` |
| 检查 | `pnpm --filter @los/agent test` 448 项通过；`pnpm --filter @los/gateway test` 250+111 通过；`pnpm check` exit 0 |

**为什么只做 4 个端点**：读侧实测 135 条 GET 中 119 条既无作用域助手也无 operator 门禁，但**多数是运维观测面**（`/diagnostics*`、`/metrics*`、`/slo/*`、`/governance/*`、`/file-sync/*`），它们的正确处置是 **operator-ization**，不是租户过滤。所以 B2B 的其余部分不是"逐条加 `resolveReadScope`"，而是**读准入分类**：

- **B2B-2**：运维观测读 → operator（与 B2A 同一意图，作用于读侧）。
- **B2B-3**：产品资源读（`/memory`、`/skills`、`/rules`、`/artifacts`、`/work-items`）→ 需要产品 vs 运维的线，且涉及所有权模型（operator 已明确"下一步再定"）。

### B2B-2（已完成）：运维观测读收紧 + G4 门禁锁定

**判据（可评审，非临时清单）**：读的是**进程/车队/账本健康面**，而不是用户工作产物。按此判据收紧 **29 条**运维观测读：

| 家族 | 条数 | 文件 |
| --- | --- | --- |
| `/diagnostics*` | 6 | `file:packages/gateway/src/routes/infrastructure/diagnostics-routes.ts:120` |
| `/metrics`、`/metrics/trends`、`/metrics/activity` | 3 | `metrics-routes.ts`、`usage-routes.ts` |
| `/logs`、`/logs/files` | 2 | `log-routes.ts` |
| `/governance/jobs*` | 2 | `governance-routes.ts` |
| `/file-sync/status`、`/file-sync/events` | 2 | `file-sync-routes.ts` |
| `/services`、`/services/:id` | 2 | `service-routes.ts` |
| `/usage/summary`、`/ops/daily-digest`、`/ops/runtime-health` | 3 | `usage-routes.ts` |
| `/slo/report` | 1 | `slo-routes.ts` |
| `/daily-agent-quality/baseline` | 1 | `daily-agent-quality-routes.ts` |
| `/cross-project/summary` | 1 | `cross-project-routes.ts` |
| `/sessions/:id/trace`、`/trace/since`、`/execution-observability` | 3 | `trace-routes.ts` |
| `/tasks/orphans`、`/tasks/dead-letter`、`/tasks/dead-letter/summary` | 3 | `task-routes.ts` |

**判据不是新政策**：`file:packages/gateway/src/operator-gate.test.ts:1` 的头部记录的正是同型事故——"operator-only 端点未强制 operator 权限，任何已认证用户都能注入 steering 并订阅他人的 operator 事件"。B2B-2 是**补完既有修复**（外加 Web 端本就支持 `x-los-operator-token`，见 `file:packages/web/src/api/client.ts:165`）。

**新增 G4 门禁锁定**（`file:tools/route-admission-operator-required.txt:1`，96 条）：把"必须保持 operator 门禁"的路由固化成清单；**移除任何一条门禁 ⇒ CI 失败**。这是"声明 operator 却不再执行门禁"的机械防线，也是 B2A/B2B-2 两批收紧的回归保护。

| 项 | 值 |
| --- | --- |
| 分类计数变化 | operator 67 → **96**；authenticated 182 → 153；送审名单不变（64，均为写路由） |
| 自检 | **10/10**（新增 G4 负向控制） |
| G4 端到端负向控制 | 移除 `GET /metrics` 的门禁 ⇒ exit 1 且信息指名该路由；恢复 ⇒ exit 0 |
| 测试期望更新 | 2 处按新边界更新（`governance-routes.test.ts`、`task-dead-letter-routes.test.ts`），并各补 1 条"非 operator 读 ⇒ 403"断言 |
| 检查 | `pnpm --filter @los/gateway test` 250+111 通过；`pnpm check` exit 0 |
| 实现细节 | 3 个表达式体 handler 转为块体（`/diagnostics/outbox`、`/cbm-cache`、`/redaction`）；门禁所在 handler 的参数表统一为 `(req, reply)` |

### B2C（已完成）：运行期守卫（告警档）+ 生成物无 diff 门禁

ADR 0048 决策 2 的"先可核对、再 fail-closed"里的**可核对**一半落地。

| 项 | 内容 |
| --- | --- |
| 生成物 | `file:packages/gateway/src/route-admission-inventory.ts:1`（265 条，由 `--update-embedded` 生成） |
| 无 diff 门禁 | G5：门禁重算期望内容并与磁盘**逐字节**比较 ⇒ 新增/删除路由而不重新生成，CI 直接失败 |
| 运行期守卫 | `file:packages/gateway/src/route-admission-guard.ts:1`：`onRoute` 收集真实注册表 → `onReady` 与清单对账，两个方向指名告警；在 `file:packages/gateway/src/server.ts:149` 注册（必须先于任何路由模块） |
| 插件路由白名单 | `PLUGIN_CONTRIBUTED_ROUTES = ['GET /*']`（`@fastify/static`）——**显式列出**而非模式化忽略，其余未知一律报名字 |
| 回归测试 | `file:packages/gateway/src/route-admission-guard.test.ts:1` 4 项：已分类路由不报、未分类路由**指名报**、清单过期按条数报、插件 wildcard 与自动 HEAD 不报 |
| 检查 | `gateway` 255+111 通过；`pnpm check` exit 0；`check:wiring` 0 新孤儿；真实 server 上**零告警** |

**实证价值（本批最重要的产出）**：首次在真实 server 上开启守卫，它立刻报出 `GET /*` —— 来自 `server.ts` 里 `@fastify/static` 注册的 wildcard。**源码扫描器只能看见 `app.<method>('<path>')`，对插件注册天生失明**，所以这条路由既不在清单里、也永远不会被 CI 门禁发现。结论：运行期守卫不是 CI 门禁的重复，而是补上了它的盲区。

**两个踩坑记录（供后续生成物参考）**：

1. **文件名不能叫 `*-routes.ts`**：`file:tools/check-structure.sh:1` 会把 `packages/gateway/src/` 下的 `*-routes.ts` 判为"路由模块放错位置"（`.los/spec/gateway/route` 的明文规则）。改名 `route-admission-inventory.ts` 后通过。
2. **生成物必须导出为函数，不能导出数据常量**：`file:tools/check-wiring-topology.ts:77` 的孤儿导出模型是"导出必须被调用"，数据数组永远不会出现 `NAME(` ⇒ 被判孤儿。改为 `export function admissionRouteKeys()` 后 0 新孤儿。

这两条都是**门禁自己的模型**决定的形态，不是风格偏好——写新生成物前先按这两条设计接口，可以少一轮返工。

### 目标

让"非 operator 主体能看到/改到什么"成为**服务端推导的确定事实**，并让未分类路由在启动期就失败。

### 落点（首批）

| 动作 | 路径 |
| --- | --- |
| 编辑（作用域过滤） | `packages/agent/src/task-runs.ts`（`listTaskRuns`） |
| 编辑（路由层传作用域） | `packages/gateway/src/routes/orchestration/task-routes.ts` |
| 编辑（节点读模型作用域） | `packages/gateway/src/routes/infrastructure/node-routes.ts` |
| 编辑（运维事件流作用域） | `packages/gateway/src/routes/streaming/operator-events-sse.ts` |
| 编辑（翻 fail-closed） | `packages/gateway/src/route-admission.ts`（守卫档位） |
| 新增/编辑测试 | `packages/gateway/src/route-admission.test.ts`、`packages/agent/src/task-runs.test.ts`（若不存在则新建并分类） |

### 设计要点

- 作用域过滤走**同一条代码路径**：`auth.enabled=false` 时收敛到配置默认 `tenant/project`，而不是"不过滤"。理由是 `file:packages/gateway/src/request-context.ts:166` 的恒真语义会把本地开发变成"作用域逻辑从未被执行"。
- `operator` 的越权读取是**显式**路径（可审计），不是缺省行为。
- fail-closed 与分类表首次落地**必须分开两个变更**：B1 让表正确，B2 才让表生效。

### 出口判据

- 机械用例：主体 A（`role=user`）的 `GET /tasks` 不含主体 B 的行；`GET /nodes` 同理；越权直读单条资源返回 404/403 而非数据。
- 未分类路由 ⇒ 启动失败（负向控制）。
- 读延迟复测：给受影响的读路径报告真实端到端延迟，不得用内存库基准代替。
- 既有运维面板不出现"因过滤而空数据"；若出现，按 `adr:0048` 的重新评估触发条件 3 处理（显式 operator 化，而不是回退过滤）。

---

## 四、B3：节点身份接线

### 目标

让 `executor_nodes` 的每一行对应一个**可区分**的节点身份，而不是所有节点共享一把 `agentKey`。

### B3-step-1（已完成）：发送侧接线（纯增量，不改变任何鉴权结论）

| 项 | 内容 |
| --- | --- |
| 配置 | `executor.nodeCredential`（`file:packages/infra/src/config.ts:255`）+ 环境键 `EXECUTOR_NODE_CREDENTIAL`（`file:packages/infra/src/config-sources.ts:47`） |
| 发送 | 节点心跳在配置了凭据时带 `x-los-node-credential`；未配置则**不发该头**（`file:packages/executor/src/executor-heartbeat.ts:26`） |
| 网关 | 不改：已有校验（存在则验、且要求 `enrollment.nodeId === nodeId`；缺失仍接受）保持不变 |
| 节点侧回归 | `file:packages/executor/src/executor-heartbeat.test.ts:57`：配置 ⇒ 发头且 `authorization` 仍为共享 key；未配置 ⇒ **无该头** |
| 网关侧回归（闭环） | `file:packages/gateway/src/node-routes.test.ts:209`：真 enrollment 兑换后——有效凭据 ⇒ 200；**别家凭据 ⇒ 401 且不建行**；伪造 ⇒ 401；**缺失 ⇒ 200**（过渡宽松，车队不会被一次性打下线） |
| 检查 | `infra` 75、`executor` 35、`gateway` 251+111 全通过；`pnpm check` exit 0 |

**为什么先做这一半**：`x-los-node-credential` 的**读取侧早就存在于网关**，但全仓没有任何调用方发送它（B3 现状段的实测），而**校验路径此前完全没有测试覆盖**。发送侧接线 + 闭环测试把"有校验无发送方"这个半成品补齐，且**不改变任何现有鉴权结论**——未携带凭据的节点照旧工作。

### 剩余：B3-step-2（收紧，需 operator 定时机）

- **收紧**（启用 enrollment 后缺失凭据 ⇒ 401）是兼容性闸门：必须先确认**所有在线节点**都能发送凭据，否则会一次性把车队打下线。落地顺序照 `file:SKILL.md:69`：先发被控端（executor），再收紧网关。
- 迁移期语义必须写成**显式配置**（开关 + 作用域），不是隐式行为；开关本身要经 `@los/infra` config。
- 可选增强：让 executor 在给定一次性 enrollment token 时**自行调用** `/nodes/enroll` 并把凭据落盘，省掉手工两步 REST（属独立改动）。
- 与 B2 的关系：per-node 身份只有在作用域正确之后才有意义（否则只是把错误的授权切得更细）。

### 现状（本次已复核，保留作为出发状态）

`POST /nodes/enrollment-tokens` → `POST /nodes/enroll` → `verifyNodeCredential()` 三件套齐备（`file:packages/gateway/src/routes/infrastructure/node-routes.ts:99`、`file:packages/agent/src/node-enrollment.ts:35`），但 `x-los-node-credential` 全仓只有读取侧一处在用（`file:packages/gateway/src/routes/infrastructure/node-routes.ts:204`），执行器从不发送；且**未携带 credential 的心跳不会被拒**（`file:packages/gateway/src/routes/infrastructure/node-routes.ts:206`）。

---

## 五、B4：客户端语义（可并行）

四项**互相独立**，可各自一个变更：

| 项 | 目标 | 落点 | 出口判据 |
| --- | --- | --- | --- |
| D1 | 在线态三态：**未知不等于离线** | `packages/web/src/fleet-card.tsx`、`packages/web/src/nodes-registry-filter.ts` | 已完成（`file:packages/web/src/nodes-registry-filter.ts:20`）：见下方 D1 证据 |
| D2/D12 | 列表级变更流 + 整表/增量**纪元栅栏** | `packages/gateway/src/routes/data/session-routes.ts`、`packages/web/src/api/` | **D12 已具备**（由查询库的 `cancelRefetch` 语义继承）+ 新增边界门禁；**D2 核定延后**（见下方核定） |
| D11 | "仅由推送建立"的 UI 状态必须有**快照重建**路径 | `packages/web/src/`（会话页/舰队卡）、IM 渠道事件消费 | 两个渠道都已完成（共享模块 `file:packages/agent/src/operator-event-stream-cursor.ts:1`） |
| D13 | 昂贵检查由**订阅/关注**驱动启停，而非固定周期 | `packages/gateway/src/node-auto-probe.ts`、`packages/executor/src/file-sync/periodic.ts` | **核定结论：拒绝（`作决策依据`）**——los 找不到真正的落点，见下方 D13 核定 |

**B4 的产品化排序依赖 B2**：手机形态可以晚做，但**任务面必须先有作用域**。把 B4 的 UI 提前到 B2 之前，等于把"多用户共用的全部任务"发给每一台手机。

### B4-D11（telegram 侧已完成）：推送通道必须有**有界**的续传/重建路径

**改前实测（两个 bot 的缺陷正好相反）**：服务端 `/operator/events/live` 在无游标时 `since = 0` ⇒ **从头回放**（`file:packages/gateway/src/routes/streaming/operator-events-sse.ts:56`），且回放查询是排他的 `WHERE id > $1`（同文件 `:114`）。

| 消费者 | 改前行为 | 后果 |
| --- | --- | --- |
| `telegram-bot` | 连接 URL **完全不带游标**（`file:packages/telegram-bot/src/index.ts:202` 改前） | **每次重连与每次重启都重放全部历史** ⇒ 重复通知，且随账本增长**无界** |
| `wechat-bot` | 内存游标 + 首连 `tail=1`（`file:packages/wechat-bot/src/index.ts:269`） | 进程内重连可续，但**重启窗口内的事件丢失**（注释自述是刻意取舍） |

**修复（telegram）**：新增 `decideSseResume()` 纯策略 + 持久化游标（DB 表 `telegram_sse_cursor`，与 bot 既有的 `telegram-action-store` 同一套 `@los/infra/db` 惯例）：

- 无游标 / 游标无时间戳 ⇒ `tail=1`（跳过积压）
- 游标年龄 ≤ `SSE_MAX_CATCHUP_MS`（默认 15 min）⇒ `since=<lastEventId>`（精确续传，**不漏不重**——因为服务端回放是排他的）
- 更旧 ⇒ `tail=1`（**有界**补拉：短停机恢复，长停机不刷屏）
- 写入单调（`GREATEST(...)`），迟到的旧流 flush 不会把游标往回拨

| 项 | 值 |
| --- | --- |
| 落点（共享） | `file:packages/agent/src/operator-event-stream-cursor.ts:1`：策略 `decideOperatorEventStreamResume` + 按 consumer 隔离的持久化游标（表 `operator_event_stream_cursor`，写入单调）；登记在 `file:packages/agent/src/ensure-all-stores.ts:1` |
| 落点（telegram） | `file:packages/telegram-bot/src/index.ts:1`：加载游标 → 决策 → 解析 `id:` → 5s 节流 flush + 断连 flush |
| 落点（wechat） | `file:packages/wechat-bot/src/stream-cursor-adapter.ts:1`（渠道适配：consumer id、env 旋钮、节流）+ `file:packages/wechat-bot/src/index.ts:1` 接线；**适配层单独成文件是因为 index.ts 触到 700 行结构硬限** |
| 回归测试 | `file:packages/agent/src/operator-event-stream-cursor.test.ts:1` **8 项**：无游标 tail、新鲜游标 since、**边界（等于上限仍续传）**、过期 tail、无时间戳 tail、**consumer 之间隔离**、DB 往返 + **单调性**、非法写入被忽略 |
| 检查 | `telegram-bot` 36 通过；`pnpm check` exit 0 |

**wechat 侧（同一 D11 的相反方向，已完成）**：wechat 原先只有**内存**游标（跨重启丢失）。现在同样走共享策略与持久化存储，并在进程内保留"内存位置优先于已落盘行"的语义（内存位置必然更新），因此瞬时重连仍立即续传。

**为什么上移到 `@los/agent` 而不是复制一份**：两个 bot 都已依赖 `@los/agent`，而新建共享包需要 ADR + operator 审批（`file:SKILL.md:35`）。上移前先核对了同包内已有的 `operator-control-consumer.ts`——它是**会话级、按 turn 的注入游标**（带 claim 语义、由 run 状态持久化），与本模块的"外部消费者全局流位置"是不同关注点；两者的差异已写进模块头部注释，避免形成第二个游标真源。

### B4-D1（已完成）：在线态三态

**改前实测（缺口不是假设的）**：`file:packages/web/src/nodes-registry-filter.ts:17` 的默认过滤器只保留 `status === 'online'` ⇒ `draining`（灰度中）与未知态被**静默丢弃**；`file:packages/web/src/nodes-page.tsx:54` 把 `nodes.data ?? []` 喂给纯函数，而 `DataTable`（`file:packages/web/src/ui.tsx:48`）只有 `loading`/`empty` 两个入口 ⇒ **取数失败被渲染成"尚无执行节点上报心跳"**，与"真的没有节点"不可区分。

| 项 | 内容 |
| --- | --- |
| 新增 | `nodeLiveness(status)` → `online｜draining｜offline｜unknown`；缺失/空/未识别状态一律 `unknown`，**绝不** `offline`（`file:packages/web/src/nodes-registry-filter.ts:20`） |
| 过滤语义修正 | 默认 `executors` 视图改为"**非确认离线**"：`draining` 与 `unknown` 保持可见（隐藏它们与"未知当离线"是同一个假声明） |
| 计数诚实化 | `executors` 计数与视图**同一判据**；新增 `executorsDraining` / `executorsUnknown` 供 UI 日后显示"3 online · 1 draining · 1 unknown" |
| 组件修正 | `DataTable` 增加可选 `error`，且**仅在没有行时**用错误替换空态（有陈旧数据时保留数据 + refresh 即恢复路径） |
| 页面接线 | `file:packages/web/src/nodes-page.tsx:122` 传 `error={nodes.isError ? t('ops.nodes.loadFailed') : undefined}` |
| i18n | 新增 `ops.nodes.loadFailed`（en/zh 两处） |
| 回归测试 | `file:packages/web/src/nodes-registry-filter.test.mjs:1`：8 项，含"缺失/未识别 ⇒ unknown"、"draining 与 unknown 仍可见、仅确认离线被隐藏"、"空响应不是活跃度声明"、"页面区分取数失败与空注册表" |
| 检查 | `pnpm --filter @los/web test` **72 通过 / 0 失败**；`pnpm --filter @los/web check` 通过；`pnpm check` exit 0 |

**附带发现（记录，未在本批修）**：过滤器逻辑存在 **`.ts`（应用）与 `.mjs`（测试）两份真源**，靠测试里的文本断言维持一致（`file:packages/web/src/nodes-registry-filter.mjs:1` 头部即写"Keep in sync with"）。Web 包的测试运行器只跑 `src/*.test.mjs`，所以这份复制是运行方式造成的。这正是审计里"一源多目标 + 生成物无 diff 门禁"（模式 7）要消除的形态；把它收敛掉属于独立改动（要动 web 的测试运行方式），不在本批范围。

---

### B4-D2/D12（核定结论：D12 已具备 + 新增边界门禁；D2 延后并有触发条件）

**D12（过期的整表快照不得覆盖更新的数据）：不需要自建栅栏，因为它已由查询库继承。**

- 裁决路径（query-core **5.100.14**，依赖声明见 `file:packages/web/package.json:16`；以下为其构建产物内的位置，属依赖源码，刻意不写成会随升级失效的仓库锚）：
  - `query.js:199`：`if (this.state.data !== undefined && fetchOptions?.cancelRefetch) { this.cancel({ silent: true }) }` ⇒ **已有数据时，新一轮取数会取消在途请求**，旧响应无法落地。
  - `query.js:201`：无数据时改为 `continueRetry()` 并**返回同一个 promise**（去重），因此"首次加载"也不存在两个并发响应。
  - `queryObserver.js:180` 与 `queryClient.js:179`：`cancelRefetch: fetchOptions.cancelRefetch ?? true` ⇒ **默认 true**。
  - 仅 `onFocus`/`onOnline` 显式传 `cancelRefetch: false`（`query.js:152`、`:159`），且随后调用 `_retryer.continue()` —— 是**续跑**而不是新开一条，故仍不产生并发响应。
- 覆盖范围实测：web 内**所有列表读都走 React Query**（页面里的 `fetch(` 命中全部是 `.refetch()` 调用）；裸网络入口只有 3 个模块。
- **因此自建 epoch 栅栏会成为第二份真源**（与库的取消语义可能漂移），不做。

**新增机械保护**（因为"继承"只在"列表读走库"的前提下成立）：`file:packages/web/src/data-access-boundary.test.mjs:1` 把该前提变成门禁——裸网络原语只允许出现在 `api/client.ts`、`api/ws-client.ts`、`hooks/useChatStream.ts` 三个模块（显式 allowlist），且**allowlist 里的模块必须仍在使用网络**（改名会失败而不是静默放宽）。负向控制：往页面塞一个裸 `fetch` ⇒ 门禁失败并指名 `pages/setup-page.tsx:5`；恢复 ⇒ 通过。

**D2（列表级变更流）：核定延后，不现在做。**

| 判据 | 实测 |
| --- | --- |
| 成本在架构不在端点 | web 有 **36 处 `refetchInterval`**（4s–30s 不等）——做"会话列表轻频道"只覆盖其中 1 处（`sessions-page.tsx` 的 12s） |
| 收益前提不存在 | 审计里 D2 的收益论证是**移动端弱网下的请求成本**；los 目前没有原生移动客户端，控制台是操作者自用、通常 1–2 个标签页 |
| 复用现有 operator 流被否决 | 该流的事件类型是**精选的关注面**（`tool.warned`/`operator_attention`/`session.blocked`…，`file:packages/gateway/src/routes/streaming/operator-events-sse.ts:87`），**不含**会话生命周期；放宽它会改变每个既有消费者（两个 bot）收到什么——正是审计反对的"把轻列表流与重关注流耦合" |
| 正确形态已知 | 真要做时按审计的**独立轻频道**（`sessions` 轻 topic）+ 客户端用 `invalidateQueries` 失效（栅栏由库免费提供） |

**重新评估触发条件**：① 出现**链路成本使轮询不可接受**的客户端（原生移动端/窄带）；② 某个轮询点的**载荷或频率实测变贵**——当前首个候选是 `file:packages/web/src/pages/logs-page.tsx:1` 的 **5s** 轮询（但它需要的是"日志 tail 流"，与列表频道是不同设计）；③ 出现"列表变更必须秒级可见"的产品要求（当前 8–30s 已被接受）。

### B4-D13（核定结论：拒绝，`作决策依据`）

**要迁移的模式**：把"昂贵副作用由订阅/关注驱动启停"（参考实现里 `fs-watch:<dir>` 只在该 topic 有订阅者时启动，最后一个订阅者离开即停）。

**在 los 的两个候选落点上逐一核对，两个都不成立**：

| 候选 | 实测 | 为什么按需化是错的 |
| --- | --- | --- |
| `node-auto-probe.ts` | 成本**已被限死**：每 120s 最多 2 次探测、探测间 2s、单节点 5min 冷却、single-flight、只针对 `executor + run_agent + verification:*:not_confirmed`（`file:packages/gateway/src/node-auto-probe.ts:37`） | 它的**消费者是调度器，不是观看者**。文件头写明用途：心跳故意不写 `verified.ok`，节点在路径抖动后可能"online 且接受任务，但 `candidate=false` 永远出不来"。没人看节点页时，恰恰是调度最需要这些节点被修复的时候 |
| `packages/executor/src/file-sync/periodic.ts` | 按文件夹 `scanIntervalSec`（默认 **1800s**）周期同步（`file:packages/executor/src/file-sync/periodic.ts:55`） | 它的消费者是**同步功能本身**（保持清单新鲜）。按需化会让"没人看时不同步"，与本功能的目的一致相反 |

**这个模式在 los 已经落在它真正适用的地方**：per-session 的 WS/SSE 是**观看者驱动**的——订阅时获取 stream lease、断开时释放（`file:packages/gateway/src/routes/streaming/ws-routes.ts:92`、`file:packages/gateway/src/routes/streaming/sse-routes.ts:117`）。los 没有"每个观看者一棵文件树监听"这类资源，所以没有第二个可迁移的落点。

**重新评估触发条件**（写清楚是为了防止将来有人凭印象重提）：

1. 出现**每个观看者一份昂贵服务端资源**的新功能（例如浏览器端文件树实时监听、远程桌面式采集）——那时按需启停是必须的，且应照 `ws-routes.ts` 的 lease 形态实现。
2. `node-auto-probe` 的探测成本从"每 2 分钟 ≤2 次 HTTP"升级到数量级更高（例如每节点跑真实任务探针），届时"按需 + 心跳兜底"才值得讨论。
3. 出现**只有人在看才有意义**的周期作业（例如仅为看板聚合的报表）——那类作业应当由订阅触发。

---

## 六、明确不做（拒绝清单）

来自 `docs/research/2026-10-10-cindy-multi-device-mechanism-audit.md` §2.5 与 §3.4，逐条都有 ADR 或测试门禁依据，**不要重新提成待办**：

| 不做 | 依据 |
| --- | --- |
| 哑中继 + 设备网格 + `invoke`/`push` 隧道、`reliable-transport-v1` | `adr:0001`（PostgreSQL 单一真相）、审计 §3.4 N1/N2；los 的重放语义由 `session_events` + `stream_checkpoints` 给出 |
| 对等方 IPC 白名单（`REMOTE_INVOKE_ALLOWLIST` 形态） | los 没有"对端应用"可驱动；对等物是 7 个生命周期命令（`file:packages/gateway/src/routes/orchestration/node-command-routes.ts:108`） |
| 跨账号共享作用域（`sharedTask` / `providerShare`） | 无产品需求；引入即新增授权面（审计 §3.4 N4） |
| 多节点 claim（在本地 executor 对齐验证之前） | `file:docs/adr/0010-node-connectivity-capability-taxonomy.md:186` |
| 活任务迁移 | `file:docs/adr/0012-service-cluster-and-stateful-agent-roadmap.md:639` |
| ACP / IDE 客户端面 | `file:packages/gateway/src/programmatic-interface-boundary.test.ts:8`（测试锁死） |
| 跨 gateway 聚合读模型 | 本次审计列为独立缺口（§2.4），**未纳入本计划**；需要单独决策 |
| 细粒度 RBAC / 权限点系统 | `adr:0048` §Decision 4；与 `file:docs/research/2026-08-19-komodo-review-observability-and-node-management.md:111` 的既有判断一致 |

---

## 七、失败模式与停止条件

| 失败模式 | 判据 | 停止条件 |
| --- | --- | --- |
| 分类表变成"叙述性权威"（写了但没人执行） | 门禁被 baseline/豁免绕过；负向控制不咬 | 立即回退该批，不带着失效门禁前进 |
| 分类过严导致前端 403 | 真实页面取数失败 | 把该条降级为 `authenticated` **并在表里登记理由**，不留"临时放宽"注释 |
| 作用域过滤打空既有运维面板 | 面板空数据 | 按 `adr:0048` 触发条件 3 显式 operator 化，**不回退过滤** |
| B2 的 fail-closed 把节点心跳拦下 | 车队掉线 | 立即回退 fail-closed 档位，先修公开白名单与实际自证方式 |
| 新测试文件未分类 | CI `unclassified test:` | 在 `packages/gateway/test-runner.mjs` 的 `sharedProcessTestFiles` 登记 |

---

## 八、整批验收记录（2026-10-10）

一次性、可复跑的验收（不是把各批次的自述拼起来）：

| 验收项 | 命令 | 结果 |
| --- | --- | --- |
| 全工作区测试 | `pnpm test` | **exit 0**：14 个 lane 汇总 **2125 tests / 2125 pass / 0 fail**；turbo **18/18 tasks successful** |
| 全量门禁 | `pnpm check` | **exit 0** |
| 准入门禁 + 自检 | `pnpm check:route-admission` | OK：265 路由、64 送审、96 operator-locked、自检 **10/10** |
| 门禁负向控制（端到端） | 新增未登记 `POST` / 移除 `GET /metrics` 门禁 / 加未分类 loader 路由 | 三者都被咬住（exit 1 且指名），恢复后 exit 0 |
| 运行期守卫（真实 server） | 启动真实 gateway 并读守卫输出 | route-admission 告警数 **0**（健康即沉默）；首轮曾报出 `GET /*` 插件盲区，已显式登记 |
| 接线门禁 | `pnpm check:wiring` | 0 新孤儿（417 grandfathered） |
| 文档门禁 | `pnpm check:doc-anchors` / `check:workspace-docs` | 均 OK |
| 客户端数据访问边界门禁 | `pnpm --filter @los/web test` | 75 通过 / 0 失败；负向控制：页面塞入裸 `fetch` ⇒ 指名失败，恢复 ⇒ 通过 |

**批次状态**

| 批次 | 状态 | 证据 |
| --- | --- | --- |
| B1 准入分类 + 门禁 | 已完成 | `file:tools/check-route-admission.mjs:1` |
| B2A 控制面写收紧（8 条） | 已完成 | `file:packages/gateway/src/routes/orchestration/tool-gate-routes.ts:193` |
| B2B-1 读作用域（`/tasks`、`/sessions`） | 已完成 | `file:packages/gateway/src/request-context.ts:200` |
| B2B-2 运维观测读收紧（29 条）+ G4 锁定 | 已完成 | `file:tools/route-admission-operator-required.txt:1` |
| B2C 运行期守卫（告警档）+ G5 无 diff | 已完成 | `file:packages/gateway/src/route-admission-guard.ts:1` |
| B3-step-1 节点身份发送侧 | 已完成 | `file:packages/executor/src/executor-heartbeat.ts:26` |
| B4-D1 在线态三态 | 已完成 | `file:packages/web/src/nodes-registry-filter.ts:20` |
| B4-D11 推送续传（两渠道） | 已完成 | `file:packages/agent/src/operator-event-stream-cursor.ts:1` |
| B4-D13 昂贵检查按需化 | 核定拒绝 | `file:packages/gateway/src/node-auto-probe.ts:37` |
| B4-D12 过期整表快照不得覆盖 | 已具备 + 门禁锁定 | `file:packages/web/src/data-access-boundary.test.mjs:1` |
| B4-D2 列表级变更流 | 核定延后（有触发条件） | `file:packages/web/src/pages/sessions-page.tsx:1` |

**等待 operator 的三项（不是技术债，是决策/时机）**

1. **B2B-3**：产品资源面（`/memory`、`/skills`、`/rules`、`/artifacts`、`/work-items`）——operator-only 还是加 `(tenant,project,user)` 所有权作用域。
2. **B2C-2**：运行期守卫翻 fail-closed——需先确认没有"按配置启停"的条件注册模块（否则合法部署会被拒在启动期）。
3. **B3-step-2**：缺失凭据即拒——需确认所有在线节点都能发送凭据（B3-step-1 已就位）。

**未提交**：本批 58 个路径仍在同一个 working copy（`file:docs/architecture/2026-10-10-multi-device-pattern-adoption-plan.md:1`）；按 intent 可拆七份（审计+ADR+计划 / B1 门禁 / B2A / B2B-1 / B2B-2+G4 / B2C+G5 / B3-step-1 / B4-D1 / B4-D11）。

---

## 九、本计划与 `adr:0047` 的关系

`adr:0047` 解决的是**"能力归谁 + 引用方向 + 真相优先级"**（工具/项目/provider 边界）；本计划解决的是**"谁允许访问 los 的 HTTP 面与读模型"**（准入与作用域）。两者正交，但共用同一条纪律：

> 边界如果只写在文档里，就会退化成"又一份叙述性权威"；必须把可机械化的部分变成门禁，让"谁归谁"能被证伪。

（该纪律的原文与先例见 `file:tools/check-capability-ownership.mjs:1`。）
