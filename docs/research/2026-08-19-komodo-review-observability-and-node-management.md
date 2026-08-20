# Komodo 对 los 观测与节点管理的借鉴意义评估

> 日期：2026-08-19
> 调研对象：[moghtech/komodo](https://github.com/moghtech/komodo)（12k stars，GPL-3.0，Rust）
> 范围：观测（monitoring/alerting）与节点管理（periphery/server onboarding）两个面
> 依据：GitHub README / DeepWiki（monitoring、alert、status monitoring）/ komo.do 文档 / setup-periphery.py / roadmap，以及 los 现有 ADR 0002/0004/0009/0010、`docs/operations/metrics.md`、`otel-bridge.md`、`2026-08-10-executor-fleet-status-and-monitoring-plan.md`、`node-deployment-runbook.md`、`todo-seeds-observability-20260816.ts`

## 1. 结论先行

Komodo 与 los 是**同一架构族**：控制面（core）+ 节点 agent（periphery）+ 心跳/轮询 + 阈值告警 + 告警通知。但两者观测对象不同——Komodo 观测的是**基础设施**（CPU/内存/磁盘/Docker 容器/镜像更新），los 观测的是 **agent 执行**（事件账本/token 用量/模型路由/任务状态）。

- **los 已领先的方向**（无需借鉴）：事件溯源式 `session_events` 账本（ADR 0002）、双租约 fencing（ADR 0027）、execution outbox（ADR 0028）、节点 capability/verified 分层 registry（ADR 0010）、fleet auto-repair 带 quorum guard 与审计（2026-08-10 plan）、runtime build identity 版本一致性校验（ADR 0010 §7）。
- **Komodo 值得借鉴的细节**（把基础设施监控做「完备」的工程细节，los 尚未全部覆盖）：告警滞回（hysteresis）、维护窗口（maintenance windows）、Alerter 路由抽象（类型白名单+资源黑白名单+secret 插值）、按需进程快照、节点资源历史统计持久化 + prune、幂等 onboarding 安装脚本。
- **不适用/不建议引入**：Docker/Swarm/镜像更新跟踪、MongoDB+内存缓存状态机作为 truth、细粒度 RBAC、Tauri 桌面壳、三-tier 统一 POST API 重构。

具体可借鉴项与落地建议见 §5，行动清单见 §6。

## 2. Komodo 快照

- 定位：跨任意数量服务器构建/部署软件的运维控制台（Docker 优先，v2.0 起支持 Swarm）。
- 架构：Rust `core`（控制面，MongoDB，axum）+ Rust `periphery`（单二进制节点 agent，systemd 托管）。另有 Tauri 桌面 app + Web UI（Mantine）。
- 资源模型：Server、Deployment、Stack、Build、Repo、Procedure、Action、Alert、Alerter、Variable、User、Schedule、Webhook。
- 连接模式：periphery 出站连 core（`--core-address`，穿 NAT）或 core 入站连 periphery（`--core-public-keys` 公钥白名单）；`--onboarding-key` 一键自动注册 Server。
- 自动化：Procedure（步骤序列）、Action（TS snippet 调 API）、Schedules（CRON）、Webhooks（git push 触发，服务端 branch filtering）。
- 参考：https://github.com/moghtech/komodo 、[DeepWiki 8.1 Status Monitoring](https://deepwiki.com/moghtech/komodo/8.1-status-monitoring) 、[DeepWiki 8.2 Alert System](https://deepwiki.com/moghtech/komodo/8.2-alert-system) 、[setup-periphery.py 文档](https://github.com/moghtech/komodo/blob/main/scripts/readme.md)

## 3. Komodo 观测架构拆解

### 3.1 监控循环与缓存

- Core 启动 `spawn_server_monitoring_loop`，按 `monitoring_interval` 每轮 `join_all` **并行**轮询全部 server 的 periphery（`PollStatus`，可分别开关 `stats_monitoring` / `include_docker`）。
- 每 server 缓存更新有并发控制器：同一 server 两次刷新间隔 ≥1s（手动触发同样受限）。
- 状态缓存全部在内存：`ServerStatusCache` / `DeploymentStatusCache` / `StackStatusCache` / `RepoStatusCache` / `SwarmStatusCache`。其中 Deployment/Stack 用 `History<Curr, Prev>` 包装——**显式保存上一轮状态以做转换检测**。
- server `enabled=false` 时，其关联资源状态批量标记 `Unknown`。

### 3.2 告警

- **阈值健康**：CPU/内存/磁盘对照 warning/critical 两级阈值；磁盘按挂载点逐个评估；`ALERT_PERCENTAGE_THRESHOLD = 5.0%` **滞回**防止边界抖动（超过 warning 后需回落 5% 才解除，反之亦然）。
- **状态转换**：deployment/stack 仅当 ①有 prev 状态 ②当前与 prev 均非 Unknown（避免 server 宕机时连环误报）③不在 deploy 动作进行中 ④curr≠prev 时才告警。
- **AlertBuffer 两连击**：同一 (server, variant) 需连续两次检查失败才开 alert，一次通过即 reset——过滤瞬时网络抖动/偶发 spike。
- **维护窗口**：server 可配 `maintenance_windows`，窗口内抑制 unreachable/健康类告警；Alerter 自身也可配维护窗口，在派发层二次校验。
- **生命周期**：open → update → resolve（resolved 标志持久化），`Alert` 实体含 level（Warning/Critical）、target、data。
- **派发**：`Alerter` 资源（Discord/Slack/custom webhook）按 enabled + `alert_types` 白名单 + `resources`/`except_resources` 黑白名单过滤；custom alerter 对 URL 做变量/secret 插值后 POST JSON。

### 3.3 统计历史与 prune

- 每轮把最新 SystemStats 落库为 `SystemStatsRecord`（CPU%、load、mem、总磁盘、网络吞吐）。
- 每日 `spawn_prune_loop` 按 `keep_stats_for_days` / `keep_alerts_for_days` 清理——**保留策略显式可配**。
- periphery 侧自身按 `stats_polling_rate` 缓存统计（CPU/load/mem/网络吞吐/磁盘 + **按 CPU 排序的进程列表**），使 Core 轮询近实时返回。

## 4. los 现状对照

### 4.1 观测面（los 现状）

| 能力 | los 现状 | 出处 |
| --- | --- | --- |
| 事件账本 | `session_events` append-only + 投影；10 域 ~90 事件类型 catalog | ADR 0002；todo `obs-event-enum` |
| Prometheus 指标 | `GET /metrics`：task_runs/provider_calls/cache tokens/model cost，DB 聚合跨重启有效 | `docs/operations/metrics.md` |
| 用量立方 | `GET /usage/summary`（L1：model tokens/cost + provider fill/latency） | `2026-08-09-usage-hub-design.md` |
| 外部运行时遥测 | OTel bridge（127.0.0.1:4318）将 Claude Code/Codex spans 映射进 session_events | `otel-bridge.md` |
| 回放/检索 | SessionInspector（12s 轮询，待流式化）、`/sessions/search` FTS API（无页面） | todo `obs-replay-streaming`/`obs-audit-search` |
| trace | `trace_id` 三表打通但无 span 父子链、无聚合 API | todo `obs-trace-tree` |
| 差距清单 | 事件枚举化、trace 树、回放流式化、脱敏瀑布（P0）；隐私三模式、趋势图、metrics 扩充、model.delta、审计检索页（P1） | `todo-seeds-observability-20260816.ts` |

### 4.2 节点管理面（los 现状）

| 能力 | los 现状 | 出处 |
| --- | --- | --- |
| 节点模型 | 分层 registry：node_kind / connect_modes / capabilities / verified / resource_class；probe 与 heartbeat 分离 | ADR 0010 |
| 存活 | heartbeat + stale reaper + 限速 auto-probe（2/tick·2s gap·5m cooldown·120s interval） | 2026-08-10 plan §2.1 |
| 聚合看板 | `GET /ops/runtime-health`（fleet 块 + warnings：offline/online_unverified/resource:*） | 2026-08-10 plan §4.1 |
| 资源阈值 | mem<15%/5%、swap>50%/80%、load>2/4、heartbeat age>45s/90s（warning/critical） | 2026-08-10 plan §4.3 P1 |
| 告警纪律 | ≥2 连续 unhealthy 观察才发 `ops.fleet_attention`；10m 同态去重；30m/node cooldown；MBP sleep catch-up 不推进状态 | 2026-08-10 plan §4.3 P0 / §9 |
| 主机级检查 | `fleet_host_check`（SSH 至各节点查 unit/health/swap，≥15m/host）+ 可选 auto-repair（quorum guard、逐节点 `node_recovery_policy`、`ops.fleet_host_repair` 审计事件） | 2026-08-10 plan §4.3 P2/P2.5 |
| 执行可靠性 | 双租约 fencing（lease_version）、outbox at-least-once 跨网关通知 | ADR 0027/0028 |
| 部署/升级 | `deploy-to-remote.sh`（preflight→sync→install→verify）+ runtime build identity（SemVer+build digest）一致性校验 | `node-deployment-runbook.md`、ADR 0010 §7 |
| 通道 | SSE + 微信（近期切飞书）；daily digest 舰队/Provider 段 | 2026-08-10 plan §4.3 P3 |

## 5. 借鉴意义逐项评估

### 5.1 值得借鉴（los 缺失或偏弱）

| # | Komodo 机制 | los 差距 | 借鉴价值 | 落地建议 |
| --- | --- | --- | --- | --- |
| K1 | **告警滞回（5% hysteresis）** | `fleet-resources` 阈值无滞回，mem/swap 在边界附近会反复 warning↔ok 抖动（与 10m 去重机制正交，仍会制造噪音事件） | 高，小工程 | 在 `packages/agent/src/fleet-resources.ts` 阈值评估加 hysteresis 带宽（如 warning 边界 ±3%），机械测试覆盖边界往返 |
| K2 | **维护窗口（maintenance windows）** | 无显式维护窗口；节点升级/重启/部署窗口必然触发 fleet_attention/资源告警噪音（升级 runbook 要求 activeTaskCount=0 前停机，但没有告警抑制） | 高，小工程 | node 级 `maintenance_windows`（env/DB 配置，与 `node_recovery_policy` 表同层），窗口内抑制 fleet 告警与 host-check 失败告警；`fleet_host_check` 的自愈也应在窗口内跳过 |
| K3 | **Alerter 路由抽象（类型白名单 + 资源黑白名单 + secret 插值）** | 告警通道写死（SSE+单渠道）；告警类型→通道无路由配置；无法按资源静音 | 中 | 轻量版：告警类型→通道 map（DB 或 config 权威），默认全量→飞书+web；支持 per-node 静音（与 K2 合并为 node 级 alert policy） |
| K4 | **按需进程快照（periphery get_processes：按 CPU 排序 top-N）** | node34 swap 事故靠人工 SSH `VmSwap` 排查（2026-08-10 §8）；heartbeat 只带 mem/cpu/load/psi，无进程级证据 | 中 | probe 响应扩展可选 top-N 进程（CPU/RSS），沿用 auto-probe 限速（不新增高频轮询）；把「进程快照」作为 `verified` probe 能力之一 |
| K5 | **节点资源历史持久化 + prune 保留策略** | heartbeat capacity 无时间序列落库；阈值「tune after a week of data」缺数据支撑；fleet 趋势不可回看 | 中 | fleet 资源指标按小时/日聚合落库（可并入现有 usage cube 或新表），配 `keep_for_days` 保留 + 定时 prune（Komodo `keep_stats_for_days` 模式）；趋势图并入 todo `obs-charts` |
| K6 | **幂等 onboarding 安装脚本**（setup-periphery.py：可重跑、自动升级、aarch64 检测、system/user 双模式） | `setup-node.sh`/`deploy-to-remote.sh` 是半手工预置（EXECUTOR_NODE_ID+token 先配好再装），无「一次性 onboarding key 自动注册」；Windows 无等价脚本 | 中 | 参考其幂等+版本感知设计：core 一次性签发 onboarding token→节点脚本自行注册 node id；统一 Windows（PowerShell）与 Linux 安装路径；`deploy-to-remote.sh` 补「重跑即检测版本差并升级」语义 |
| K7 | **server enabled 开关 → 关联资源 Unknown** | 无节点停用语义：registry 只有 online/offline（reaper 判定），无法表达「管理员主动停用」；停用节点仍可能被 scheduler 候选逻辑考虑 | 中 | registry 状态扩展 `disabled`（管理员位，独立于 reaper 的 offline），disabled 时 scheduler 跳过、告警抑制、host-check 跳过；与 ADR 0010 resource_class/`node_recovery_policy` 衔接 |
| K8 | **转换检测显式 prev 状态**（History<Curr,Prev>） | los 的节点状态转换靠 reaper 推断，无「prev→curr」语义的事件；`ops.fleet_attention` 已做 candidate lost/restored 转换推送，但未纳入事件类型注册表 | 低（已有等价） | 把节点状态转换（offline/candidate_lost/restored/disabled）补进 `todo obs-event-enum` 的注册表范围，获得可回放的状态机 |

### 5.2 已等价/已覆盖（Komodo 佐证方向正确，无需再投入）

| Komodo 机制 | los 等价物 |
| --- | --- |
| AlertBuffer 两连击防抖 | `≥2 consecutive unhealthy` + 10m 同态去重 + 30m cooldown（更强：带冷却与 catch-up 语义，2026-08-10 §4.3 P0/§9） |
| 状态转换告警避免 Unknown 连环误报 | auto-probe fail-closed + fleet offline 与 online_unverified 分级的告警语义 |
| 并行轮询 + 每 server 最小刷新间隔 | auto-probe 限速（2/tick·2s gap）+ 明确「不主动高频探测」原则（§4.1 表） |
| 出站连接穿 NAT | 节点 heartbeat 主动上报 + CF tunnel 节点（ADR 0010 node_kind=ingress）；等价且更细 |
| 版本升级脚本重跑即更新 | runtime build identity + `/health.version`==registry version 一致性校验（**更严格**） |
| 告警 open/resolve 生命周期 | `ops.*` 事件 + fleet_watch_state 持久化（可回放，优于内存态） |

### 5.3 不适用 / 不建议引入

| Komodo 特性 | 原因 |
| --- | --- |
| Docker/Stack/Swarm 部署与镜像更新跟踪（DeploymentImageUpdateAvailable/auto-update） | los 部署物是 Node/TS 服务（systemd/nssm/launchd），非容器；版本一致性已由 build identity 覆盖 |
| MongoDB + 内存状态缓存作为 truth | 与 los 事件溯源（session_events 可回放/审计/重建）方向冲突；los 读模型应为事件投影，不引入内存态作为权威 |
| 细粒度 RBAC（v1.18） | los 无外部用户（单 operator token 模式），2026-08-19 交付流程约定已确认 |
| Tauri 桌面壳 / Mantine UI | los 是 web-first（ADR 0004），不需要第二客户端形态 |
| 三-tier 统一 POST + type tag API | los Fastify REST 已成型（read/write 分离已有），重构无收益 |
| GPL-3.0 代码复用 | 仅做模式参考（AGENTS.md：external codebases are pattern references only）；抄代码需评估许可传染性 |

## 6. 行动建议（按 los todo 编号习惯）

- **P0**
  - `todo-los-komodo-hysteresis`：fleet 资源阈值滞回（K1），机械测试覆盖边界往返。
  - `todo-los-komodo-maintenance-window`：node 级维护窗口（K2），窗口内抑制 fleet 告警/host-check 失败/自愈。
- **P1**
  - `todo-los-komodo-probe-processes`：probe 按需进程快照 top-N（K4），并入 auto-probe 限速节奏。
  - `todo-los-komodo-fleet-history`：fleet 资源小时/日聚合落库 + 保留策略/prune（K5），趋势图并入 `obs-charts`。
  - `todo-los-komodo-alert-routing`：告警类型→通道路由 + per-node 静音（K3）。
- **P2**
  - `todo-los-komodo-onboarding`：一次性 onboarding token + 幂等安装脚本（K6），统一 Windows/Linux 路径。
  - `todo-los-komodo-node-disabled`：registry `disabled` 语义（K7），与 scheduler/告警/host-check 联动。
- **顺带**：节点状态转换事件进 `obs-event-enum` 注册表（K8）；Komodo webhook branch-mismatch 降噪（把例行非失败信号与真实失败区分）可作为 los 治理事件分级的一个参照。

## 7. 参考来源

- https://github.com/moghtech/komodo
- https://deepwiki.com/moghtech/komodo/8.1-status-monitoring
- https://deepwiki.com/moghtech/komodo/8.2-alert-system
- https://deepwiki.com/moghtech/komodo/8-monitoring-and-alerting
- https://github.com/moghtech/komodo/blob/main/scripts/readme.md
- https://github.com/moghtech/komodo/blob/main/roadmap.md
