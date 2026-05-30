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

### 4. Verification surface

`verified` 只记录 probe 后的结果：

1. `verified.*.ok`
2. `verified.*.checked_at`
3. `verified.*.error`
4. `verified.*.endpoint`

这部分不能由普通 heartbeat 直接覆盖。

### 5. Classification rules

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

## Placement

这条设计应该先落在 `packages/agent/src/executor-nodes.ts` 和 `packages/gateway/src/server.ts` 的读模型里，再落到 `packages/web/src/pages.tsx` 的 Nodes 页面。

不建议先做多节点 claim。

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
