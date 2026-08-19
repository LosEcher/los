# Komodo 借鉴落地设计：P0 告警滞回 + 节点维护窗口（含后续路线与 K6 合并）

> 日期：2026-08-19
> 上游调研：[2026-08-19-komodo-review-observability-and-node-management.md](../research/2026-08-19-komodo-review-observability-and-node-management.md)
> 借鉴来源：[moghtech/komodo](https://github.com/moghtech/komodo)（Monitoring/Alert System：`ALERT_PERCENTAGE_THRESHOLD` 5% 滞回、`maintenance_windows` 静默）
> 本设计范围：P0 两项（todo-los-komodo-hysteresis / todo-los-komodo-maintenance-window）+ 后续待办路线 + K6（幂等 onboarding）与 Windows 服务化合并方案。

## 1. 目标与原则

1. **告警纪律优先于告警数量**：los 的 fleet 阈值（mem/swap/load）在边界附近的 tick 抖动会制造噪音事件；维护窗口解决"计划内停机必然告警"的误报。两者都是"让告警只在真正需要人看的时候出现"。
2. **纯函数可测**：滞回判定与窗口判定是纯函数，机械验收覆盖边界往返；DB 状态读写与评估分离。
3. **最小接入面**：不改 fleet-resources / fleet-inventory 的既有语义，只加可选参数与抑制过滤，默认行为不变（无配置 = 现状）。
4. **持久化证据**：滞回严重度状态落 DB（`fleet_resource_state`），窗口配置落 DB（`node_maintenance_policy`），与 `fleet_watch_state` / `node_recovery_policy` 同层；每次配置变更写 `ops.config_changed` 审计。
5. **不引入 Komodo 的缓存状态机**：los 的 truth 仍是事件 + DB 投影，这里只是评估状态，不是权威。

## 2. P0-1 告警滞回（hysteresis）

### 2.1 语义

对**比例型**资源信号（`memory_available` 低于阈值告警；`swap_used` / `cpu_load` 高于阈值告警）：

- 进入告警按原始阈值（与现状一致）。
- **解除/降级需要越过滞回带**（`FLEET_RESOURCE_HYSTERESIS_BAND = 0.03`，即 3 个百分点）：
  - 低于阈值类：从 `critical` 恢复需要 `ratio ≥ CRIT + BAND`；从 `warning` 恢复需要 `ratio ≥ WARN + BAND`。
  - 高于阈值类：从 `critical` 恢复需要 `ratio ≤ CRIT − BAND`；从 `warning` 恢复需要 `ratio ≤ WARN − BAND`。
- 布尔型（`active_tasks_light_node`）与派生型（`heartbeat_age`、`capacity_missing`）**不做滞回**（heartbeat 已有 reaper + 转换语义，量级与比例信号不同）。

### 2.2 判定伪代码（以 memory_available 为例）

```
ratio < CRIT                          → critical
else ratio < CRIT + BAND && prev=critical → critical   # 滞回保持
else ratio < WARN                      → warning
else ratio < WARN + BAND && prev=warning → warning      # 滞回保持
else                                   → ok
```

swap_used / cpu_load 为对称的「高于阈值」版本（`> CRIT − BAND` / `> WARN − BAND`）。

### 2.3 状态与接入

| 层 | 变更 |
| --- | --- |
| `fleet-resources.ts` | 新增 `FLEET_RESOURCE_HYSTERESIS_BAND`；`evaluateFleetNodeResources(nodeId, node, nowMs?, prevSeverities?)` 增加可选第 4 参；`evaluateNamedFleetResources(..., prevByNode?)` 透传。默认不传 = 现状行为。 |
| 新 `fleet-resource-state.ts` | 表 `fleet_resource_state (node_id PK, severities JSONB, updated_at)`；`loadFleetResourceSeverities()` / `saveFleetResourceSeverities(nodeId, sev)`；纯函数 `extractSeveritiesFromFindings(findings)`；`_resetFleetResourceStateStoreForTests()`。 |
| `runtime-health.ts` | `getRuntimeHealth()` 内：读 prev → 评估（带滞回）→ upsert 写回（fail-soft）。这是评估状态维护，非控制动作，不违背 board-only 策略（与 `fleet_watch_state.last_health` 同性质）。 |

### 2.4 验收

- 单测：mem 在 `[WARN, WARN+BAND)` 且 prev=warning 时保持 warning；回升越过 band 解除；进入 critical 后回落但未越过 band 保持 critical；无 prev 时行为与现状一致。
- `runtime-health.test.ts`：带 prev 状态的评估输出预期 warnings。

## 3. P0-2 节点维护窗口（maintenance windows）

### 3.1 语义

per-node 配置绝对时间窗口（ISO start/end 数组）。窗口覆盖当前时刻时，该节点的以下信号全部静默：

1. `runtime-health` board 的 fleet 块（offline / online_unverified / missing）与 `fleetResources` findings；
2. `tickNamedFleetWatch` 的 `ops.fleet_attention`（不计数、不告警）；
3. `fleet_host_check` 的 `ops.fleet_host_check` 告警与 auto-repair（check 本身继续跑，只抑制告警与修复动作）。

### 3.2 配置模型

新表 `node_maintenance_policy`（镜像 `node_recovery_policy` 模式）：

```
node_id TEXT PRIMARY KEY,
windows JSONB NOT NULL DEFAULT '[]',   -- [{ "start": "<ISO>", "end": "<ISO>" }]
updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
```

- Zod schema：`maintenanceWindowsSchema = z.array(z.object({ start: z.string(), end: z.string() }))`，写入时校验 ISO 可解析且 `start < end`，fail-closed。
- `upsertNodeMaintenancePolicy(nodeId, { windows }, meta)` / `loadNodeMaintenancePolicy(nodeId)` / `deleteNodeMaintenancePolicy(nodeId, meta)`，均带 `ops.config_changed` 审计（复用 `fleet-repair-config.ts` 的 `auditConfigChange`）。
- 纯函数 `isNodeInMaintenance(nodeId, now, policy | null)`：窗口列表为空或未命中 = false。
- 运算符入口：`tools/fleet-host-check.mts --maint-get <nodeId>` / `--maint-set <nodeId> start=<ISO>,end=<ISO>[,start=…,end=…]`（多窗口成对） / `--maint-clear <nodeId>`（P0 已实现，模式同 `--policy-set`）。

### 3.3 接入

| 文件 | 变更 |
| --- | --- |
| `runtime-health.ts` | 组装前 `loadNodeMaintenancePolicy` 每个 named node；fleet 块 warnings 与 resources findings 过滤 in-maintenance 节点（findings 加 `suppressed: true` 保留展示，warnings 不输出）。 |
| `fleet-inventory.ts` | `tickNamedFleetWatch` 对 in-maintenance 节点跳过 unhealthy 计数与 alert（emission.skippedReason='maintenance'）。 |
| `fleet-host-checks.ts` | alert 与 repair 决策点前查窗口，窗口内跳过（check 状态照常记录）。 |

### 3.4 验收

- 单测：窗口内/外判定、跨窗口边界（start 前 1ms / end 后 1ms）、非法窗口被拒。
- 三个接入点的抑制测试：窗口内 offline 不出 warning、不 alert、不 repair；窗口外行为不变。

## 4. 后续路线（非 P0，登记为 todo）

| todo id | 优先级 | 内容 |
| --- | --- | --- |
| `todo-los-komodo-probe-processes` | P1 | probe 响应按需返回 top-N 进程快照（CPU/RSS），沿用 auto-probe 限速；node34 swap 类事故免 SSH 排查。 |
| `todo-los-komodo-fleet-history` | P1 | fleet 资源指标小时/日聚合落库 + 保留周期/prune；趋势图并入 `todo-los-obs-charts`；阈值调优有数据支撑。 |
| `todo-los-komodo-alert-routing` | P1 | 告警类型→通道路由（飞书/web/SSE）+ per-node 静音，对齐 Komodo Alerter（类型白名单 + 资源黑白名单）。 |
| `todo-los-komodo-node-disabled` | P2 | registry `disabled` 语义（管理员位，独立于 reaper offline），scheduler 跳过 / 告警抑制 / host-check 跳过；衔接 ADR 0010 resource_class。 |
| `todo-los-komodo-onboarding-script` | P2 | 幂等安装脚本（可重跑、版本感知、systemd/nssm/launchd）+ 一次性 onboarding token 自动注册 node id。 |

## 5. K6 合并方案：节点引导与安装收敛

**交集**：`todo-los-komodo-onboarding-script`（K6，P2）与既有 Windows 服务化待办（dtodo `58108d31`：desktop-r45553o nssm/WinSW 服务化）共享「节点安装/服务托管/版本升级」这条路径。los 现状：Linux 走 `deploy-to-remote.sh`（systemd），Windows 走 nssm 半手工（`C:\los\run-executor-task.ps1` watchdog → nssm service `los-executor`），macOS launchd 由 `tools/los-launchd.plist` 覆盖；无统一幂等安装语义、无 onboarding 自动注册。

**合并为一个工作流「节点引导与安装收敛（node bootstrap convergence）」**，拆三个可独立验收的 todo：

1. `todo-los-komodo-onboarding-script`（P2）：安装脚本语义统一 + onboarding token 自动注册（跨平台脚本骨架，参考 setup-periphery.py 的幂等/版本感知/可重跑）。
2. `todo-los-nssm-desktop-service`（P2）：desktop-r45553o nssm 服务化根治（合并 dtodo `58108d31` 的验收：nssm.exe + los 用户 Log on as a service + 恢复策略对齐 systemd Restart=on-failure）。
3. `todo-los-node-deploy-versioned-dirs`（P2，从 runbook Known Follow-Up 提入）：版本化 release 目录 + 原子 `current` 符号链接，解决 tar overlay 不删旧文件问题——这是 onboarding 幂等的部署侧前提。

拆分理由：三者的验收相互独立（脚本形态 / Windows 服务 / 部署原子性），但共享「安装收敛」上下文，合并推进减少重复调研；任一先完成不阻塞其余。

## 6. 风险与不做什么

- **不做**：Komodo 式内存缓存状态机、Docker/镜像更新跟踪、RBAC、Alerter 完整实体（先做 alert-routing 轻量版）。
- **风险**：滞回状态表引入写路径到 runtime-health（读接口变写）。缓解：fail-soft upsert + 单表单行语义；若 board-only 纪律被破坏则把状态维护迁移到 tick 流程（设计已留此口）。
- **风险**：维护窗口是绝对时间窗口，跨时区/夏令时需 operator 自行换算（记录在文档，未来可扩 cron 表达式）。
- **风险**：JSONB 窗口列表与现有 `ops.config_changed` 审计的字段序列化——审计只记 before/after 摘要，不展开 JSON 明细。

## 7. 相关

- 调研：`docs/research/2026-08-19-komodo-review-observability-and-node-management.md`
- 既有模式：`fleet-repair-config.ts`（审计）、`node-recovery-policy.ts`（per-node 表）、`fleet-alert-config.ts`（DB>env>default）
- 计划文档：`docs/operations/2026-08-10-executor-fleet-status-and-monitoring-plan.md` §4.3

## 8. 实现记录（2026-08-19，PR #299）

P0 两项已实现并交付：

- **滞回**：`fleet-resources.ts`（`assessThresholdWithHysteresis` + `FLEET_RESOURCE_HYSTERESIS_BANDS`）、`fleet-resource-state.ts`（`fleet_resource_state` 表）、`runtime-health.ts` 读-评-写回。
- **维护窗口**：`node-maintenance-policy.ts`（`node_maintenance_policy` 表 + `isNodeInMaintenance`），三个抑制点（runtime-health board / tickNamedFleetWatch / fleet-host-checks）接入；CLI `tools/fleet-host-check.mts --maint-get/--maint-set/--maint-clear`。
- 接线：gateway `bootstrap.ts` 注册两个新 ensure；`wiring-topology-baseline.txt` 更新（seed/内部 helper 豁免，同既有模式）。
- 待办登记：`todo-seeds-komodo-20260819.ts`（9 项，K6 合并三拆分），`todo-seeds.test.ts` 的 `CURRENT_ACTIVE_P0_P1` 同步。
- 验证：agent 804+423 测试全绿（含滞回边界往返、窗口边界/非法窗口、三抑制点）；`pnpm check`（全仓 tsc + wiring-topology）通过；CLI `--maint-get` 冒烟正常。
