---
subject: DSH→los 跨项目派发路径（MCP 适配器 los_run × 网关项目作用域解析）
auditedRev: 1d5d0a9a (git, 父提交) / 4c0dce60 (jj working copy @)
readOnly: true
method:
  - 源码阅读（mcp-serve.ts / request-context.ts / chat-route.ts / task-intake.ts）
  - 真机探针 5 条（DSH mcp__los__* 工具 + 网关 HTTP，2026-10-11 09:40–09:44 +08）
  - 真库 SQL（run_specs / session events）
  - 绕行路径对照（dsfolder/scripts/rust-repo-gate-run.mjs）
---

# DSH→los 跨项目派发能力审计与跨项目授权修复（2026-10-11）

- **触发**：operator 询问"现在是否可以通过 DSH 调 los 在各个项目中执行分析与开发任务、并处理跨项目任务，支持哪些场景、有哪些缺口"。
- **口径**：实现=运行时行为。`[E]`=当场命令/API/DB 行可复现；`[I]`=源码推断；`[U]`=未验证。
- **归属**：被审计主体是 los 自己的 MCP 适配器与项目作用域解析，故本文留 los 仓
  `docs/operations/`（不在母仓 dsfolder）。
- **本文两段**：§1–§5 是**只读审计**（结论只对 `auditedRev` 有效）；§6 记录**同批交付的修复**，
  它不是审计结论，且已越出 `readOnly: true` 的前提。

---

## 1. 一句话结论

DSH 能调 los 做分析与开发、能读回执行证据；但 `los_run` 的 `projectId` 在**非 operator** 调用下
被网关**静默丢弃**，run 实际落在默认项目 `los`。跨项目派发今天只有"DSH 用 bash 直连网关 +
带 operator 凭据"这一条真实通路（§4.5 `[E]`），MCP 工具面不提供。

## 2. 实测证据（5 条探针）

| # | 探针 | 观测 | 判定 |
| --- | --- | --- | --- |
| P1 | `los_run(projectId=dsfolder-fmtguard, toolMode=read-only)` | 返回 `succeeded`，但 replay 首事件 `coordinator.intake_resolved` 为 `ownerRepo="los"`、`requestedProjectId="los"`、`workspaceRoot=…/projects/los`；`run-session-1791682852272-1791682852277` | ❌ 参数被丢弃 |
| P2 | `los_run(projectId=dsfolder, workspaceRoot=…/dsfolder/fmtguard)` | `LOS gateway 403: {"error":"operator token required"}` | ❌ 契约声明可用、实际不可用 |
| P3 | `los_run(toolMode=project-write)` | 成功；`tool.catalog` 42 项含 `write_file/edit_file/apply_patch/run_shell/run_background`；`toolPolicy={allowWrites:true,maxRiskLevel:L1,sandboxAvailable:false}`；`run-session-1791682876693-1791682876697` | ⚠️ 写能力真实存在，但同样落在 los 仓、无隔离 |
| P4 | `los_run(runContract={mode:execution, executionMode:standard})` | MCP 侧返回 `status:"blocked"` 且**响应无 `runSpecId`**；库内 `run-session-1791683022432-1791683022446`，`phase=created`、2 条 required verification pending、state `action=run_verification` | ❌ 契约跑不完且丢 id |
| P5 | bash `POST /chat` + `x-los-operator-token`（同 P1 入参） | `ownerRepo="dsfolder-fmtguard"`、`workspaceRoot=…/dsfolder/fmtguard`、`userId="operator:shared-token"`、`run-session-1791683059299-1791683059299` | ✅ 跨项目通路成立（绕行） |

真库对照（近 3 天 `run_specs`）：`operator:shared-token` 才产生跨项目行
（`dsfolder-fmtguard` / `-session-index` / `-verify-gate` / `-sandbox-run` / `-rustopt` / `-run-diff`），
`authenticated:shared-token`（MCP 的 access 路径）全部落在 `los` `[E]`。

## 3. 根因（源码级）

1. `file:packages/gateway/src/request-context.ts:63` — `auth.enabled=true` 且调用方非 operator 时
   `projectId = config.defaultProjectId ?? 'los'`，`x-project-id` 头只当"路由提示"被丢弃；
   `file:packages/gateway/src/request-context.ts:193` 的 `resolveProjectScope()` 同口径
   （非 operator 固定返回 `ctx.projectId`）。
2. `file:packages/cli/src/mcp-serve.ts:165` — `los_run` 的 `POST /chat` 从不带
   `x-los-operator-token`（该头只用于 `los_operator_control`）⇒ 必然走上面那条"非 operator 被钉死"分支。
   即 `projectId` 在 MCP 路径上是**装饰性参数**。
3. `file:packages/gateway/src/chat-route.ts:53` — 任何 `workspaceRoot` 都要 `requireOperator()`
   ⇒ P2 的 403；适配器契约把 `workspaceRoot` 列为可用参数属**声明强于事实**。
4. 项目绑定真源是 `/Users/echerlos/.los/projects.json`（10 个 binding：`los`、`cantool`、`dsfolder`、
   `dsfolder-{fmtguard,unirun,rustopt,sandbox-run,verify-gate,session-index}`、`dsh-plugins-review`）。
   `file:packages/agent/src/coordinator/task-intake.ts:37` 的 `resolveProjectOwner()` 规则：
   显式 `projectId` 必须已绑定；只给 `workspaceRoot` 时必须在某 binding 之内
   ⇒ 未登记仓（`routeguard`、`win-exec`、`cargogc`、`cankey`、`lot2extension` …）连 operator 也够不到 `[I]`。
5. 与 P5 同型的对照实现：`/Users/echerlos/syncfolder/project/dsfolder/scripts/rust-repo-gate-run.mjs:267`
   同时带 `x-los-operator-token` + body `projectId`/`workspaceRoot`，今天 07:40 那批跨项目 verification run 由它产出 `[E]`。

## 4. 当前支持的场景（审计时点）

| # | 场景 | 状态 |
| --- | --- | --- |
| 1 | 单项目（**仅 los 自身**）只读分析 | 可用；14 个只读工具，**无 `run_shell`**（跑不了 `cargo test`） |
| 2 | 单项目（los）写/开发 | 可用；42 工具，`sandboxAvailable=false` ⇒ 直改工作树、无隔离 |
| 3 | 执行真相读取（`los_run_state` / `los_run_replay`） | 可用且最完整（状态投影 + recovery 建议 + 带游标 replay） |
| 4 | operator 转向/续跑（`los_operator_control`） | 可用但对象受限：`los_run` 阻塞，同一 turn 无机会转向 |
| 5 | 治理面（`dsh-los-ops` 10 工具：gov jobs / DLQ / todos / `los_chat`） | 可用；`los_chat` 无 target repo 参数，同样钉在 los |
| 6 | los→DSH 事件推送 | 可用（`/health` `dshEventOutbox.published=4`） |
| 7 | **跨项目派活** | MCP 工具面 ❌；bash + operator 凭据 ✅（§4.5 P5） |

## 5. 缺口清单（审计时点）

| 级别 | 缺口 | 判据/修法 |
| --- | --- | --- |
| P0-1 | 跨项目**静默落错仓**（不是报错，是"以为在 A 仓其实改了 B 仓"） | 已在 §6 修（operatorScope + fail-loud） |
| P0-2 | 长任务被上层截断且丢 `runSpecId`：适配器 `await response.text()` 缓冲整条 SSE，DSH 侧 `toolCallTimeoutMs=180000` | 部分缓解：`los_runs_list` 可按 `traceId` 找回 id（§9.1）；`detach` 已证明可在适配器侧实现（§9.2），未实现 |
| P0-3 | 契约跑不完：standard/heavyweight 会 park，而 MCP 无 `verify`/`approve`/`cancel`/`recover`/runs 列表（路由见 `file:packages/gateway/src/route-admission-inventory.ts:237`） | 大部已交付：runs 列表（§9.1）、`verify`/`approve`（§9.4）；`cancel` 仍缺（S3）。另：blocked 终态不带 `runSpecId` 的投影问题仍在 |
| P1-1 | 无 run 发现/取消入口（`run_specs` 已有 500+ 行） | 发现已交付（`los_runs_list`，§9.1）；取消仍缺（S3：只有 task 级 `POST /tasks/:id/cancel`） |
| P1-2 | 幂等假象：每次随机 `x-idempotency-key: mcp-<uuid>`，重试会重复建 run | 未修：`dedupeKey` 是另一字段，不解决重试 |
| P1-3 | 项目登记面缺口无门禁：10 个 binding 覆盖不全，且与母仓 `workspace-registry.snapshot.json` 互不校验 | 未修：需一条"要派活的仓 ⊆ binding"机械 check |
| P1-4 | 写入无隔离、节点不可选：`sandboxMode`/`allowedTools`/`node` 都不在 MCP 契约里 | 未修；fleet 8 个在线 executor，探针全落 `mbp-executor-1` |
| P2-1 | 归因缺失：client label 只接在 `/v1`（`file:packages/gateway/src/openai-compat-route.ts:204`），MCP 走 `/chat` | 未修：只能归因到 `authenticated:shared-token` |
| P2-2 | 声明强于事实：DSH profile 注释与 `operations/programmatic-agent-interface.md` 旧文声称 `los_run` 可直接指定 `projectId`+`workspaceRoot` | 已在 §6 同步 |

## 6. 同批交付的修复（§1–§5 之外）

**修的是 P0-1，取"显式 opt-in + 失败要响"两条，不动网关的租户/项目隔离语义**
（非 operator 仍被钉在默认项目；不再让"被钉住"静默通过）。

1. `los_run` 新增 `operatorScope`（布尔，缺省 `false`）。为 `true` 时：适配器**要求** operator 凭据
   （`file:packages/cli/src/mcp-serve.ts:92`），并把 `x-los-operator-token` 一并发给 `POST /chat`
   （`file:packages/cli/src/mcp-serve.ts:107`）⇒ 网关 `isOperator=true`，
   `projectId`/`workspaceRoot` 才真正生效（P5 的通路，从"绕行"变为"契约内"）。
2. **fail-loud**：读 SSE 首个 `coordinator.intake_resolved`（`file:packages/cli/src/mcp-serve.ts:385`），
   若 `ownerRepo` ≠ 调用方给的 `projectId`，返回 MCP 错误并在文本里带
   `requestedProjectId` / `ownerRepo` / `reason` / `runSpecId` / `sessionId`
   （`file:packages/cli/src/mcp-serve.ts:405`）——把"静默落错仓"变成"响亮的错误且不丢 id"。
   投影同时新增 `ownerRepo` / `requestedProjectId` / `workspaceRoot`
   （调用点 `file:packages/cli/src/mcp-serve.ts:121`、`file:packages/cli/src/mcp-serve.ts:123`）。
3. 契约与文档同步：`file:contracts/programmatic-agent-interface.yaml:33`（`scopeRule`）、
   `:39`（`failLoud`）、`file:docs/operations/programmatic-agent-interface.md:86`（Cross-Project Scoping 一节）；
   测试 `file:packages/cli/src/mcp-serve.test.ts:89`（无凭据时拒绝）、`:199`（不一致时 fail-loud）。

### 6.1 一个当场抓到的形状坑（值得单独记）

第一次实现按**扁平**读 `data.ownerRepo`，端到端探针 A 路径**没有报错**（`isError=false`）——
因为真实流里 `coordinator.intake_resolved` 是**信封**形状，归属字段在 `data.payload` 内：

```text
event: coordinator.intake_resolved
data: {"id":641264,"sessionId":"…","projectId":"los","source":"coordinator",
       "payload":{"reason":"explicit_project","ownerRepo":"los","requestedProjectId":"los", …}}
```

而 `done` 事件是扁平的（`data.runSpecId` / `data.text` 直接可用）。
**这是 fail-loud 自身的失效模式**：读不到 ≠ 一致。修法是三种来源依次回退
（`payload.ownerRepo` → `data.ownerRepo` → 信封 `data.projectId`），并用信封形状锁进测试
（`file:packages/cli/src/mcp-serve.test.ts:296` 的 `intakeEnvelope`）。
原始流证据：`/tmp/sse-dump.txt`（17923 B，26 个事件块）。

### 6.2 验收（端到端 stdio 探针，走真适配器→真网关→真 executor）

探针脚本 `/tmp/los-mcp-probe.mjs`（spawn `tools/los-mcp-serve.sh`，让壳脚本从 los `.env` 兜底取凭据）：

| 路径 | 入参 | 观测 | 判定 |
| --- | --- | --- | --- |
| A | `projectId=dsfolder-fmtguard`，不带 `operatorScope` | `isError=true`：`project scope mismatch: requested projectId='dsfolder-fmtguard' but the gateway resolved ownerRepo='los' … runSpecId=run-session-1791683608096-1791683608106 sessionId=session-1791683608096` | 通过 |
| B | 同 projectId + `workspaceRoot=…/dsfolder/fmtguard` + `operatorScope=true` | `isError=false`，`ownerRepo="dsfolder-fmtguard"`、`workspaceRoot=…/dsfolder/fmtguard`、`text="MCP-PROBE-B"` | 通过 |
| B′ | 独立复核（`los_run_replay`，不看适配器自述） | `run-session-1791683608796-1791683608798` 的 `intake_resolved` 为 `ownerRepo="dsfolder-fmtguard"`、`requestedWorkspaceRoot` 相符；`task.created.projectId` 同为该仓 | 通过 |

门禁：`pnpm --filter @los/cli check`、`@los/cli test`（10/10，含 4 条新用例）、
`./tools/check-contracts.sh`、`check-structure.sh`、`check-unwired-exports.sh`、
`check-doc-status-anchors.mjs`、`check-workspace-docs.mjs`、`pnpm check` — 全部 exit 0。

### 6.3 顺带观测到的归因差异（未修）

operator-scoped 运行会采用适配器配置的 `x-user-id`（缺省 `mcp-client`），
而非 operator 路径记录的是 `authenticated:shared-token`
（见 `run-session-1791683608796-1791683608798` 的 `task.created.userId`）。
建议在宿主侧设 `LOS_MCP_USER_ID`（如 `dsh-mcp`），否则操作员作用域的 MCP 运行在台账里
无法与其它 `mcp-client` 区分。

## 7. 未做的事（有意）

- 不改网关 `resolveProjectScope` 的非 operator 钉死语义（那是租户/项目隔离边界，属 ADR 级别决策）。
- 不新增 `verify`/`approve`/`cancel`/`runs list` 工具（P0-3，需单独立项）。
- 不做 async/detach 派发（P0-2，触碰 `run-stream` 契约）。
- 不给 `los_run` 之外的工具加 operator 作用域（`los_run_state`/`los_run_replay` 的读取本就跨项目，
  见 `docs/operations/programmatic-agent-interface.md` 末段）。

## 8. 残留

1. **DSH 会话要重启 MCP server 才能看到新参数**：stdio server 由宿主启动时 spawn、tsx 不热重载。
   实测两个常驻进程仍是改动前的代码——web profile `pid 1412`（启动于 10-10 23:08）、
   desktop profile `pid 20468`（启动于 10-09 23:17）。未重启前，DSH 侧 `los_run` 仍无
   `operatorScope`、也不会 fail-loud。
2. P0-2 / P0-3 / P1-* 见 §5，均未修。
3. 审计与验收期间的探针 run 留在台账（`los` 3 条 + `dsfolder-fmtguard` 3 条 succeeded，
   另有 1 条 P4 停在 `phase=created`；均无 `todoId`、无文件副作用）。

## 9. 后续工作：S1 / S2 / S4 已交付，S3 未开工

目标：补"派活 → 盯活 → 收活"闭环，先解决 P0-2 的**超时丢 id**（这是长开发任务的实际痛点）。

### 9.1 S1 `los_runs_list`（2026-10-11 交付）

`file:packages/cli/src/mcp-tools.ts:46`（工具面）、`file:packages/cli/src/mcp-serve.ts:135`（handler）、
投影函数见 `file:packages/cli/src/mcp-serve.ts:343`；契约 `file:contracts/programmatic-agent-interface.yaml:58`；
测试 `file:packages/cli/src/mcp-serve.test.ts:297`。
工具面常量因此拆到 `file:packages/cli/src/mcp-tools.ts:1`（`mcp-serve.ts` 当时涨到 501 行，
撞上 `tools/check-structure.sh` 的"新文件 >500 行"门禁；拆分后 415 行）。

- 入参 `projectId`（必填）+ `traceId` / `status` / `limit`（缺省 10，上限 50）。
- 适配器侧过滤、按 `createdAt` 倒序、裁剪 `promptPreview` 到 120 字符：因为 `GET /runs` 的 handler
  不收过滤参数且每行带**完整 prompt**。
- **验收（真机，超时丢 id → 找回）**：`/tmp/los-recovery-probe.mjs`
  ①直接 `POST /chat`（带 `traceId=s1-recovery-1791684054796`）且**不消费响应**（等价于客户端丢 id）；
  ②用真适配器 `los_runs_list(projectId=los, traceId=…)` → `matched=1`、拿到
  `run-session-1791684054805-1791684805`；③用找回的 id 读 `los_run_state` 成功（闭环）。
  台账侧独立复核：该 run `succeeded`、`task_runs` 在 `mbp-executor-1` `succeeded`。
- 适配器工具面变为 5 个：`los_run, los_runs_list, los_run_state, los_run_replay, los_operator_control`。

### 9.2 S4 的未决问题已答：**提前断连不会取消运行**（`[E]`）

`/tmp/los-abort-probe.mjs`：读到 `session` 事件（2426 B）后**主动 `controller.abort()`**，
等待 12s 后查库 —— `run-session-1791684075571-1791684075572` 的 `run_specs.status=succeeded`、
`task_runs.status=succeeded`（`mbp-executor-1`）。
另一次"从不消费响应体"的同型观测也得到 `succeeded`（§9.1 验收 ① 的那条）。

⇒ **执行不依赖 SSE 消费者**，因此 `los_run(detach)` 可以在**适配器侧**实现
（读够拿到 `sessionId/runSpecId/taskRunId` 就断开），**不需要网关标志位或 `run-stream` 契约改动**
——比本节原先的估计乐观。未验证项：网关侧是否留下断连噪音日志（`[U]`，本机找不到 gateway stdout 落盘位置）。

已核实的网关面（只读确认，未改）：

| 能力 | 现状 | 依据 |
| --- | --- | --- |
| run 列表 | `GET /runs` 存在；handler 只认 `since`/`limit`，内部 `listRunSpecs()` 全量 | `file:packages/gateway/src/routes/orchestration/run-routes.ts:415` |
| 验证 / 审批 / 恢复 | `POST /runs/:id/verify`、`/approve`、`/recover`、`/revise-plan`、`/answer` 均已存在 | `file:packages/gateway/src/routes/orchestration/run-routes.ts:420` |
| 取消 | **没有** `/runs/:id/cancel`；只有 task 级 `POST /tasks/:id/cancel` | `file:packages/gateway/src/route-admission-inventory.ts:260` |

### 9.3 S4 `los_run(detach)`（2026-10-11 交付）

`file:packages/cli/src/mcp-serve.ts:89`（读参）、`file:packages/cli/src/mcp-tools.ts:40`（工具面）、
`file:packages/cli/src/mcp-serve.ts:264`（`readUntilEvent`：读到条件即 abort）、
`file:packages/cli/src/mcp-serve.ts:297`（`runIdentity`）、停条件 `file:packages/cli/src/mcp-serve.ts:118`；
契约 `file:contracts/programmatic-agent-interface.yaml:25`（`detachRule`）；
测试 `file:packages/cli/src/mcp-serve.test.ts:252`（含负向控制：不该读到的 `done` 事件绝不被读）、
`:280`（detach 下守卫照旧）。

- 语义：`detach=true` 时读够**完整分派身份**（`runSpecId` + `sessionId` + `taskRunId`）即 abort 连接，
  返回 `status="detached"` / `detached=true`；运行继续（§9.2 实测）。
- **验收（真机）**：`/tmp/los-detach-probe.mjs` —— 派发耗时 **101ms**，返回
  `runSpecId=run-session-1791684961210-1791684961219`、`ownerRepo=dsfolder-fmtguard`、
  `workspaceRoot=…/dsfolder/fmtguard`、`text=undefined`（没等运行结束）；
  随后 `los_run_state` 轮询到 `phase=succeeded` ⇒ **P0-2 的"超时丢 id"从根上消失**（不再依赖 S1 的事后找回）。
- **又一次同型形状坑（第三次）**：首跑返回 `status=detached` 但 `runSpecId=undefined`。原因是
  真实流里 `runSpecId` **只在 `coordinator.intake_resolved` 的 `payload.runSpecId` 内**，
  而 `session` 事件只有 `{sessionId, taskRunId}`（`done` 才是扁平且 id 齐全）。
  修法：抽出 `runIdentity()` 作为唯一取 id 口径，并按"三个 id 齐全"作为停条件——
  与 §6.1 是同一类错误的第三次出现（信封 vs 扁平），已用测试锁住真实形状。

### 9.4 S2 `los_run_verify` / `los_run_approve`（2026-10-11 交付）

工具面 `file:packages/cli/src/mcp-tools.ts:84`（verify）/ `:100`（approve）；handler
`file:packages/cli/src/mcp-serve.ts:172`（verify）/ `:191`（approve）；验证结果投影
`file:packages/cli/src/mcp-projections.ts:233`；契约 `file:contracts/programmatic-agent-interface.yaml:80`（verify）/ `:92`（approve）；
测试 `file:packages/cli/src/mcp-serve.test.ts:183` 起四条（含无凭据拒绝与半对 capability 本地拒绝）。

- 两者都走"网关路由 requireOperator ⇒ 适配器 `operator: true`"：没有 operator 凭据时**先抛错、不发 HTTP**。
- verify 的返回做了有界投影（每条记录 `outputSummary` 截 300 字符）——原始返回带完整
  `VerificationRecord[]`，多检查的 run 足以撑爆 MCP 结果。

**验收（真机）**：

| 靶子 | 观测 | 判定 |
| --- | --- | --- |
| §2 P4 那条停在 `phase=created` 的 run | `los_run_verify` 真跑了 2 条记录：`r1-2` `succeeded`（`true` → `ok`），`r1-1` **failed** 且 stderr 如实回传（`/bin/sh: noop: command not found`）；state 由 `created` 推进到 `phase=blocked` | 通过（死胡同解除） |
| 新建 `runContract.phase='planning'` 的 run | `los_run_approve` → `phase=plan_approved`、`previousPhase=planning`、`dispatch={status:scheduled}` | 通过（正面路径） |

**两条如实记录的观测（都不是适配器缺陷）**：

1. **`requiredChecks` 是命令，不是检查名**：我在 P4 探针里写 `requiredChecks: ['noop']`，
   网关据此派生的检查命令就是 `noop` ⇒ 必然失败。参考实现
   `/Users/echerlos/syncfolder/project/dsfolder/scripts/rust-repo-gate-run.mjs:290` 的写法才是对的
   （`requiredChecks: checks.map(c => c.command)`）。所以 §2 P4 的"死胡同"里，**工具缺口是真的**
   （已修），**契约内容是我写坏的**（探针作者的问题）。
2. **两个"phase"不是同一个源**：approve 迁移读 `runContract.phase`（故报 `previousPhase=planning`），
   而 `los_run_state` 按 run/task 状态分类、对同一个 run 报 `phase=created`。
   生命周期以 `los_run_state` 为准，审批迁移以上面的 approve 返回为准。

### 9.5 交付顺序（更新）

- **S1 `los_runs_list`** — 已交付，见 §9.1（bookmark `feat/mcp-runs-list`）。
- **S2 `los_run_verify` / `los_run_approve`** — 已交付，见 §9.4。
- **S3 `los_run_cancel`**：以 `taskRunId` 为入参包装 `POST /tasks/:id/cancel`。**未开工**。
  已核实：该路由**没有 operator 门禁**（`file:packages/gateway/src/routes/orchestration/task-routes.ts:119`，
  故它在 route-admission 的 review 列表里）——适配器侧要**比网关更严**（要求 operator 凭据）。
- **S4 `los_run(detach)`** — 已交付，见 §9.3。

残留：`mcp-serve.ts` 现为 487 行，距 `check-structure.sh` 的 500 行门禁只剩 13 行；
下一次再往该文件加逻辑应先把投影/事件读取拆成独立模块（`mcp-tools.ts` 是同一手法的先例）。
