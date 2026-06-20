# Codex Handoff, OpenCodex, DevSpace 接入分析

日期：2026-06-20

## 结论

Codex 官方的 thread handoff 已经覆盖“本机与远端主机之间继续同一条线程”的产品能力：前提是目标 host 已连接、两端保存了同一 Git 仓库的项目；handoff 会创建或复用目标 host 的 worktree，迁移 thread 和 Git state，并把后续执行位置切到目标 host。运行中的 thread 在迁移前会被中断。

对 `los` 来说，最值得实现的不是复制 Codex App 的私有 handoff UI，而是把这一模式抽象成 `portable_run`：由 `los` 保存 thread/run/session 的执行 envelope、Git state、worktree 元数据、handoff summary、事件游标和通知策略。Codex、Claude、DevSpace、OpenCodex 都可以作为外部 runtime 或参考实现接入，但只有通过 `los` 发起或登记的任务才能被完整观测、控制、通知和审计。

推荐组合方案：

1. P0：用 Codex app-server/SDK 替换当前 `codex -p` 的薄封装，得到 Thread/Turn/Item 级控制能力。
2. P1：引入 DevSpace 式 workspace allowlist、Owner approval、worktree session、工具卡/变更摘要模型，作为 `los` Web/IM 远程下发任务的安全外壳。
3. P2：参考 OpenCodex 的模型网关、Codex Desktop 配置面板、SSE live logs、Computer Use/Vision Bridge，但不要让它成为 `los` 状态源。
4. P3：实现 `los` 自己的 runtime handoff：`local host -> remote node -> local host`，以 `runtime_runs`、`session_events`、`run_specs`、`task_runs` 和 `operator_events` 为审计面。

## 证据范围

已验证的当前事实：

- OpenAI Codex 手册更新时间通过本地 helper 拉取，路径为 `/var/folders/.../openai-docs-cache/codex-manual.md`。
- 官方 Codex Remote connections 文档说明：移动端/其他设备可启动或继续 host 上的 threads、发送 follow-up、批准动作、查看输出/diff/test/terminal/screenshot，并在任务完成或需要注意时通知用户。
- 官方 handoff 文档说明：目标 host 必须有匹配 Git 仓库的 saved project；handoff 会创建或复用 worktree、转移 thread 和 Git state；运行中的 thread 会先中断。
- 官方 Codex app-server 文档说明：`codex app-server` 暴露 JSON-RPC 2.0，核心对象是 Thread、Turn、Item；可 `thread/start`、`thread/resume`、`thread/fork`、`turn/start`、`turn/steer`、`turn/interrupt`，并流式接收通知。
- 官方 Codex SDK 文档说明：TypeScript/Python SDK 可以启动新 thread、继续同一 thread，或用 thread id resume 旧 thread。
- `AITabby/opencodex` GitHub API 当前显示：TypeScript，默认分支 `master`，`pushed_at=2026-06-20T04:55:37Z`，近一个月 58 个提交，README 描述为 Codex Desktop 本地 gateway、web dashboard、Vision Bridge、Computer Use router。
- `Waishnav/devspace` GitHub API 当前显示：TypeScript，默认分支 `main`，MIT，`pushed_at=2026-06-17T18:49:00Z`，近一个月 API 返回至少 100 个提交，README 描述为自托管 MCP server，把本机项目安全暴露给 ChatGPT。
- `los` 当前已有 `POST /runtimes/:kind/run`，能 spawn `claude-code` 和 `codex`，并尝试通过 OTel bridge 归一事件。
- `los` 当前已有 `external_tool_summaries`，但只允许把 Codex/Claude 等外部工具输出作为 redacted `external_summary` 证据导入，不等价于 `los` runtime replay。
- `los` 当前已有 `/operator/events/live`，但事件范围集中在 `tool.warned`、`tool.denied`、`operator_attention`、`session.blocked`、`session.error`。

未验证或不应假设的内容：

- Codex handoff 的内部私有传输协议未在公开手册中展开；不能把 OpenCodex 生成的 `codex-client/v2` 类型当作官方稳定 API。
- OpenCodex 会改写 `~/.codex/config.toml` 并代理请求，这适合个人本机实验，不应直接作为 `los` 的权威配置状态。
- DevSpace 的 shell tool 能执行本机命令；它的文件 allowlist 不构成 shell 沙箱。接入 `los` 时仍需要 `los` 自己的 auth、policy、audit 和 kill/cancel。

## Codex Handoff 能力如何工作

从公开文档能确认的机制是四段：

1. Host connection：Codex App host 保存本机/远端项目，远程访问经授权 ChatGPT 设备和安全 relay 使用 host 的项目、文件、凭证、插件、MCP、浏览器和本地工具。
2. Project matching：handoff 目标只显示“同一 Git 仓库”的 saved project。如果项目是仓库子目录，两边要保存同一子目录。
3. State transfer：handoff 创建或复用目标 host 的 worktree，迁移 thread 和 Git state，并切换执行位置。
4. Run interruption：如果 thread 正在运行，handoff 会先中断当前响应，再迁移。

更底层的可接入面是 app-server 和 SDK。`codex app-server` 提供可编程 Thread/Turn/Item 协议，支持 start/resume/fork/steer/interrupt 和事件流；SDK 进一步包装本地 app-server，可继续同一 thread 或通过 thread id resume。对 `los` 来说，这是比 `codex -p` 更合适的运行时适配层，因为它天然提供 thread id、turn lifecycle 和 event stream。

## 参考项目能力盘点

### OpenCodex

定位：Codex Desktop 的本地 gateway、模型配置 dashboard、Computer Use/Vision Bridge 扩展。

可借鉴点：

- 本地 Web dashboard：API key、endpoint、custom model catalog、实时 SSE logs、一键 restart/reset。
- Responses 到 Chat Completions 的协议转换：对 OpenAI-compatible provider 的适配思路可用于 `los` 的 provider compatibility 面板。
- Computer Use router：在 CLI/Desktop 不同来源下选择不同自动化路径，失败时绕开不可用的 browser extension。
- Vision Bridge：把截图压缩、走多模态描述，再把文本描述注入给纯文本模型。
- 会话连续性方向：近一个月提交包含 `reuse responseId per session & pass sessionId to responses`，说明它在补 session 级上下文延续。

不建议直接并入点：

- 自动 patch `~/.codex/config.toml` 容易和 `los` 的 config truth、Codex 自身 managed config、用户全局配置冲突。
- macOS CGEvent、TCC、启动脚本和语音伴侣是很强的本机偏好，不应进入 `los` 核心 runtime。
- OpenCodex 的日志/SSE 是 dashboard 观测面，不是 `los` 的持久化 evidence graph。

### DevSpace

定位：自托管 MCP server，把本机目录作为受控 workspace 暴露给 ChatGPT/Claude 等 MCP host。

可借鉴点：

- Workspace allowlist：用户明确配置可打开的 roots，避免暴露 `~` 或 `/`。
- Owner password/OAuth approval：客户端连接时必须通过用户批准。
- Host allowlist：从 public base URL 派生允许的 Host header。
- `open_workspace -> workspaceId` 模型：后续 read/write/edit/bash/show-changes 都绑定同一 workspaceId。
- Worktree mode：为并行 coding session 创建 managed worktree，并报告 source checkout 是否 dirty。
- 指令文件显式返回：打开 workspace 时返回 root `AGENTS.md`/`CLAUDE.md` 和 nested 可读指令文件，不做不可见注入。
- Skills 发现规则：返回匹配 skill，要求模型先读 `SKILL.md` 后才能读取 skill 目录内其他文件。
- Widget/change summary：为 MCP host 提供工具卡和变更摘要，适合移植到 `los` Web/IM 审批体验。

不建议直接并入点：

- 它把 shell 作为强工具暴露给 MCP client；`los` 必须继续经过 auth、workspace policy、operator gate、runtime registry 和 session event。
- DevSpace 是 MCP workspace server，不是多 runtime supervisor；不能替代 `los` 的 `task_runs`、verification gate、runtime evidence graph。

## 与 los 当前能力的结合方式

### 当前 los 已有基础

- Gateway runtime route：`packages/gateway/src/routes/orchestration/runtime-adapter-routes.ts`。
- Codex adapter：`packages/agent/src/runtime-adapter/codex.ts`，当前是 `spawn(codex, ['-p', prompt])` 并注入 OTel env。
- Claude adapter：`packages/agent/src/runtime-adapter/claude-code.ts`，当前 spawn `claude -p --print` 并注入 OTel env。
- Runtime event projection：`session_events`、`runtime-evidence-graph.ts`、`external-tool-summary.ts`。
- Operator notification：`/operator/events/live` + WeChat/Telegram bot 订阅。

### 缺口

- `codex` 运行时还是进程级封装，没有 Thread/Turn/Item 级别的 resume、steer、interrupt、fork。
- 没有 `runtime_runs` registry，无法稳定列出 pid、threadId、workspaceRoot、hostId、worktreePath、status、startedAt、endedAt、exitCode、traceId。
- 没有本机/远端 host 的 project matching 规则，也没有 worktree handoff envelope。
- `/operator/events/live` 还没有 runtime started/completed/failed/cancelled、handoff requested/accepted/failed、approval requested 等事件类型。
- Web 还没有 runtime 页面、process inventory、launch/cancel/kill/steer UI。

## 方案设计

### 方案 A：Codex App Server Adapter

把 `codex` adapter 从 `codex -p` 改成 `codex app-server` 客户端。

新增概念：

- `runtime_runs.runtime_kind='codex'`
- `external_thread_id`：Codex thread id
- `external_turn_id`：当前 turn id
- `control_transport`：`stdio`、`unix`、`ws`
- `control_capabilities`：`resume`、`steer`、`interrupt`、`fork`、`events`

执行时序：

1. `POST /runtimes/codex/run` 创建 `runtime_run`。
2. Adapter 启动或连接 `codex app-server`。
3. 发送 `initialize`/`initialized`。
4. 新任务调用 `thread/start` + `turn/start`；续跑调用 `thread/resume` + `turn/start`。
5. 把 app-server notifications 映射为 `session_events`。
6. Web/IM 的 follow-up 调用 `turn/steer`。
7. Cancel 调用 `turn/interrupt`，再按需 kill 进程。

判断：这是最优先方案。它把 Codex 官方稳定/半稳定控制面纳入 `los`，比解析 stdout 或只依赖 OTel 更适合观测与控制。

### 方案 B：los Portable Run Handoff

实现 `los` 自己的 handoff，不依赖 Codex 私有迁移协议。

Portable envelope：

```json
{
  "runtimeRunId": "rr_...",
  "sessionId": "session_...",
  "sourceHostId": "host_local",
  "targetHostId": "host_remote",
  "workspaceRoot": "/repo/subdir",
  "repoRoot": "/repo",
  "gitHead": "abc123",
  "baseRef": "main",
  "dirtyPolicy": "block|patch|summary-only",
  "worktreePath": "/.los-runtime/worktrees/...",
  "handoffSummaryId": "summary_...",
  "lastEventId": 1234,
  "externalThread": {
    "kind": "codex",
    "threadId": "thr_..."
  }
}
```

执行时序：

1. Source host 对当前 run 做 `turn/interrupt` 或 runtime cancel。
2. 生成 handoff summary，记录 open tasks、last events、tool states、verification gaps。
3. 记录 Git state：HEAD、branch、diff summary、dirty policy。
4. Target host 验证同一 repo/subdir，创建或复用 managed worktree。
5. Target host 根据 runtime kind resume：Codex 用 `thread/resume`，Claude/Codex CLI fallback 用 prompt + handoff summary。
6. `session_events` 记录 `runtime.handoff.requested`、`runtime.handoff.accepted`、`runtime.handoff.completed|failed`。
7. Web/IM 通知操作者迁移结果和下一步审批请求。

判断：这是 `los` 长期该拥有的能力。Codex 的 native handoff 可以作为外部能力，但 `los` 的审计、通知、权限和跨 runtime 控制应由 portable envelope 承担。

### 方案 C：DevSpace-style Remote Workspace Gateway

把 DevSpace 模式吸收到 `los` 的节点/通信层。

新增能力：

- `workspace_roots` allowlist。
- `workspace_sessions`，类似 DevSpace `workspaceId`。
- `managed_worktrees`，记录 source root、baseRef、baseSha、dirtySource。
- Owner approval 页面或 IM approval code。
- `open_workspace` 工具/route，返回 root instruction files、nested instruction file hints、available skills。

判断：适合 `los` Web/IM 下发任务前的安全准备层。它不替代 runtime，但能让远程任务进入 `los` 前有明确 workspace、权限和审核记录。

### 方案 D：OpenCodex-style Desktop Gateway

把 OpenCodex 当作 Codex Desktop 旁路能力参考。

可落地到 `los`：

- Runtime dashboard：模型目录、Codex/Claude 可用性、app-server/OTel bridge 状态、SSE logs。
- Vision Bridge：作为 optional capability，挂到 Computer Use 或 browser automation，不进入核心 agent loop 默认路径。
- Adaptive routing：根据 source `cli|desktop|web|im` 选择 tool policy 和 browser/computer-use backend。

判断：适合做增强插件，不适合做 `los` 核心状态源。尤其不能让 OpenCodex 自动 patch 全局 Codex config 成为 `los` 的默认配置路径。

## 推荐实施顺序

### P0：Runtime Registry + Codex App Server Adapter

交付：

- `runtime_runs` store。
- `GET /runtimes/runs`、`GET /runtimes/runs/:id`、`POST /runtimes/runs/:id/cancel`、`POST /runtimes/runs/:id/steer`。
- `codex app-server` adapter，保留 `codex -p` 作为 explicit fallback。
- session event 类型：`runtime.started`、`runtime.thread.started`、`runtime.turn.started`、`runtime.item.started`、`runtime.item.completed`、`runtime.completed`、`runtime.failed`、`runtime.cancelled`。

验证：

- 启动一个 Codex run 后 Web/API 可看到 pid、threadId、turn status。
- steer 会进入同一 thread。
- cancel 会触发 `turn/interrupt` 并落 `session_events`。

### P1：Web/IM Runtime Control

交付：

- Web `Runtimes` 页面：availability、version、bridge/app-server status、run list、launch、cancel、steer、open session。
- `/operator/events/live` 扩展 runtime/handoff/approval 事件。
- WeChat/Telegram 通知规则：completed、failed、blocked、approval_required、handoff_failed。

验证：

- 从 Web 下发 Codex/Claude run，IM 收到 started/completed/failed。
- 从 IM 发 follow-up，落到对应 runtime run。

### P2：Portable Handoff

交付：

- `runtime_handoffs` store。
- host/project matching：repo root、subdir、remote host workspace roots。
- managed worktree 创建和 dirty policy。
- handoff summary 生成与 redaction。
- source interrupt + target resume 流程。

验证：

- local -> remote -> local 的同一 run 可追踪。
- 失败时保留 source run 状态和 target failure evidence。

### P3：Workspace Gateway 和 Vision/Computer Use 扩展

交付：

- DevSpace-style workspace session。
- Skill/instruction discovery 显式返回。
- OpenCodex-style Vision Bridge optional tool。
- Desktop automation backend 能力登记，但默认禁用高风险操作。

验证：

- 不在 allowlist 的路径无法打开。
- 未批准连接无法执行 shell。
- shell 操作记录 command preview、exit、duration，不记录 secret/raw transcript。

## 风险与边界

1. Codex native handoff 不是公开低层协议。`los` 可以接 Codex app-server/SDK，但不能承诺复制 Codex App 的所有 remote handoff 行为。
2. 外部 runtime 输出不能直接变成 `los` 成功证据。必须经过 `verification_records` 或明确标为 `external_summary`。
3. Shell 和 Desktop automation 是高风险能力。DevSpace 的 allowlist 值得借鉴，但 `los` 仍需要 auth middleware、tool gate、audit event、operator approval 和 kill switch。
4. 全局 Codex/Claude 配置不能被 `los` 静默改写。任何 config patch 都应展示 diff、备份路径、回滚方式，并落 audit event。
5. Handoff summary 需要可读、可审计、可裁剪。不要把 raw transcript、auth token、完整 stdout/stderr 放进版本控制或长期表。

## 下一步决策

建议先立一个 ADR：`Codex App Server Runtime Adapter and Portable Run Handoff`。

ADR 应回答：

1. `los` 是否把 Codex app-server 设为 Codex runtime 的默认控制面。
2. `runtime_runs`、`runtime_handoffs`、`workspace_sessions` 三张表的 ownership。
3. `external_thread_id` 与 `los session_id/run_spec_id` 的映射规则。
4. Web/IM 对 steer/cancel/handoff 的权限模型。
5. 哪些 OpenCodex/DevSpace 能力进入核心，哪些只允许作为 optional integration。

## Sources

- OpenAI Codex manual, Remote connections / Hand off a thread between hosts, fetched 2026-06-20 through `openai-docs` helper.
- OpenAI Codex manual, Codex App Server and SDK sections, fetched 2026-06-20 through `openai-docs` helper.
- GitHub API: `https://api.github.com/repos/AITabby/opencodex`, checked 2026-06-20.
- GitHub API: `https://api.github.com/repos/AITabby/opencodex/commits?since=2026-05-20T00:00:00Z`, checked 2026-06-20.
- GitHub README/code: `https://github.com/AITabby/opencodex`, checked 2026-06-20.
- GitHub API: `https://api.github.com/repos/Waishnav/devspace`, checked 2026-06-20.
- GitHub API: `https://api.github.com/repos/Waishnav/devspace/commits?since=2026-05-20T00:00:00Z`, checked 2026-06-20.
- GitHub README/docs/code: `https://github.com/Waishnav/devspace`, checked 2026-06-20.
- Local `los` source: `packages/gateway/src/routes/orchestration/runtime-adapter-routes.ts`, `packages/agent/src/runtime-adapter/codex.ts`, `packages/agent/src/runtime-adapter/claude-code.ts`, `packages/agent/src/runtime-evidence-graph.ts`, `packages/agent/src/external-tool-summary.ts`, checked 2026-06-20.
