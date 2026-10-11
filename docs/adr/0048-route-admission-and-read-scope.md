# ADR 0048: HTTP Route Admission Classification And Read Scope

- **Status**: Accepted（2026-10-10）
- **Date**: 2026-10-10
- **依据**: `docs/research/2026-10-10-cindy-multi-device-mechanism-audit.md`（参考实现机制审计，可迁移项 D3 / D3b / D9 / D10）
- **执行计划**: `docs/architecture/2026-10-10-multi-device-pattern-adoption-plan.md` B1–B2
- **范围**: `packages/gateway` 的 HTTP 路由准入面与 `packages/gateway` / `packages/agent` 的读模型作用域。**不涉及** wire 协议、provider 路由、调度放置、跨 gateway 聚合。

---

## Context

### 1. 准入面与读模型面的现状（可机械核对）

| 事实 | 证据 |
| --- | --- |
| 路由文件里共有 **259** 处 `app.<method>(` 注册 | `file:packages/gateway/src/routes/:1`（全目录扫描：`grep -rhoE "app\.(get\|post\|put\|patch\|delete)\(" packages/gateway/src/routes/ \| wc -l` → 259） |
| `requireOperator` 全包只有 **114** 处 | `file:packages/gateway/src/request-context.ts:158`（定义）+ 各路由调用点 |
| **19 个路由文件有路由、零 `requireOperator`**（含 `memory-routes.ts` / `cross-project-routes.ts` / `saas-todo-routes.ts` / `trace-routes.ts` / `usage-routes.ts` / `artifact-routes.ts` / `skill-routes.ts` / `rule-routes.ts` / `log-routes.ts` / `metrics-routes.ts` / `service-routes.ts` …） | `file:packages/gateway/src/routes/data/memory-routes.ts:1` 等（逐文件计数，见 §1 脚注） |
| 网关有**粗粒度**基线门禁：公开白名单之外一律要求「任一已认证主体」 | `file:packages/gateway/src/auth-middleware.ts:34`、公开白名单 `file:packages/gateway/src/auth-middleware.ts:10` |
| **读模型未按主体作用域过滤**：`listTaskRuns()` 是 `SELECT * FROM task_runs … LIMIT $1`，无 `WHERE` | `file:packages/agent/src/task-runs.ts:337` |
| `GET /nodes` 返回全部节点 | `file:packages/gateway/src/routes/infrastructure/node-routes.ts:93` |
| 运维事件流自述跨全部 session/tenant | `file:packages/gateway/src/routes/streaming/operator-events-sse.ts:47` |
| 用户与角色已存在（`users.role ∈ operator\|user`，首个注册用户强制 operator） | `file:packages/infra/migrations/047_users.sql:7`、`file:packages/gateway/src/routes/auth-routes.ts:44` |
| `tenant_id` / `project_id` / `user_id` 已在 `task_runs` / `session_events` 上落列 | `file:packages/infra/migrations/002_task_runs.sql:9`、`file:packages/agent/src/execution-persistence.ts:263` |
| `auth.enabled=false` 时 `requireOperator` **恒真** | `file:packages/gateway/src/request-context.ts:166` |

### 2. 为什么现在要决策

多用户面已经存在（`047_users.sql`），但**授权是按"接口"逐点手写的布尔判断，读模型是全局的**。两者叠加的后果不是"某个端点漏了一个 if"，而是一类系统性风险：

> **任何一个未标注 `requireOperator` 的端点，对任何已认证 `role=user` 主体都是可读可写的；且它的读模型会返回全部 tenant/project/user 的行。**

这不是理论风险：`/tasks`、`/nodes`、`/operator/events/live` 三个面在本次审计中已被确认返回全量（上表）。同一结论在 `docs/research/2026-08-19-komodo-review-observability-and-node-management.md:111` 的时代被"los 无外部用户"这一前提掩盖；该前提已在 `047_users.sql` 落地后失效。

**测量口径纠正（2026-10-10，实现期发现）**：上表的"19 个文件零 `requireOperator`"是**文件级**信号，不是"可写路由"的准确数量。B1 首版沿用文件级判定，把 111 条路由错报成"已有门禁"，得出"34 条可写路由"；改为**逐路由**判定后（`file:tools/check-route-admission.mjs:151`），真实数字是 **74 条**，其中控制面 8 条已收紧，**剩余 64 条**待 B2B 决策。记录此处的原因：这份 ADR 的后续批次会反复引用该数字，口径必须写明，否则会重演"门禁自己说谎"。

同时，2026-10-10 的多设备机制审计给出了两个**已被行业实现验证**的机械判据（参照 `adr:0047` 的"边界必须可机械检查"原则）：

1. **默认拒绝应由枚举结构保证**，并把"永不允许"的类别固化成可执行的全表扫描不变式——否则防线依赖"review 时记得问"（迁移项 D3）。
2. **授权应按"操作 + 角色矩阵"裁决，拒绝原因是类型化枚举，并显式声明"这只是任务级授权，行级归属必须由执行方另行校验"**（迁移项 D10）。

---

## Decision

### 1. 每个路由必须被**声明式分类**，且分类可机械核对

新增分类面，取值三档：

| 档 | 含义 | 门禁 |
| --- | --- | --- |
| `public` | 无需任何凭证（`/health*`、`/auth/login`、PWA 静态资源、`/nodes/enroll` 等按 token 自证的端点） | 必须在表里**显式登记**，缺省不是 public |
| `authenticated` | 需要任一有效凭证（operator / JWT / 静态 access token） | `auth-middleware` 基线即可 |
| `operator` | 需要 operator 凭证 | 必须由 `requireOperator` **实际执行**（见决策 2） |

机械判据：

- **完备性**：`packages/gateway/src/routes/**` 里出现的每一个 `METHOD /path` 都必须在分类表中有条目；**未分类 = 门禁失败**。
- **声明与执行一致**（"declared vs actual"）：声明为 `operator` 的路由必须在同文件/同注册链上实际调用 `requireOperator`；声明为 `public` 的路由必须出现在 `auth-middleware` 的公开白名单里。两侧任一不一致 = 门禁失败。
- **危险模式扫描**：对分类为 `authenticated` 或 `public` 的**变更类**方法（`POST`/`PUT`/`PATCH`/`DELETE`）做全表正则扫描（如 `auth:`、裸写库、`*:set$`、updater/迁移类路径），命中即失败，除非在显式 `EXEMPT` 集合里给出理由（迁移项 D3 的落地形态）。

### 2. 分期落地：先可核对，再 fail-closed

本仓对"新门禁"的既有纪律是**先只提示、稳定后再翻默认**（`file:tools/check-workspace-docs.mjs:20` 的 W1b 说明；`tools/check-doc-status-anchors.mjs` 的 baseline 棘轮同型）。因此：

- **B1（本 ADR 的第一批）**：分类表 + 完备性/一致性/危险模式门禁（**测试期强制**）+ 运行期 `onRoute` 守卫**只告警**。运行期行为零变化。
- **B2（后续批次）**：把守卫翻成 fail-closed（未分类路由导致启动失败），并在同一变更里把已知缺口逐条收紧。**翻默认必须单独一个变更**，不得与分类表首次落地混在一起。

### 3. 读模型作用域：非 operator 主体一律按 `(tenant_id, project_id, user_id)` 过滤

- 任何**可被非 operator 主体到达**的读模型，必须显式声明并应用作用域；`operator` 的越权读取是**显式且可审计**的路径，不是"默认就全量"。
- **默认拒绝**：一个读模型若无法说明自己的作用域（例如聚合了多租户数据），不得暴露给非 operator 主体。
- **`auth.enabled=false` 是显式的本地单用户模式**：作用域收敛到配置的默认 tenant/project，走**同一条代码路径**（不是另开一条不受控分支）。这样本地开发不会因为"没开鉴权"而绕过作用域逻辑，避免"开发时正确、上线后才发现"。
- 本 ADR **不引入新角色**，`operator` / `user` 两档不变；也不改变任何 wire 格式或数据库 schema。

#### 3.1 实现期实测对决策 3 的收窄（2026-10-10，权威）

落地时对运行库与源码做了两次实测，结果**收窄**了决策 3 的形态，记录如下（依据"持久化证据优先于文档声称"）：

1. **作用域只能是 tenant，不能是 project**。运行库实测 `task_runs`：877 行 `local/los`，另有 ~250 行分布在 `dsfolder-*` / `lot2extension` 等**多个 project**上；`sessions` 同理。los 的任务/会话投影**在 tenant 内是跨 project 设计**的，按 `(tenant, project)` 过滤会把操作者自己的多项目看板打空。
2. **legacy 行必须显式处置**：实测存在 **82 行 `unknown/unknown`** 与 **45 行空 tenant** 的 `task_runs`（`sessions` 为 57 `unknown` / 60 空）。本 ADR 采择：空/`unknown` 行对 operator 与本地模式**保持可见**，对非 operator 主体**excluded（fail-closed）**；**不在此处回写数据**，回填 legacy tenant 值是独立工作。
3. **读侧不能套用"每条读都必须带作用域助手"**。实测 135 条 GET：8 条已带作用域助手、8 条 operator 门禁、**119 条两者皆无**。但其中多数（`/diagnostics*`、`/metrics*`、`/slo/*`、`/governance/*`、`/file-sync/*` …）在语义上是**运维观测面**，正确处置是 **operator-ization 而非租户过滤**。因此读侧的机械目标是**读准入分类**（产品作用域读 / 运维 operator 读 / 公开读），不是"每读必带 `resolveReadScope`"——后者会产出 119 条豁免，是噪音而不是信号。

### 4. 明确不做

- 不引入细粒度 RBAC / 权限点枚举系统（与 `file:docs/research/2026-08-19-komodo-review-observability-and-node-management.md:111` 的既有判断一致：先做两档 + 作用域，不做权限点组合爆炸）。
- 不做跨 gateway 聚合读模型（本次审计将其列为独立缺口，见执行计划 B4）。
- 不改 `session_events` / `task_runs` 的持久化形状；只改**读取路径**的作用域与准入。
- 不为兼容旧客户端而放宽作用域；作用域是服务端权威，客户端无法通过参数放宽。

---

## Consequences

**收益**

- 新增端点若未分类，CI 失败而不是"上线后对任何 user 可读"。
- 读模型的多用户暴露面从"隐含"变成"逐条声明 + 可测"。
- 为后续的"手机端访问任务面"提供**前置条件**：手机形态可以晚做，但作用域必须先正确，否则是放大暴露面。

**代价与风险**

- 初次分类 259 条路由需要人工判断（机械扫描只能给出候选）；判断错误的后果是**过严**（前端 403）或**过松**（保持现状）。**过严比过松安全**，因此分类表的默认建议是"读走 authenticated、写走 operator"，例外逐条登记理由。
- 运行期守卫在 B1 只告警，存在"告警被忽略"的窗口；这是刻意的分期代价，由 B2 的 fail-closed 收敛。
- 作用域过滤会给读路径增加 `WHERE` 条件，可能改变既有查询计划；需要用现有的读延迟诊断面（`file:packages/gateway/src/routes/streaming/` 与 DB worker 计时）复测，不得用内存库基准代替真机端到端。

**重新评估触发条件**

1. 出现第三种角色或"同一用户多租户"的产品需求。
2. 手机端/第三方客户端开始携带 `x-tenant-id` 类头部（届时作用域必须从"服务端推导"改为"服务端校验"）。
3. 任一读模型的 `WHERE` 过滤导致既有运维面板出现空数据（说明该面板本就依赖跨租户全量，需要显式 operator 化而不是回退过滤）。
4. B2 的 fail-closed 上线后出现"节点/executor 心跳被拒"（说明 public 白名单与实际自证方式不一致）。

---

## Implementation Status

| 决策 | 状态 | 证据 |
| --- | --- | --- |
| 1 分类表 + 完备性/一致性门禁（`tools/` 形态，零 `src/` 改动） | 已实现（`file:tools/check-route-admission.mjs:1`） | 265 条路由集合相等 `file:tools/route-admission-inventory.txt:1`；自检 8/8；端到端探针（新增未登记 `POST` ⇒ exit 1，含 G1+G2） |
| 1 送审名单（棘轮，34 条） | 已实现（`file:tools/route-admission-review.txt:1`） | 34 条"变更类 + 无 operator 门禁 + 非公开"路由已冻结送审 |
| 1 接入 `pnpm check` | 已实现（`file:package.json:40`） | `pnpm check:route-admission` 通过 |
| 2 控制面写路由收紧（B2A） | 已实现（`file:packages/gateway/src/routes/orchestration/tool-gate-routes.ts:193`） | 8 条控制面路由加 `requireOperator`；operator 59→67；送审名单 74→64；`pnpm --filter @los/gateway check` 通过；受影响 3 个测试文件 9/9 通过 |
| 2 运行期守卫（告警档） | 已实现（`file:packages/gateway/src/route-admission-guard.ts:1`） | `onRoute` 收集真实注册表 → `onReady` 与**生成清单**对账，两个方向都指名告警；清单为生成物（`file:packages/gateway/src/route-admission-inventory.ts:1`），由 G5 无 diff 门禁保证不漂移；真实 server 上开启后**零告警**（健康即沉默） |
| 2 运行期守卫（fail-closed） | 未实现 | 翻档是单独的行为变更；需先确认没有合法的条件注册（按配置启停的模块） |
| 2 运行期守卫的实证价值 | 已确认（`file:packages/gateway/src/route-admission-guard.ts:5`） | 首次在真实 server 开启即报出 `GET /*`——来自 `@fastify/static` 的 wildcard，**源码门禁对插件注册天生失明**。故运行期守卫不是 CI 门禁的重复，而是补盲区 |
| 3 读模型作用域（B2B-1：`/tasks` + `/sessions` 的 list/detail） | 已实现（`file:packages/gateway/src/request-context.ts:200`） | `resolveReadScope` + 两个 list/detail 路由接线；`listTaskRuns` / `listSessions` 接受可选 tenant 作用域；隔离回归 `file:packages/agent/src/task-runs.test.ts:333`、`file:packages/agent/src/session.integration.test.ts:15`；作用域解析单测 3 例（`file:packages/gateway/src/request-context.test.ts:156`） |
| 3 读模型作用域（B2B-2：29 条运维观测读 → operator + G4 锁定） | 已实现（`file:tools/route-admission-operator-required.txt:1`） | operator 67→96；G4 把 96 条"必须保持门禁"的路由锁死，移除任一条 ⇒ CI 失败（端到端负向控制：移除 `GET /metrics` 门禁 ⇒ exit 1）；2 处测试期望按新边界更新并各补 403 断言 |
| 3 读模型作用域（B2B-3：产品资源读的准入分类） | 未实现 | 见 §3.1 第 3 条；需产品 vs 运维的线，operator 已明确"下一步再定" |
| 4 不做的边界 | — | 本 ADR §Decision 4 |

**实现形态与原计划的偏差（记录在案）**：原计划把分类表放进 `packages/gateway/src/` 并由运行期守卫消费；实现改为纯 `tools/` 门禁 + 数据文件，因为 `file:tools/check-wiring-topology.ts:99` 的接线门禁会把"只为测试导出"的表判为孤儿导出，而运行期守卫要等 B2。该偏差使 B1 完全不触碰 `packages/**`，反而更强地满足了"运行期行为零变化"。

> 状态栏的写法遵循 `adr:0047` 的"计划/实现/证据三态分离"：**未实现即写未实现**，不写"部分完成"这类无法机械核对的措辞。
