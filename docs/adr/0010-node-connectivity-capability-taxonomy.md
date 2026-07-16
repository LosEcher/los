# ADR 0010: Node Connectivity And Capability Taxonomy

## Status

Proposed.

## Observation

`los` 现在已经有一条最小的节点链路：

1. `packages/executor/src/index.ts` 会向 gateway 写入 node heartbeat。
2. `packages/agent/src/task-runs.ts` 已经有 `node_id`、`heartbeat_at`、`lease_expires_at`。
3. `packages/gateway/src/server.ts` 暴露了 `GET /nodes`。

但当前节点表只表达了“有一个节点在线”，还不能表达下面这些差异：

1. 普通设备上的执行节点。
2. Tailscale 节点。
3. Cloudflare Tunnel 节点。
4. 纯 SOCKS5 节点。

`vpsagentweb` 的实现给出的信号更清楚：`connect_mode`、`connect_priority`、`connect_config` 和 `capabilities` 是分开的，resolver 只负责候选解析，probe 负责验证，SOCKS5 只是 mesh health 的一类检查目标，不等于执行能力。

## Inference

如果把“连接方式”“可执行能力”“验证结果”混成一个字段，后面会出现三种混淆：

1. 能连上，不代表能执行。
2. 能代理，不代表能进工作区。
3. 能 SSH，不代表适合承担任务 lease。

这会直接影响 scheduler、node UI、probe 结果和远端 executor 设计。

## Judgment

`los` 的节点模型应该先变成一个只读的、分层的 registry，而不是一个笼统的在线列表。

更具体地说，节点至少要分出四个面：

1. `node_kind`：节点本体是什么。
2. `connect_modes` / `connect_config`：它可以用什么方式连。
3. `capabilities`：它能做什么。
4. `verified`：哪些能力是已经 probe 过的，不是自报的。

## Design

### 1. Node kinds

建议的 `node_kind`：

1. `executor`
   - 普通设备上的 `los-node`。
   - 可以跑 agent loop、工具调用、任务 lease。

2. `ssh_target`
   - 通过 SSH 访问的机器。
   - 可能是 Tailscale SSH，也可能是直连 SSH。
   - 是否可执行，要看 probe 结果和可用权限。

3. `ingress`
   - 主要提供入口回调。
   - Cloudflare Tunnel 通常更接近这个角色。

4. `proxy`
   - 主要提供网络出口或转发能力。
   - 纯 SOCKS5 节点属于这个类。

### 2. Connectivity modes

建议按 mode 单独记：

1. `agent_http`
2. `agent_http_ndjson`
3. `http_health`
4. `direct_ssh`
5. `tailscale_ssh`
6. `tailscale_native_ssh`
7. `cf_tunnel_http`
8. `cf_tunnel_ssh`
9. `socks5`

原则：

1. mode 是连接路径，不是能力结论。
2. 一个 node 可以有多个 mode。
3. 默认优先级由 `connect_priority` 决定，而不是按字符串排序。
4. `http_health` 只证明某个健康检查 URL 可达，不等价于 `agent_http`，不能单独让节点进入 executor candidate。

### 3. Capability surface

`capabilities` 只记录事实，不记录推断：

1. `shell`：是否能跑 shell。
2. `workspace_read`：是否能读工作区。
3. `workspace_write`：是否能写工作区。
4. `sandbox`：是否能进隔离执行环境。
5. `proxy_egress`：是否能做网络出站代理。
6. `ingress_callback`：是否能接回调入口。
7. `model_route`：是否承担模型请求路径。
8. `queue_depth` / `active_task_count`：是否有执行压力。
9. `deploy_safe`：节点是否可以安全执行 pnpm install/build（constrained executor 默认为 false）。
10. `heavy_task_safe`：节点是否可以接构建、长任务、批量文件任务调度。

### 4. Verification surface

`verified` 只记录 probe 后的结果：

1. `verified.*.ok`
2. `verified.*.checked_at`
3. `verified.*.error`
4. `verified.*.endpoint`

这部分不能由普通 heartbeat 直接覆盖。

### 5. Resource class

Node kinds alone don't express whether a node can safely accept heavy work. An Oracle ARM 1GB machine and a 34 NAS with 32GB are both `executor`, but their operational envelope is different.

`resource_class` describes the available resource headroom for scheduling decisions, separate from `node_kind`:

1. `control`
   - Gateway, PostgreSQL, Web UI — the scheduling center.
   - Not a task execution target.

2. `standard_executor`
   - Sufficient RAM, swap, disk for pnpm install, build, and normal task execution.
   - Default target for scheduled tasks.

3. `constrained_executor`
   - Low RAM (<2GB), no or minimal swap, limited disk.
   - May be online and healthy, but should only accept lightweight tasks.
   - Default `deploy_safe: false` — should receive pre-built artifacts.
   - Default `heavy_task_safe: false` — excluded from build, long-task, and batch-file-task scheduling.

Resource fields carried in `capacity` or heartbeat payload:

- `memory_total_mb` / `memory_available_mb`
- `swap_total_mb` / `swap_used_mb`
- `disk_free_gb`
- `psi_memory_some` / `psi_memory_full`
- `psi_io_some` / `psi_io_full`
- `resource_class`: one of `control`, `standard_executor`, `constrained_executor`

### 6. Classification rules

1. 普通设备
   - `node_kind=executor`
   - `connect_modes` 至少有 `agent_http`
   - `capabilities` 可以包含 shell / workspace / sandbox

2. Tailscale 节点
   - `node_kind=ssh_target` 或 `executor`
   - `connect_modes` 可包含 `tailscale_ssh` / `tailscale_native_ssh`
   - 只有 live probe 通过后，才把它当作可用执行节点

3. Cloudflare Tunnel 节点
   - `node_kind=ingress` 或 `ssh_target`
   - tunnel 证明的是入口可达，不等于有执行能力

4. 纯 SOCKS5 节点
   - `node_kind=proxy`
   - `connect_modes` 至少有 `socks5`
   - 只算网络能力，不直接算执行能力

### 7. Runtime build identity

Node `version` must identify the deployed code snapshot, not only the package
release line. Deployments use SemVer build metadata such as
`0.1.0+b1a2b3c4d5e6f`; `target_version` uses the same format during a rollout.

The gateway and local executor derive their version from a deterministic digest
of deployable runtime content when started through `tools/los.sh`. Documentation
and generated output are excluded, so recording a rollout cannot change the
recorded runtime identity. Remote deployment stamps the same immutable build
identifier into the preserved node `.env`. A successful rollout requires
`/health.version` and `executor_nodes.version` to agree.

Remote executor synchronization must include the executor's workspace runtime
dependency closure and every workspace manifest covered by `pnpm-lock.yaml`.
The deployment tool therefore ships `packages/` as a unit: updating only
`packages/executor` creates a false-success deployment through stale imports,
while omitting other manifests makes frozen-lockfile validation unreliable.

## Placement

这条设计应该先落在 `packages/agent/src/executor-nodes.ts` 和 `packages/gateway/src/server.ts` 的读模型里，再落到 `packages/web/src/pages.tsx` 的 Nodes 页面。

不建议先做多节点 claim。

### Capability-driven placement P0 (2026-07-11)

Scheduler placement uses a compiled requirement vector rather than scattered
task flags:

1. Run intent (`toolMode`, `sandboxMode`, build/deploy hints, explicit executor
   requirements) compiles to `requiredCapabilities`.
2. A registry candidate must satisfy every requirement. Missing capabilities
   are recorded in `scheduler_decisions.skipped_json`; the scheduler does not
   silently downgrade isolation or network policy.
3. `sandbox=tool_policy` and `sandbox=native` do not satisfy the `sandbox`
   requirement because they are policy/path boundaries, not OS isolation.
4. Existing `requiresBuild` and `requiresDeploy` inputs remain compatibility
   aliases for `heavy_task_safe` and `deploy_safe`.

Placement cost is evidence, not a new lifecycle state. Executor selection
records `placementTier` in the existing scheduler decision metadata:

- `warm`: a verified registry candidate is immediately reusable.
- `degraded`: an explicitly configured URL bypasses registry capability and
  pressure evidence.
- `clone` and `cold`: reserved for later workspace-template provisioning; P0
  must not report these tiers without implementing and measuring those paths.

Resource pressure closes the loop at selection time:

1. Critical memory pressure makes a node ineligible for all new work.
2. Warning-level memory pressure keeps lightweight work possible but sorts the
   node after healthy candidates.
3. Heavy work rejects warning-level pressure even when the node's static
   `heavy_task_safe` capability is true.
4. Thresholds are deterministic scheduler policy and require focused tests;
   later runtime configuration must move them into the Zod config authority.
5. On macOS, `memory_available_mb` comes from the system `memory_pressure`
   available percentage. Node `os.freemem()` reports only completely unused
   pages there and must not drive placement because it excludes reclaimable
   cache and compressed-memory headroom. If that system metric is unavailable,
   omit `memory_available_mb` instead of publishing a false critical value.

## Migration Order

1. 先扩 node registry schema。
2. 再让 executor heartbeat 写入可区分的连接/能力信息。
3. 再把 Nodes 页从 reserved surface 改成 read-only live surface。
4. 最后才接 probe/claim/scheduler routing。

## Verification

后续要验证的不是“节点能否显示在线”，而是：

1. `GET /nodes` 能否看出 node kind / connect mode / capability 的差异。
2. Tailscale / CF Tunnel / SOCKS5 是否被正确归类。
3. probe 写入是否和 heartbeat 写入分离。
4. scheduler 是否仍然只把 `executor` 类节点当作执行候选。
