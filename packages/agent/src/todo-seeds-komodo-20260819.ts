import type { CreateTodoInput } from './todo-types.js';

/**
 * 2026-08-19 Komodo 借鉴批次（观测与节点管理）。
 * 报告：docs/research/2026-08-19-komodo-review-observability-and-node-management.md
 * 设计：docs/architecture/2026-08-19-komodo-borrow-p0-design.md
 * 来源：komodo-borrow-2026-08-19
 */
export const KOMODO_20260819_TODO_SEED: CreateTodoInput[] = [
  {
    id: 'todo-los-komodo-hysteresis',
    title: 'fleet 资源告警滞回：比例信号（mem/swap/load）边界防抖',
    description:
      'fleet-resources 阈值评估引入滞回带（FLEET_RESOURCE_HYSTERESIS_BAND=0.03）：' +
      '进入告警按原始阈值，解除/降级需越过滞回带；' +
      'prev 严重度状态落 fleet_resource_state 表（node_id, severities JSONB），runtime-health 读-评-写回（fail-soft）。' +
      '布尔型（active_tasks_light_node）与派生型（heartbeat_age/capacity_missing）不做滞回。',
    kind: 'task',
    status: 'ready',
    priority: 'P0',
    source: 'komodo-borrow-2026-08-19',
    stageId: 'komodo-p0',
    dedupeKey: 'los:todo:komodo-hysteresis',
    metadata: {
      problem: 'fleet 阈值（mem 15%/5%、swap 50%/80%、load 2/4）在边界附近的 tick 抖动制造噪音事件；无 prev 状态导致 warning 反复出现/消失。',
      solution: '参照 Komodo ALERT_PERCENTAGE_THRESHOLD 滞回：评估函数加可选 prevSeverities 参数，默认不传=现状行为；状态持久化到 fleet_resource_state。',
      designDoc: 'docs/architecture/2026-08-19-komodo-borrow-p0-design.md §2',
      evidence: [
        'packages/agent/src/fleet-resources.ts（阈值评估）',
        'packages/agent/src/runtime-health.ts:184（评估接入点）',
        'packages/agent/src/fleet-inventory.ts fleet_watch_state（既有状态表模式）',
      ],
      validation: [
        '单测：mem 在 [WARN, WARN+BAND) 且 prev=warning 保持 warning；回升越过 band 解除；critical 回落未越 band 保持；无 prev 与现状一致',
        'runtime-health.test.ts：带 prev 状态评估输出预期 warnings',
        'pnpm --filter @los/agent check && pnpm --filter @los/agent test',
      ],
      statusUpdatedAt: '2026-08-19',
    },
  },
  {
    id: 'todo-los-komodo-maintenance-window',
    title: '节点维护窗口：计划内停机静默告警与自愈',
    description:
      'per-node 绝对时间窗口配置（node_maintenance_policy 表，windows JSONB [{start,end}]，Zod 校验 ISO 且 start<end，fail-closed，' +
      'ops.config_changed 审计）；窗口内抑制三处：runtime-health board（fleet 块 + fleetResources findings，suppressed 标记保留展示）、' +
      'tickNamedFleetWatch 的 ops.fleet_attention、fleet_host_check 的告警与 auto-repair（check 本身照常记录）。',
    kind: 'task',
    status: 'ready',
    priority: 'P0',
    source: 'komodo-borrow-2026-08-19',
    stageId: 'komodo-p0',
    dedupeKey: 'los:todo:komodo-maintenance-window',
    metadata: {
      problem: '节点升级/重启/部署窗口必然触发 fleet_attention/资源告警/host-check 失败告警噪音；升级 runbook 要求 activeTaskCount=0 前停机但无告警抑制。',
      solution: '参照 Komodo maintenance_windows：node_maintenance_policy 表 + isNodeInMaintenance 纯函数贯穿三个抑制点。',
      designDoc: 'docs/architecture/2026-08-19-komodo-borrow-p0-design.md §3',
      evidence: [
        'packages/agent/src/node-recovery-policy.ts（per-node 配置表模式）',
        'packages/agent/src/fleet-inventory.ts tickNamedFleetWatch（attention 接入点）',
        'packages/agent/src/fleet-host-checks.ts（host-check 告警/repair 接入点）',
      ],
      validation: [
        '单测：窗口内/外判定、start 前 1ms / end 后 1ms 边界、非法窗口被拒',
        '三接入点抑制测试：窗口内 offline 不出 warning、不 alert、不 repair；窗口外不变',
        'pnpm --filter @los/agent check && pnpm --filter @los/agent test',
      ],
      statusUpdatedAt: '2026-08-19',
    },
  },
  {
    id: 'todo-los-komodo-probe-processes',
    title: 'probe 按需进程快照：top-N CPU/RSS 免 SSH 排查',
    description:
      'probe 响应扩展可选 top-N 进程快照（按 CPU/RSS 排序），沿用 auto-probe 限速节奏（不新增高频轮询）；' +
      '进程快照作为 verified probe 能力之一。node34 swap 类事故（2026-08-10 §8 靠人工 SSH VmSwap）可免 SSH 定位。',
    kind: 'task',
    status: 'backlog',
    priority: 'P1',
    source: 'komodo-borrow-2026-08-19',
    stageId: 'komodo-p1',
    dependsOnIds: ['todo-los-komodo-hysteresis'],
    dedupeKey: 'los:todo:komodo-probe-processes',
    metadata: {
      problem: 'heartbeat 只带 mem/cpu/load/psi，无进程级证据；swap 高/内存泄漏定位需人工 SSH。',
      solution: '参照 Komodo periphery get_processes：probe 返回 top-N 进程（pid/name/rss/cpu%），限速不变。',
      designDoc: 'docs/research/2026-08-19-komodo-review-observability-and-node-management.md §5.1 K4',
      validation: ['probe 单测：进程快照字段与排序', 'auto-probe 限速不变'],
      statusUpdatedAt: '2026-08-19',
    },
  },
  {
    id: 'todo-los-komodo-fleet-history',
    title: 'fleet 资源历史统计：小时/日聚合 + 保留周期/prune',
    description:
      'heartbeat capacity（mem/swap/load）按小时/日聚合落库，配 keep_for_days 保留 + 定时 prune（参照 Komodo keep_stats_for_days）；' +
      '趋势图并入 todo-los-obs-charts；阈值调优有数据支撑（fleet plan 的 "tune after a week of data" 缺数据）。',
    kind: 'task',
    status: 'backlog',
    priority: 'P1',
    source: 'komodo-borrow-2026-08-19',
    stageId: 'komodo-p1',
    dependsOnIds: ['todo-los-komodo-hysteresis'],
    dedupeKey: 'los:todo:komodo-fleet-history',
    metadata: {
      problem: 'heartbeat capacity 无时间序列落库；fleet 趋势不可回看，阈值无数据支撑。',
      solution: '聚合表（node_id, bucket, metrics）+ prune 任务；数据源为 fleet_resource_state/registry capacity。',
      designDoc: 'docs/research/2026-08-19-komodo-review-observability-and-node-management.md §5.1 K5',
      validation: ['聚合/保留单测', 'prune 定时任务幂等'],
      statusUpdatedAt: '2026-08-19',
    },
  },
  {
    id: 'todo-los-komodo-alert-routing',
    title: '告警路由：类型→通道 + per-node 静音（轻量 Alerter）',
    description:
      '告警类型→通道路由配置（飞书/web/SSE）+ per-node 静音；轻量版：alert-type→channel map 存 DB 或 config，默认全量→飞书+web。' +
      '对齐 Komodo Alerter（类型白名单 + 资源黑白名单）但保持轻量，不做完整 Alerter 实体。',
    kind: 'task',
    status: 'backlog',
    priority: 'P1',
    source: 'komodo-borrow-2026-08-19',
    stageId: 'komodo-p1',
    dependsOnIds: ['todo-los-komodo-maintenance-window'],
    dedupeKey: 'los:todo:komodo-alert-routing',
    metadata: {
      problem: '告警通道写死（SSE+单渠道）；告警类型→通道无路由；无法按资源静音。',
      solution: '告警类型→通道 map + per-node 静音（与维护窗口合并为 node 级 alert policy）。',
      designDoc: 'docs/research/2026-08-19-komodo-review-observability-and-node-management.md §5.1 K3',
      statusUpdatedAt: '2026-08-19',
    },
  },
  {
    id: 'todo-los-komodo-node-disabled',
    title: 'registry disabled 语义：管理员停用位',
    description:
      'executor registry 状态扩展 disabled（管理员位，独立于 reaper 的 offline）；disabled 时 scheduler 跳过、告警抑制、host-check 跳过；' +
      '衔接 ADR 0010 resource_class 与 node_recovery_policy。参照 Komodo server enabled=false → 关联资源 Unknown。',
    kind: 'task',
    status: 'backlog',
    priority: 'P2',
    source: 'komodo-borrow-2026-08-19',
    stageId: 'komodo-p2',
    dedupeKey: 'los:todo:komodo-node-disabled',
    metadata: {
      problem: '无节点停用语义：registry 只有 online/offline（reaper 判定），无法表达「管理员主动停用」。',
      solution: 'registry 状态扩展 disabled + 各消费方（scheduler/告警/host-check）联动。',
      designDoc: 'docs/research/2026-08-19-komodo-review-observability-and-node-management.md §5.1 K7',
      statusUpdatedAt: '2026-08-19',
    },
  },
  {
    id: 'todo-los-komodo-onboarding-script',
    title: '幂等节点安装脚本 + onboarding token 自动注册',
    description:
      '节点引导与安装收敛（node bootstrap convergence）第一项：统一安装脚本语义（幂等、可重跑、版本感知、systemd/nssm/launchd 三平台），' +
      'core 一次性签发 onboarding token → 节点脚本自行注册 node id（参照 Komodo setup-periphery.py：--onboarding-key、--force-service-file、可重跑即升级）。',
    kind: 'task',
    status: 'backlog',
    priority: 'P2',
    source: 'komodo-borrow-2026-08-19',
    stageId: 'komodo-p2',
    dependsOnIds: ['todo-los-nssm-desktop-service'],
    dedupeKey: 'los:todo:komodo-onboarding-script',
    metadata: {
      problem: 'los 安装半手工预置（EXECUTOR_NODE_ID+token 先配好再装），无一次性 onboarding 自动注册；Windows 无等价脚本。',
      solution: '参照 setup-periphery.py 设计：幂等 + 版本感知 + 自动注册；与 node-deployment-runbook 的 deploy-to-remote.sh 衔接。',
      designDoc: 'docs/architecture/2026-08-19-komodo-borrow-p0-design.md §5',
      statusUpdatedAt: '2026-08-19',
    },
  },
  {
    id: 'todo-los-nssm-desktop-service',
    title: 'desktop-r45553o nssm 服务化根治（合并 dtodo 58108d31）',
    description:
      '节点引导与安装收敛第二项：desktop-r45553o Windows executor 由 watchdog 脚本迁移为 nssm/WinSW 正式服务' +
      '（nssm.exe + los 用户 Log on as a service 权限，恢复策略对齐 systemd Restart=on-failure）。' +
      '合并既有 dtodo 58108d31 的验收，作为 onboarding 脚本的 Windows 侧前置。',
    kind: 'task',
    status: 'backlog',
    priority: 'P2',
    source: 'komodo-borrow-2026-08-19',
    stageId: 'komodo-p2',
    dedupeKey: 'los:todo:nssm-desktop-service',
    metadata: {
      problem: 'Task Scheduler Interactive 会话绑定：会话注销时 watchdog 自身被杀；机器重启场景已由 AtStartup 覆盖但进程生命周期仍不服务级。',
      solution: 'nssm.exe + Log on as a service；SCM 恢复策略 5s/10s/30s 对齐 systemd Restart=on-failure。',
      designDoc: 'docs/architecture/2026-08-19-komodo-borrow-p0-design.md §5',
      evidence: [
        'docs/operations/2026-08-10-executor-fleet-status-and-monitoring-plan.md §2.3（nssm 迁移记录）',
        'dtodo 58108d31（原待办）',
      ],
      statusUpdatedAt: '2026-08-19',
    },
  },
  {
    id: 'todo-los-node-deploy-versioned-dirs',
    title: '节点部署版本化目录 + 原子 current 符号链接',
    description:
      '节点引导与安装收敛第三项：从 node-deployment-runbook Known Follow-Up 提入——tar sync overlay 不证明旧远程源文件被删；' +
      '改为版本化 release 目录 + 原子 current 符号链接（或远程文件 manifest 校验），作为 onboarding 幂等的部署侧前提。',
    kind: 'task',
    status: 'backlog',
    priority: 'P2',
    source: 'komodo-borrow-2026-08-19',
    stageId: 'komodo-p2',
    dedupeKey: 'los:todo:node-deploy-versioned-dirs',
    metadata: {
      problem: 'deploy-to-remote.sh 的 tar sync 覆盖 /opt/los，不删除陈旧远程源文件，回滚依赖存档校验和。',
      solution: '版本化 release 目录 + 原子 current symlink 切换；回滚 = 切换链接。',
      designDoc: 'docs/architecture/2026-08-19-komodo-borrow-p0-design.md §5',
      evidence: ['docs/operations/node-deployment-runbook.md Known Follow-Up'],
      statusUpdatedAt: '2026-08-19',
    },
  },
];
