# ADR 0008: Single-Node Mesh-Ready Execution Order

## Status

Proposed.

## Observation

`los` 当前已经能在单进程 gateway 内运行 agent task，并且使用 PostgreSQL 作为单节点和未来 mesh/cloud 的共同持久化层。

已存在的事实：

1. `packages/gateway/src/server.ts` 启动时加载 config、连接 PostgreSQL、初始化 todo/idempotency store。
2. `packages/agent/src/scheduler.ts` 已有单进程 task lifecycle、dedupe、cancel 和 timeout。
3. `packages/agent/src/loop.ts` 已有 provider API agent loop、tool execution 和 session event 写入。
4. `packages/infra/src/config.ts` 有 `executor.enabled` 和 `executor.meshNodes`，但默认关闭。
5. `packages/executor/README.md` 仍是从 vpsagentweb 复制 Go executor 的集成说明。
6. ADR 0005 已指出 executor node 还停留在配置、README 和 reserved UI 阶段，缺少 node registry、heartbeat、lease 和弱网恢复。

## Inference

如果先做完整 mesh，会在核心 agent execution contract 稳定之前引入节点调度、远程连接、弱网恢复和 sandbox 分发问题。

如果只做本地 agent，又不提前保留 node、lease、trace 和 task ownership 语义，后续接 mesh 时会重写 task/session/todo 数据模型。

## Judgment

先推进基础 agent 执行链路，但按 mesh-ready 的单节点形态做。

单节点不是 local-only mode。单节点应该被视为 `nodeId = local` 的一个 mesh 节点，只是调度范围限制为本机。

## Execution Order

### Stage 0: Runtime Contract

目标：先让 agent loop 的模型调用和工具执行有可验证合同。

1. provider/model profile。
2. model event projection。
3. provider compatibility harness。
4. CLI fallback gate。

### Stage 1: Dispatch Contract

目标：让 todo 能变成 task_run，而不是只做人工计划项。

1. `POST /todos/:id/dispatch`。
2. dispatch dependency check。
3. tenant/project/request/trace propagation。
4. task/session/todo evidence links。

### Stage 2: Single-Node Mesh Substrate

目标：仍然只跑一个节点，但开始使用 mesh 语义。

1. `executor_nodes` registry。
2. local node heartbeat。
3. task owner node。
4. task lease and orphan recovery。
5. scheduler recovery read model。

### Stage 3: Remote Executor

目标：在 Stage 0-2 的合同稳定后，再接远程执行。

1. copy or port vpsagentweb Go executor。
2. WebSocket heartbeat and reconnect。
3. remote shell/sandbox execution。
4. node capacity and queue depth。
5. weak-network replay and backoff.

## Dependency Rule

1. 不在 Stage 0 完成前推进远程 executor。
2. 不在 Stage 1 完成前让 mesh node 直接创建 task_run。
3. 不在 Stage 2 完成前做多节点调度。
4. 所有阶段都必须写入 `task_runs` 和 `session_events`，不能只依赖 terminal log。

## Current Next Step

当前从 Stage 0 开始：先实现 provider/model profile，并把 DeepSeek、PackyCode/OpenAI-compatible、Anthropic-like provider 的差异从 provider factory 中抽出来。
