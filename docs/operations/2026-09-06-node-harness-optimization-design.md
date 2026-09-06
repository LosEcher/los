# LOS 节点安装、入网与观测的 Harness 化设计

日期：2026-09-06
状态：Proposed，分阶段实施

## 1. 目标

将节点安装、注册、探针、观测和调度资格拆成可配置、可组合、可验证的模块。目标不是复制 1Panel 或 AcePanel 的面板功能，而是提取它们在安装器、系统探针、服务管理和时间序列采集上的可复用结构，服务于 LOS executor node 的快速入网。

验收结果必须能由仓库、数据库、HTTP 响应和进程状态重建；agent 自报或 UI 状态不能单独作为完成证据。

## 2. 已验证事实

### 2.1 外部项目

- 1Panel 的 `quick_start.sh` 获取版本和 checksums，`install.sh` 按架构解包二进制、写入 `1pctl`、注册 systemd/OpenRC/SysV 并轮询服务状态。
- 1Panel agent API 使用时间戳签名、API key 和 IP 白名单；core 根据 `CurrentNode`/`operateNode` 将请求代理到 agent。OSS 仓库 README 将多节点列为 Pro/Ent 能力，不能把商业版完整节点注册实现当作可移植事实。
- AcePanel helper 将安装拆为系统检查、用户、依赖、swap、下载校验、防火墙、systemd、初始化和应用探测；主仓是单机面板，没有常驻远程 agent heartbeat mesh。
- 两者的本机观测都以 gopsutil 为主，保存 CPU、内存、swap、磁盘、网络、进程等数据；网络和磁盘速率可以由累计计数器在查询时计算。

### 2.2 LOS 当前实现

- `packages/agent/src/executor-nodes.ts` 已有 `node_kind`、`connect_modes`、`connect_config`、`capabilities`、`verified`、`capacity`、心跳时间和 candidate 评估。
- `packages/gateway/src/routes/infrastructure/node-routes.ts` 已有节点列表、heartbeat、probe、SSH 导入和 operator 写操作。
- `packages/gateway/src/routes/node-probes.ts` 已将 HTTP、NDJSON、SSH、Tailscale、Tunnel、SOCKS5 探测分开，并将 system coverage 与连接结果分离。
- `packages/executor/src/index.ts` 已有 node id、10 秒心跳、失败指数退避和 `/health`。
- `contracts/node-registry.yaml` 已规定“注册、在线、健康、验证、执行 candidate”必须分层；`docs/operations/node-deployment-runbook.md` 已规定远程部署与外部验证顺序。

## 3. 设计判断

节点生命周期固定为：

```text
artifact verified
  -> service installed
  -> enrollment accepted
  -> heartbeat fresh
  -> connectivity probed
  -> capability verified
  -> executor candidate
```

以下状态不得互相替代：

```text
registered != online
online != healthy
healthy != verified
verified != executor candidate
```

### 3.1 真相源

| 信息 | 权威面 | 其他面 |
| --- | --- | --- |
| 安装版本和制品 | release manifest、文件 checksum/signature | 日志、UI |
| 节点身份 | enrollment 记录、`executor_nodes.node_id` | hostname、agent 自报 |
| 连接健康 | `node_probe_events`、`verified` | TCP 成功、UI 绿点 |
| 调度资格 | `evaluateExecutorNode()` 结果 | `status=online` |
| 资源观测 | 带时间戳的原始样本 | 当前内存快照 |
| 任务所有权 | task/run lease 与 session event | 进程 stdout |

## 4. 模块边界

### 4.1 `node-install`（新增）

职责：读取版本 manifest，验证制品，安装运行时，生成 systemd unit，执行 health check；不直接写 `executor_nodes`。

配置入口：`LOS_NODE_INSTALL_*` 环境变量和版本化 manifest。
输出：结构化安装事件和本机配置文件，凭据值不进入日志。

### 4.2 `node-enrollment`（新增）

职责：一次性 token 兑换为 node id 与节点独立凭据；绑定制品版本、能力声明和 gateway；支持过期、撤销、轮换。

边界：enrollment 不是 heartbeat；heartbeat 不能创建未批准的节点身份。

### 4.3 `node-heartbeat`

职责：定期上报状态、容量、队列和已声明能力；失败采用有上限的指数退避；不得覆盖 probe 产生的 `verified`。

### 4.4 `node-probe`

职责：对每个 `connect_mode` 执行具体探测，写入 `verified` 和 append-only transition event；探测器只读、超时、有明确 coverage。

### 4.5 `node-observation`

职责：采集主机原始计数器和 Top 进程；控制面按样本时间计算速率和压力趋势；支持采集间隔、保留期和采样 profile 配置。

### 4.6 `node-policy`

职责：将运行意图编译为 capability requirements，结合资源压力、heartbeat freshness 和 probe 结果计算 candidate；不接受“连接成功即执行”的降级。

## 5. 配置化模型

```yaml
node:
  artifact:
    channel: stable
    version: 0.2.0+b1a2b3c4d5e6f
    sha256: <manifest value>
    signature: <detached signature>
  service:
    manager: systemd
    user: los
    restart_sec: 5
  heartbeat:
    interval_ms: 10000
    max_backoff_ms: 900000
  observation:
    profile: standard
    interval_sec: 30
    retention_days: 30
  capabilities:
    run_agent: true
    workspace_write: true
    sandbox: native
```

配置只能声明意图；能力是否真实可用由 probe 和执行 harness 产生的证据决定。

## 6. 分阶段实施与验收

### P0.1 入网安全边界

1. 增加 enrollment request/response contract。
2. 增加一次性 token、过期时间、消费状态和 node id 绑定。
3. heartbeat 对未 enrollment 节点 fail closed；保留 operator 显式 upsert 兼容路径。
4. focused tests 覆盖重复消费、过期 token、错误 token、heartbeat 未入网和成功兑换。

验收：`pnpm --filter @los/gateway test` 的 enrollment harness 全绿；数据库中 token 消费和节点绑定可重读。

### P0.2 安装制品和服务注册

1. 定义 manifest schema、sha256/signature 校验和架构选择。
2. 将安装步骤写成可重试的 step runner。
3. 生成 systemd unit 并验证 listener、`/health.version` 和服务 owner。

验收：模拟 manifest/坏包/错误架构/服务启动失败；每种失败都有非零结果和结构化 phase。

### P1.1 观测 profile

1. 增加 `minimal`、`standard`、`diagnostic` profile。
2. 节点上报累计网络/磁盘计数器与采样时间。
3. 控制面计算速率、内存压力和磁盘空间趋势。

验收：固定样本 fixture 的速率计算、时间乱序、计数器回绕和缺失字段测试。

### P1.2 探针插件化

1. 将 mode probe 抽象为注册表，统一超时、错误、coverage 和证据格式。
2. 为 HTTP、SSH、Tailscale、Tunnel、SOCKS5 保留独立适配器。
3. 禁止未声明/未验证的 mode 影响 candidate。

验收：每个 mode 至少一个成功、失败、超时和缺配置用例。

### P2 生命周期运维

1. 凭据轮换和撤销。
2. drain、upgrade、rollback 状态机。
3. 节点离线重连与离线观测缓冲。

验收：故障注入后状态、事件、lease 和调度结果一致。

## 7. Harness 与机械门禁

- 每个 phase 先加载适用 `.los/spec/` 和 ADR 0010。
- 每个 meaningful edit 后运行最窄的 package test；跨包阶段再运行 `pnpm run gate`。
- 所有状态转换走既有状态机；不得直接写 task/run/tool 状态。
- probe 失败必须保留原始错误、超时和 endpoint，但不得泄露 token、私钥或原始凭据。
- 新增导出必须通过 wiring topology；新文件保持在 500 行以内。
- 安装和入网测试必须覆盖“自报成功但外部不可达”的反例。

## 8. 被否决的方案

1. **复用一个全局 API key**：实现简单，但节点不可独立撤销，泄露影响面过大。
2. **heartbeat 自动创建永久节点**：降低首次接入成本，但会把未认证自报写入调度面。
3. **只做 TCP/HTTP 探针**：只能证明路径可达，不能证明 shell、workspace、sandbox 或 lease 能力。
4. **节点端直接存派生速率**：减少控制面计算，但会丢失原始计数器，难以处理时间漂移和采样间隔变化。
5. **先做完整多节点 UI**：不能解决身份、证据和调度资格的根因，推迟到 API 与 harness 稳定后。

## 9. 未决风险

- 当前远端 executor 默认可在缺少持久 `EXECUTOR_AGENT_KEY` 时生成临时 key；P0.1 需要明确临时身份是否允许进入 candidate。
- manifest 签名算法、密钥分发和离线安装源尚未定稿。
- 现有 `executor_nodes` 表没有 enrollment token 表；需要新增迁移并同步所有测试数据库初始化路径。
