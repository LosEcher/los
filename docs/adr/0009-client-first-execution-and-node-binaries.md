# ADR 0009: Client-First Execution With Node Binaries

## Status

Proposed.

## Observation

当前 `los` 已经有可运行的 HTTP/SSE 入口、`runScheduledAgentTask()`、`runAgent()`、provider profile、`session_events` 和 `task_runs`。

但从“像一个客户端一样跑起来”的角度看，缺口还很明显：

1. 没有一等 CLI/bin 入口，当前主要靠 `pnpm dev` / `pnpm start` 驱动 gateway。
2. `packages/gateway/src/server.ts` 负责 `/chat` 和 `/sessions`，但它更像一个内嵌服务层，不是独立的客户端 shell。
3. `packages/executor/README.md` 仍停留在“从 vpsagentweb 复制 Go executor”的说明阶段，没有形成 los 自己的 node binary contract。
4. 现有 `runAgent()` 已能读写和跑工具，但还没有子代理、补丁式写入、会话续跑、远端节点 claim/heartbeat 这类更像 Claude/Codex 客户端的能力。

参考项目给出的边界也一致：

1. `opencode` 是明显的 CLI/bin 形态，bin 入口和 command tree 是一等概念。
2. `open-webui` 是服务端 API + Web 客户端的产品形态，说明 UI 和执行后端最好分开。
3. `claudecodemapsrc` 把 local task、remote task、shell task、task get/update、remote session 预条件拆开，说明“本地交互客户端”和“远端执行节点”不应该混成一个对象。

## Inference

如果目标是“先让本项目能视作一个客户端跑起来”，los 需要先把执行路径收敛成一个稳定的 client contract，而不是先把完整 mesh 或完整云端 executor 做出来。

更具体地说：

1. 客户端负责接收 prompt、展示运行过程、管理会话、提交任务描述。
2. 执行节点负责真正跑 agent loop、工具调用、文件读写、shell/sandbox。
3. gateway/registry 负责路由、事件投影、节点可见性、任务归属。

如果这三层不分开，后续把同一套能力部署到不同 node 时，会不断重写 prompt/session/task 的边界。

## Judgment

先把 `los` 做成“客户端优先”的执行平台，再把云端节点执行做成独立的 bin/daemon。

建议采用两条可并行但边界清晰的运行面：

1. `los` client bin
   - 负责 `chat/run/sessions/tasks/nodes` 这类用户交互命令。
   - 默认连接本地 gateway，也可以连接远端 gateway。
   - 只负责提交 run spec、订阅事件、展示结果，不直接承载云端执行逻辑。

2. `los-node` executor bin
   - 负责在不同 node 上注册、心跳、领取任务、执行工具、回传结果。
   - 可以先做成 Node/TS daemon，也可以后续换成 Go binary。
   - 对 gateway 暴露的是 claim/heartbeat/result 接口，而不是 UI 接口。

## Design

### 1. Client contract

客户端要先支持这几个稳定对象：

1. `RunSpec`
   - prompt
   - provider / model
   - workspaceRoot
   - toolMode / permissions
   - sessionId / traceId / parentSessionId
   - sandbox / approval policy

2. `RunStream`
   - session.started
   - model.response
   - tool.call
   - tool.result
   - task.started / task.succeeded / task.failed
   - session.completed

3. `Client resume`
   - 同一个 session 可以继续发新 prompt。
   - 事件和历史要能从 `session_events` / `sessions` 恢复。

### 2. Node contract

不同 node 上执行时，需要独立的 node contract：

1. `executor_nodes`
   - node id
   - host label
   - role
   - status
   - capacity
   - queue depth
   - last heartbeat

2. `task lease`
   - lease expires
   - heartbeat at
   - orphan recovery
   - retry / backoff

3. `task claim`
   - gateway 只派发可运行的 run spec
   - node 只领取自己能力范围内的任务
   - 结果必须回写 `task_runs` 和 `session_events`

### 3. Binary packaging

不同 node 的执行方式建议分两层：

1. 本地开发/调试
   - `pnpm dev` 启动 gateway。
   - `los chat ...` 作为客户端连接 gateway。

2. 远端节点
   - `los-node start --gateway ...` 作为执行守护进程。
   - 通过环境变量或配置文件注入 node id、token、workspace root、sandbox policy。

3. 云端部署
   - node binary 先可用 TS/Node 版，后续如果需要更强隔离再替换成 Go binary。
   - 客户端与 node 不共享 UI 代码，只共享 run/event contract。

## Gap List

当前最需要补的缺口，不是再加一个 UI 页面，而是这几项：

1. CLI/bin 入口缺失。
2. session resume / thread 继续能力缺失。
3. 子代理 / handoff 缺失。
4. patch / diff / apply-merge 类写入工具缺失。
5. node registry / heartbeat / lease / claim 缺失。
6. event replay / resume / observability 只能看日志，不能稳定重放。
7. provider profile 还没有真正驱动 DeepSeek / OpenAI-compatible 的行为分支。

## Suggested Order

1. 先做 client bin，让 `los` 作为客户端能跑、能看、能继续会话。
2. 再把 run spec 和 event stream 固化成 contract。
3. 然后拆出 node binary 和 node registry。
4. 最后补远端 claim / lease / sandbox / replay。

## Implementation Record

2026-05-30 started Stage 1:

1. Added `packages/cli` as the first client package.
2. Added local `bin/los` wrapper and root `pnpm run cli -- ...` entry.
3. Added `los chat`, `los sessions`, `los tasks`, and `los health`.
4. Extended `/chat` so a provided `sessionId` can resume prior session messages.
5. Exposed agent `session_events` through the live SSE stream so CLI/web clients can observe model and tool progress while a run is active.

2026-05-30 started Stage 2:

1. Split deterministic edit support into `preview_patch`, `apply_patch`, and `edit_file`.
2. Moved workspace path validation into `safeWorkspacePath()` so file tools share one boundary check.
3. Added a constrained `spawn_agent` tool that re-enters `runAgent()` but only exposes read-only or project-write child tool sets, with shell and recursive spawn kept out of the child registry.
4. Included `sessionId` on streamed session events so nested child runs can still be distinguished in the live stream.

2026-05-30 started Stage 3:

1. Added explicit `model` override flow through CLI, gateway, scheduler, provider creation, and task-run persistence.
2. Added runtime model profile summaries to `session.started` / `model.response` event payloads so DeepSeek/OpenAI/Anthropic capability differences are visible while a run is active.
3. Persisted `task_runs.model` so task lists and lifecycle records can show the effective model instead of only the provider.

2026-05-30 started Stage 4:

1. Added `packages/agent/src/compat-harness.ts` with provider/model targets, reusable probes, run-spec generation, and SSE summary projection.
2. Added `los compat` as a client command. It dry-runs by default and only calls `/chat` when `--execute` is provided.
3. Added built-in probes for read-only workspace inspection and non-writing patch preview, so DeepSeek/GPT/PackyCode-style routes can be compared on the same tool surface.

## Verification

后续应验证：

1. `los chat` 可以对接本地 gateway。
2. 同一个 session 可以继续追加 prompt。
3. 事件流能展示模型响应、工具调用、工具结果和结束状态。
4. `los-node` 可以在另一台机器上注册并领取任务。
5. gateway 能把结果回写到 `task_runs` / `session_events`。
