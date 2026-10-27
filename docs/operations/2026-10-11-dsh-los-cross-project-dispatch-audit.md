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
| P0-2 | 长任务被上层截断且丢 `runSpecId` | **已修**：`los_run(detach)` 在 id 齐全时即返回（§9.3，实测 101ms），`los_runs_list` 可按 `traceId` 事后找回（§9.1） |
| P0-3 | 契约跑不完 | **已修**：`verify`/`approve`（§9.4）、`recover`/`revise-plan`（§9.8）、blocked/error 终态带 `runSpecId`+`nextAction`（§9.7/§9.3）均交付 |
| P1-1 | 无 run 发现/取消入口 | 已交付：发现（§9.1）、task 级取消（§9.5）、**run 级终止**（`recover(apply=true,intent=cancel)`，§9.8 实测 `phase=cancelled`） |
| P1-2 | 幂等假象：随机幂等键对重试无保护 | **已修**：写工具接受调用方 `idempotencyKey`（`los_run` 回退 `dedupeKey`）并作为 `x-idempotency-key`；实测同键同体两次调用返回同一个 run（库里 1 条 run spec）。缺省不再发随机键（不造假象） |
| P1-3 | 项目登记面缺口无门禁 | **已修**：`tools/check-los-project-bindings.mjs` + 接入 `pnpm check`；硬判据=近 30 天台账出现**未绑定且非归档**项目（归档仓历史残留按登记豁免），提示=登记仓无 binding 覆盖（实测 9 个） |
| P1-4 | 写入无隔离、节点不可选 | **一半已修**：`sandboxMode`/`allowedTools` 已透传（实测 `workspace-write` → L1/`sandboxAvailable:false`；`sandbox` → **L2 + `sandboxAvailable:true`**（检测到 OS 沙箱）；`allowedTools` 落 `run_specs.allowed_tools_json`）。**node 仍不可选**（已按设计门禁记录：见 `architecture/2026-10-11-execution-node-selection-and-remote-runs.md`——远端派发只在 scheduler 路径，且近 7 天零 agent run，故不暴露 node 参数）**：：`/chat` 完全不消费 `body.executor`（只有 scheduled-work / experiment 路由消费）⇒ 派发仍落在配置的 executor 节点（实测 `mbp-executor-1`）；适配器**有意不暴露** node 参数，避免造出 chat 路径会忽略的第二真源 |
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

## 9. 后续工作：S1 / S2 / S3 / S4 全部交付（本轮收口）

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

### 9.5 S3 `los_task_cancel`（2026-10-11 交付）

工具面 `file:packages/cli/src/mcp-tools.ts:115`；handler `file:packages/cli/src/mcp-serve.ts:209`；
契约 `file:contracts/programmatic-agent-interface.yaml:101`；测试 `file:packages/cli/src/mcp-serve.test.ts:440` 起两条。

- **命名按事实取 `los_task_cancel`（不是计划里的 `los_run_cancel`）**：网关只有 task 级取消
  （`file:packages/gateway/src/routes/orchestration/task-routes.ts:119`），没有 run 级取消路由。
  取 id 的路径：`los_run_state` → `ids.activeTaskRunIds`。
- **适配器比网关更严**：该路由**没有** operator 门禁（所以在 route-admission 的 review 列表里），
  适配器仍要求 operator 凭据并转发该头——无凭据时先抛错、不发 HTTP。

**验收（真机，`/tmp/los-cancel-probe.mjs`）**：detach 派发一个要读文件的 run
（`run-session-1791686026513-1791686026521`，`task-0cdb7ff1…`）后立刻取消 → 返回
`{ok:true, live:false, taskRun:{…}}`；4s 后 `los_run_state` 的
`counts.taskRuns={total:1, cancelled:1, running:0}` ⇒ **任务确实被取消**；重复取消 `live=false`。

**当时的残留**：task 级取消**不动 run spec** —— 同一个 run 的 state 仍是
`phase=created` / `action=wait_for_task` / `activeTaskRunIds=[]`，因为网关没有 `/runs/:id/cancel`。
**该残留已在 §9.8 找到 run 级路径**：`los_run_recover(apply=true, intent=cancel)` 会把 run spec
迁到 `cancelled`（实测）。task 级取消仍是"只停任务"的语义，两者互补而非重复。

### 9.6 交付顺序（全部完成）

| 步 | 内容 | 交付物 |
| --- | --- | --- |
| S1 | `los_runs_list` | §9.1，bookmark `feat/mcp-runs-list` |
| S2 | `los_run_verify` / `los_run_approve` | §9.4，bookmark `feat/mcp-run-verify-approve` |
| S3 | `los_task_cancel` | §9.5 |
| S4 | `los_run(detach)` | §9.3，bookmark `feat/mcp-run-detach` |

§5 缺口表的 P0-2 / P0-3 / P1-1 三行随之更新；**P0-1 已在 §6 修复**。

### 9.7 收尾小项（2026-10-11）

| 项 | 状态 | 落点 / 说明 |
| --- | --- | --- |
| blocked/error 终态附带回传**下一步 action** | 已交付 | 投影 `file:packages/cli/src/mcp-projections.ts:291`、富化 `file:packages/cli/src/mcp-serve.ts:144`、契约 `file:contracts/programmatic-agent-interface.yaml:39`、测试 `file:packages/cli/src/mcp-serve.test.ts:476` 起三条（含"成功终态不多花一次 state 调用"的负向控制）。真机：error 终态回传 `nextAction.action="run_verification"` + 结构化 blockers（ids 带上限与 `truncated` 标记） |
| `recover` / `revise-plan` 暴露为工具 | 已交付 | 见 §9.8 |
| 桌面板 web 重启插件的 host-smoke | 已交付 | `dsplugins/dsh-web-host-restart/test/host-smoke.test.mjs`：用运行中 profile 的宿主库（`~/.dsh/profiles/node_modules`）真加载 `index.mjs`、真 `defineTool` 编译、真执行只读工具 `web_host_status`（7/7、0 skip）。顺带记下两个硬要求：`defineTool` 必须有 `output.render`（否则注册期报 `reading 'render'`）；编译后 `parameters` 是 Schema 对象 |
| run 级取消 / state 识别 task-cancelled | 已找到路径（见 §9.8） | `los_run_recover(apply=true, intent=cancel)` 把 run spec 迁到 `cancelled`；无需新增网关路由 |
| wiring baseline 2 条 fixable | 未动 | 属 `packages/agent` 的漂移（`--update-baseline` 会把 telegram/wechat 的手写注释一起降级），不并入本批 |

残留：`mcp-serve.ts` 现为 487 行，距 `check-structure.sh` 的 500 行门禁只剩 13 行；
下一次再往该文件加逻辑应先把投影/事件读取拆成独立模块（`mcp-tools.ts` 是同一手法的先例）。

### 9.8 `los_run_recover` / `los_run_revise_plan`（2026-10-11 交付）

工具面 `file:packages/cli/src/mcp-tools.ts:115`（recover）/ `:131`（revise-plan）；handler
`file:packages/cli/src/mcp-serve.ts:226` / `:248`；恢复投影 `file:packages/cli/src/mcp-projections.ts:316`；
契约 `file:contracts/programmatic-agent-interface.yaml:110`（recover）/ `:146`（revise-plan）；
测试 `file:packages/cli/src/mcp-serve.test.ts:557` 起四条。

- **`apply` 缺省 false ⇒ 只读预览**（网关的只读分支），要迁移必须显式 `apply: true`。
- 两种返回形状（预览 decision / 已应用 transition+嵌套 decision）收敛成一个有界投影：
  每个 id 列表截 20 条并带 `truncated`，`reasons` 截 10 条。
- `revise-plan` 的 `plan` 本地要求非空数组（网关允许缺省，但那对调用方基本是笔误）。

**验收（真机，`/tmp/los-recover-plan-probe.mjs`）**：

| 调用 | 观测 | 判定 |
| --- | --- | --- |
| `los_run_recover`（预览） | `applied=false`、`status="clean"`、`recommendation="none"` | 通过 |
| `los_run_revise_plan`（新 plan） | `planRevision 1 → 2`、`previousRevision=1`、`phase=planning` | 通过 |
| `los_run_recover(apply=true, intent=cancel)` | `action="cancel"`、`runSpecStatus="cancelled"`、`eventType="run.recovery_cancelled"` | 通过 |
| `los_run_state`（之后） | `phase="cancelled"` | 通过（**run 级终止成立**） |

⇒ 由此修正 §9.5 的残留结论：**run 级终止路径存在**，是 `recover(apply=true, intent=cancel)`，
而不是缺失的 `/runs/:id/cancel` 路由。

## 10. 任务交接与跨项目：能力与边界复核（2026-10-11）

除标注 `[U]` 外均为当场实测 `[E]`。

### 10.1 交接面（谁把活交给谁）

| 方向 | 机制 | 状态 |
| --- | --- | --- |
| DSH → los | MCP 10 工具：派发 / `detach` / 续接（`sessionId`）/ 生命周期（verify·approve·recover·revise-plan）/ 取消 / 证据（state·replay·list） | 可用（本文 §6–§9.8） |
| los 内部 | `sessionId` 续接、`session-subagents` 子代理谱系（`parent_run_spec_id` + Web 树）、Work Item/Inbox（todo→run）、plan 审批与验证门禁、`recover`/`revise-plan` | 可用（契约 `session-subagents`/`work-item` 均 `implemented` 且有消费点） |
| los → DSH | **只到通知**：`execution_outbox` 哨兵 `dsh_event` → DSH `/los-events`（`/health` 曾见 `published=4`） | 可用，但**没有"把活交回 DSH 执行"**的通路 |
| DSH 内部 | `subagent` / `subagent_fork`（上下文继承）+ 会话 resume；los 侧用 `dsh_session_catalog` **只读**看 DSH 会话（`cross-project-summary`，`implemented`） | 可用 |

### 10.2 续接（交接原语）的边界——实测

- 同一 session 累积 run：`session-1791687701996` 现有 **4 条 run spec**（首个 + 三次续接）`[E]`。
- 每次续接都会算 **resume plan**：`coordinator.resume_plan_selected` 的 `selectionReason` 两次都是
  **`no_recoverable_run`**（前序分别是 `cancelled` 与 `succeeded`）`[E]`。
- 可恢复状态集合 = `{created, running, blocked, failed}`（`file:packages/gateway/src/chat-resume-plan.ts:13`）
  ⇒ `succeeded` / `cancelled` **不在其中**，所以"上一条成功"并不构成 resume 候选 `[E]`。
- **上下文注入规则（已定位）**：装配点是
  `initialMessages: branchSourceMessages ?? resumedSession?.messages`
  （`file:packages/gateway/src/chat-service.ts:320`）；只有会话**没有**消息时才回退到
  `reconstructRecoveryContext`（`:323`）。而会话消息**只累积正常收口的 run**：
  实测 `session-1791687701996` 的 `messages_json` 有 7 条，正好等于三条成功 run 各留
  (user, assistant)（3+2+2）；那条 **error 终态** run 的 prompt（`BLOCK-ID`）**完全不在**里面 `[E]`。
- 因此：前序 run 以 `error`（或中途夭折）收口 ⇒ 续接首轮 `messageCount=2`（等于全新会话）；
  前序正常成功 ⇒ `messageCount=4`（带上一轮一问一答）`[E]`。
- **交接配方（可操作结论）**：想"带上下文交接"，就续接一个**前序正常成功**的会话；
  若前序是 error/中途取消，续接**不带上下文** ⇒ 必须把关键上下文写进 prompt，
  或先用 `los_run_state` / `los_run_replay` 把证据取出来交给新会话。
  不要用 resume plan 预测是否带上下文（`succeeded`/`cancelled` 都不在候选集里）。
- 交接安全闸（`coordinator-resume-guard`）**已 live 验证**（2026-10-11，第二次尝试）`[E]`：
  在**已有完成过 run 的会话** `session-1791687701996` 上先派一个重任务（8 轮多文件读取，detach），
  趁其仍在跑时立刻用同一 sessionId 再派一次 ⇒ 第二次的流里直接出现
  `coordinator.resume_plan_selected` → `run.resume_dispatch_suppressed` → `session.blocked`，
  **没有 `task` 事件**；台账：plan `reason=latest_recoverable_run`、`selected=<在跑的那个 run>`、
  `active=["task-b69a4920…"]`，抑制事件 `reason=active_task_present`，第二个 run=**blocked** 且
  `task_runs` 计数 **0** ⇒ 重复派发被拦在任务创建之前。
- **该闸门的可达性边界（实测）**：它只在会话**已被落盘**时才可能触发——`loadSession(sid)` 对
  "首个 run 尚在飞的会话"返回 null（会话行在该会话第一个 run 收口时才写入），于是**根本不会走 resume 路径**。
  实测两例：新会话首派仍在跑时续接 → 无 `resume_plan_selected`、不抑制（第二个 run 照常 `succeeded`）；
  同一会话并发两次（同一新 sid）→ 同样无 plan 事件。⇒ "首个 run 的并发续接"不受该闸门保护 `[E]`。
- **教训（记一笔）**：第一次竞态我读到"两个 run 都 succeeded"就准备下结论"闸门不生效"；
  查时间戳后发现前序 run 已在续接前 0.65 s 收口，`candidates=[]` 本就正确——**差点报了个假发现**。

### 10.3 跨项目边界——能到哪、到不了哪

- **可派活 = 10 个 binding**（`~/.los/projects.json`）；工作区登记 **30 个仓** ⇒
  **27 个登记仓 los 够不到** `[E]`。其中 `dsfolder` 的子仓可借 `projectId=dsfolder` + operator
  `workspaceRoot` 变通，但归属会记成 `dsfolder`（粒度变粗，台账不再按子仓分开）。
- 未登记仓（`cankey` / `canpad` / `lot2extension` / `wechatdp` / `deepseek-harness` / `los-memory` …）
  **完全够不到**：显式 `projectId` 必须已绑定；只给 `workspaceRoot` 时必须在某 binding 之内 `[E]`。
- 读：跨项目可用（`GET /runs` 全量；`state`/`replay` 跨项目）`[E]`。
- 写：跨项目需 `operatorScope`（`projectId`/`workspaceRoot` 才生效）`[E]`；生命周期工具走
  operator + `projectId`，跨项目可用（本轮在 `dsfolder-fmtguard` 上实测 `runs_list`/`recover`）`[E]`。
- 登记面**已有机械门禁**（2026-10-11）：`tools/check-los-project-bindings.mjs` 对照 `~/.los/projects.json` 与工作区登记，硬失败只认"近 30 天台账里出现未绑定且**非归档**项目"；实测 10 binding / 30 登记仓 / **9 个够不到**；`run-diff` 的 43 条历史 run 按 `kind: archived` 豁免 `[E]`。

### 10.4 交接面的两个实际缺口

1. `dsh-los-ops` 的 `los_chat` **没有 target repo 参数**（固定 los）`[E]`——DSH 侧"顺手的 HTTP 工具"仍不能跨项目，
   跨项目只能走 MCP 工具或 bash+operator 凭据。
2. ~~幂等假象~~ **已在 2026-10-11 修复**：写工具接受调用方 `idempotencyKey`（`los_run` 回退 `dedupeKey`），
   实测同键同体两次调用返回同一 run 且台账只有 1 条 `run_spec`；缺省不发随机键。

## 11. 试点验证：cantool 只读审计（2026-10-11）

**选题**：`cantool`（Tauri 应用：`src-tauri/` + `frontend/`）——本机常用、已绑定、工作树干净。

**契约**：`mode=audit` / `executionMode=lightweight` / 1 步计划 /
`requiredChecks=["git rev-parse --short HEAD", "test -d src-tauri"]`（命令即门禁，符合参考实现的写法）。

**全链路（全部走本会话的 MCP 工具面）**：

1. `los_run(projectId=cantool, operatorScope=true, detach=true, runContract=…)` —— **立刻返回**
   `run-session-1791689336538-1791689336558`，且 `ownerRepo="cantool"`、`workspaceRoot=…/cantool`
   ⇒ 跨项目 + 非阻塞两条同时成立。
2. `los_run_state` —— 运行中 `action="run_verification"`，两个 blocker：verification 未满足 + `active_task`。
3. `los_run_verify` —— 两条 required check **真执行**：`git rev-parse --short HEAD` → `21aedac42`；
   `test -d src-tauri` → `ok`；`decision.status="succeeded"`，无 pending/failed。
4. 台账 —— `run_specs.status=succeeded`、`task_runs.status=succeeded`（node `mbp-executor-1`）。

**结论的独立核对（不看 agent 自述）**：crate 名 `cantool` ✅、前端依赖 13+29=42 ✅、
`scripts.build="vite build"` ✅、`tauri="2"` ✅ —— 四项全部与仓库实际一致。

**只读性自证**：试点前后 `git status --porcelain` 均为 **0 项**，HEAD 未变（`21aedac42`）。

**这次试点覆盖到的东西**：跨项目 operatorScope 派发、`detach` 非阻塞、`runContract` 派生命令门禁、
"派活 → 盯活 → 收活"的证据面（state / verify / 台账）。**没覆盖**：写路径（`project-write`）、
sandbox 隔离、非默认节点——它们仍是 §5 的 P1-4 缺口。

