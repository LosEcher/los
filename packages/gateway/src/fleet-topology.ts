import { listExecutorNodes, type ExecutorNodeRecord } from '@los/agent/executor-nodes';
import {
  summarizeTaskRunPlacement,
  type TaskRunPlacementSummary,
} from '@los/agent/task-runs';
import { isSchedulerDecisionKind, listSchedulerDecisionWindow } from '@los/agent';

/**
 * 机队拓扑读模型 —— "谁在跑、跑在哪、跑不跑得了、最近为什么派给它"。
 *
 * 三条设计约束（每条都对应一个实测过的失败模式）：
 *
 * 1. **形状与 `RuntimeEvidenceGraph` 一致**（`{nodes, edges, counts, warnings}`），另加两个必需元数据
 *    `asOf` 与 `sources`。为什么不另发明一种形状：两个图形状相同，前端渲染内核与"图例表驱动"
 *    这类门禁才能共用；形状一分叉，第二套契约就会各自演化。
 *
 * 2. **观测与声明分开画**。节点来自注册表（**声明**：这台机器登记在册），边来自 `task_runs`
 *    （**观测**：它真的承接了任务）。两者不能合并成一条含糊的"连接"——
 *    `run_specs.node_id` 结构上不可达（放置路径不建 run_spec），而注册表里有 ≠ 真的能跑。
 *
 * 3. **截断与未知都必须可观测**：节点列表触到上限、落点分组被截、窗口里出现类型外的决策 kind，
 *    三者都写进 `warnings`。读模型不吞这些信号，也不把它们变成 0。
 *
 * 未纳入 v1（有意为之，避免读模型一开始就长成第二个真相库）：
 *   · provider 与工作区维度：需要的声明面在 `provider_accounts`（实测全表 1 行且 node_id NULL）
 *     与 `managed_workspaces`（实测 0 行）——**数据为空**，画出来只会误导；
 *   · 节点健康分值：`/nodes/health` 已有独立端点，按需在展示层合并，不在读模型里重算一遍。
 */

/**
 * 节点类别。
 *
 * ⚠️ `executor` 与 `ssh_target` **必须分开**：`executor_nodes` 表里同时住着
 * 执行器（9 行）与 SSH 运维库存（27 行，`nodeKind='ssh_target'`，全部 offline 且无 baseUrl）。
 * 实测教训（真实数据浏览器验证时发现）：把它们都标成 `executor` 会让图声称
 * "36 个执行器"，而真正能接活的只有 9 个 —— 正是"把声明读成能力"这一类错误。
 */
export type FleetTopologyNodeKind = 'gateway' | 'executor' | 'ssh_target' | 'placement_only';
export type FleetTopologyEdgeKind = 'dispatch';

export interface FleetTopologyNode {
  id: string;
  kind: FleetTopologyNodeKind;
  label: string;
  recordId: string;
  record: unknown;
}

export interface FleetTopologyEdge {
  from: string;
  to: string;
  kind: FleetTopologyEdgeKind;
  label?: string;
}

export interface FleetTopologySource {
  id: string;
  kind: 'store';
  /** 该源的数据时刻（本读模型为按需读取，故等于读取时刻）。 */
  asOf: string;
  detail: string;
}

/**
 * 降级通道 —— 本仓既有惯例（`/cross-project/summary` 同型）。
 * 语义：`isDegraded = true` 表示**这张图不完整或有部分不可解释**，
 * 但它**仍然是 200 的可用结果**（缺数据走降级，不是 5xx）。
 */
export interface FleetTopologyDegraded {
  isDegraded: boolean;
  reasons: string[];
}

export interface FleetTopologyGraph {
  nodes: FleetTopologyNode[];
  edges: FleetTopologyEdge[];
  counts: Record<FleetTopologyNodeKind, number>;
  /**
   * 全部可读信号（人读）。
   * 与 `degraded.reasons` 的关系：**reasons 是 warnings 里属于"不完整/不可解释"的那个子集**。
   * 今天两者内容相同（现有信号全是这一类）；分开是为了将来加"非降级的提示"时不破坏降级判据。
   */
  warnings: string[];
  degraded: FleetTopologyDegraded;
  /** 读模型整体的取数时刻。**没有它就无法判断这张图是不是"现在"**。 */
  asOf: string;
  sources: FleetTopologySource[];
}

export interface ReadFleetTopologyOptions {
  /** 落点观测窗口（小时），默认 168（7 天）。 */
  sinceHours?: number;
  /** 节点列表上限，默认 200、上限 500。 */
  nodeLimit?: number;
  /** 落点分组上限，默认 100。 */
  placementLimit?: number;
  /** 决策窗口取多少条（用于"最近为什么派给它"），默认 200。 */
  decisionLimit?: number;
}

const GATEWAY_NODE_ID = 'gateway';
const DEFAULT_SINCE_HOURS = 168;

/** 落点标识的**形态**判定（不是归一化：原值永远保留，这里只决定怎么标注它）。 */
function classifyPlacementTarget(rawNodeId: string | null): { kind: FleetTopologyNodeKind; reason: string } {
  if (rawNodeId === null) return { kind: 'placement_only', reason: 'missing-node-id' };
  if (rawNodeId === 'gateway-local') return { kind: 'placement_only', reason: 'gateway-local' };
  if (/^https?:\/\//i.test(rawNodeId)) return { kind: 'placement_only', reason: 'url-like' };
  return { kind: 'placement_only', reason: 'unregistered' };
}

interface DecisionHint {
  at: string;
  reason: string;
  hasSelectionEvidence: boolean;
  basis?: string;
  policy?: string;
}

export async function readFleetTopology(
  options: ReadFleetTopologyOptions = {},
): Promise<FleetTopologyGraph> {
  const now = new Date();
  const sinceHours = Number.isFinite(Number(options.sinceHours))
    ? Math.max(1, Math.min(24 * 30, Math.floor(Number(options.sinceHours))))
    : DEFAULT_SINCE_HOURS;
  const nodeLimitRaw = Number(options.nodeLimit);
  const nodeLimit = Number.isFinite(nodeLimitRaw) ? Math.max(1, Math.min(500, Math.floor(nodeLimitRaw))) : 200;
  const placementLimitRaw = Number(options.placementLimit);
  const placementLimit = Number.isFinite(placementLimitRaw)
    ? Math.max(1, Math.min(500, Math.floor(placementLimitRaw)))
    : 100;
  const decisionLimitRaw = Number(options.decisionLimit);
  const decisionLimit = Number.isFinite(decisionLimitRaw)
    ? Math.max(1, Math.min(500, Math.floor(decisionLimitRaw)))
    : 200;
  const since = new Date(now.getTime() - sinceHours * 3600_000);

  const warnings: string[] = [];
  const [registry, placement, decisions, kindCensus] = await Promise.all([
    listExecutorNodes(nodeLimit),
    summarizeTaskRunPlacement({ since, limit: placementLimit }),
    listSchedulerDecisionWindow({ since, kinds: ['executor_selection'], limit: decisionLimit }),
    // 第二次读只为**拿 kind 普查**：普查不受 `limit` 影响，所以 limit=1 就够，代价极小。
    // 为什么不复用上面那次：上面按 kinds 过滤后普查里只剩 executor_selection，
    // "窗口内出现类型外 kind"这条告警就永远不会触发（写测试时实测到的一个死判断）。
    listSchedulerDecisionWindow({ since, limit: 1 }),
  ]);

  if (registry.length >= nodeLimit) {
    warnings.push(
      `nodes truncated at limit=${nodeLimit}: 注册表里可能还有更多节点未进入本图（不能把"没画出来"读成"不存在"）`,
    );
  }
  if (placement.truncated) {
    warnings.push(`placement truncated at limit=${placementLimit}: 窗口内还有别的落点未进入本图`);
  }
  if (decisions.truncated) {
    warnings.push(
      `decisions truncated at limit=${decisionLimit}: 窗口内命中 ${decisions.matched} 条，只取了最近 ${decisions.rows.length} 条`,
    );
  }
  // 类型外的决策 kind：读路径不会因它失败，但**必须**在这里被看见（否则它又变成静默不可见）。
  for (const [kindRaw, n] of Object.entries(kindCensus.kindCensus)) {
    // 只对**闭集之外**的 kind 告警：claim / task_outcome / provider_selection 都是合法邻居。
    // （第一版按单一 kind 比较，把合法的 task_outcome 报成"非预期"——生产实跑时抓到的假警报。）
    if (!isSchedulerDecisionKind(kindRaw)) {
      warnings.push(`scheduler_decisions 窗口内出现闭集外的 kind=${kindRaw}（${n} 行）：读路径已容忍，但值本身需要处置`);
    }
  }

  // 每个落点最近一次派发决策的"理由"（放置层留证）。实测只有约 10.6% 的
  // executor_selection 带 metadata.selection（basis/policy/probes），所以这里如实区分
  // "有理由"与"只有 reason 字段"，不把缺失补成默认值。
  const hintByNode = new Map<string, DecisionHint>();
  for (const decision of decisions.rows) {
    const selection = (decision.metadata as { selection?: { basis?: string; policy?: string } }).selection;
    const hint: DecisionHint = {
      at: decision.createdAt,
      reason: decision.reason,
      hasSelectionEvidence: Boolean(selection),
      basis: selection?.basis,
      policy: selection?.policy,
    };
    for (const id of decision.selectedIds) {
      const current = hintByNode.get(id);
      if (!current || current.at < hint.at) hintByNode.set(id, hint);
    }
  }

  const nodes: FleetTopologyNode[] = [];
  const edges: FleetTopologyEdge[] = [];
  const registeredIds = new Set<string>();
  const placementByTarget = new Map<string, TaskRunPlacementSummary>();
  for (const row of placement.rows) placementByTarget.set(row.nodeId ?? '\u0000missing', row);

  const gatewayLocal = placementByTarget.get('gateway-local');
  nodes.push({
    id: GATEWAY_NODE_ID,
    kind: 'gateway',
    label: 'gateway',
    recordId: GATEWAY_NODE_ID,
    record: {
      // 网关自己也是合法落点：没解析出 executor 时任务就在网关进程里跑（node_id='gateway-local'）。
      // 它**不在注册表里**，所以必须由落点观测面提供，不能靠注册表。
      localPlacement: gatewayLocal ?? null,
      localDecision: hintByNode.get('gateway-local') ?? null,
    },
  });

  for (const record of registry) {
    registeredIds.add(record.nodeId);
    const summary = placementByTarget.get(record.nodeId);
    const registeredKind: FleetTopologyNodeKind = record.nodeKind === 'executor' ? 'executor' : 'ssh_target';
    nodes.push({
      id: record.nodeId,
      kind: registeredKind,
      label: record.hostLabel || record.nodeId,
      recordId: record.nodeId,
      record: executorRecord(record, summary, hintByNode.get(record.nodeId) ?? null),
    });
  }

  // 只出现在**观测**里的落点（未登记 / 网关本地 / URL 污染 / 无 node_id）
  for (const row of placement.rows) {
    const rawId = row.nodeId;
    if (rawId !== null && registeredIds.has(rawId)) continue;
    const key = rawId ?? '\u0000missing';
    const { kind, reason } = classifyPlacementTarget(rawId);
    const id = rawId === null ? 'placement:(missing-node-id)' : `placement:${rawId}`;
    nodes.push({
      id,
      kind,
      label: rawId ?? '(no node_id)',
      recordId: id,
      record: { rawNodeId: rawId, reason, placement: row, decision: rawId ? hintByNode.get(rawId) ?? null : null },
    });
    void key;
  }

  for (const node of nodes) {
    if (node.kind === 'gateway') continue;
    const summary = (node.record as { placement?: TaskRunPlacementSummary | null }).placement;
    if (!summary || summary.total <= 0) continue; // 没跑过就不画边（注册≠在用）
    edges.push({
      from: GATEWAY_NODE_ID,
      to: node.id,
      kind: 'dispatch',
      label: `${summary.total} 次`,
    });
  }

  const counts: Record<FleetTopologyNodeKind, number> = { gateway: 0, executor: 0, ssh_target: 0, placement_only: 0 };
  for (const node of nodes) counts[node.kind] += 1;

  return {
    nodes,
    edges,
    counts,
    warnings,
    degraded: { isDegraded: warnings.length > 0, reasons: [...warnings] },
    asOf: now.toISOString(),
    sources: [
      {
        id: 'executor_nodes',
        kind: 'store',
        asOf: now.toISOString(),
        detail: `listExecutorNodes(limit=${nodeLimit}) —— 注册表（声明面）；含执行器与 SSH 运维库存（ssh_target），两者按 nodeKind 分开呈现`,
      },
      {
        id: 'task_runs',
        kind: 'store',
        asOf: now.toISOString(),
        detail: `task_runs.node_id 聚合，窗口 ${placement.window.since} → ${placement.window.until}（观测面）`,
      },
      {
        id: 'scheduler_decisions',
        kind: 'store',
        asOf: now.toISOString(),
        detail: `kind=executor_selection 窗口读，命中 ${decisions.matched} 条（放置层留证）`,
      },
    ],
  };
}

/**
 * 按**声明的**字段读 capacity。
 *
 * 2026-10-12 更新：`ExecutorNodeCapacity` 已按实测补齐（此前类型比运行时窄，
 * 这里不得不绕过类型取字段——那是一个"契约陈旧"逼出来的 cast）。现在直接读类型字段，
 * 仍然保留**显式白名单**：读模型只暴露它声称提供的字段，免得 `capacity_json` 的演化
 * 悄悄把内部字段泄漏到 API 上。
 *
 * ⚠️ 白名单必须与 `/nodes`（同一个 operator 面）**不冲突**：实测发现这里曾漏掉
 * `pid`/`swapUsedMb`/`kernelVersion`，而它们在库里都有值、且 `/nodes` 本来就原样返回
 * ⇒ 新端点比旧端点少给信息是没道理的不对称（真实库对账抓到的）。
 */
function readCapacity(capacity: ExecutorNodeRecord['capacity']): Record<string, unknown> {
  return {
    platform: capacity.platform ?? null,
    arch: capacity.arch ?? null,
    cpuCores: capacity.cpuCores ?? null,
    cpuModel: capacity.cpuModel ?? null,
    cpuLoad1m: capacity.cpuLoad1m ?? null,
    memoryTotalMb: capacity.memoryTotalMb ?? null,
    memoryAvailableMb: capacity.memoryAvailableMb ?? null,
    swapTotalMb: capacity.swapTotalMb ?? null,
    swapUsedMb: capacity.swapUsedMb ?? null,
    kernelVersion: capacity.kernelVersion ?? null,
    pid: capacity.pid ?? null,
    psiIoFull: capacity.psiIoFull ?? null,
    psiMemoryFull: capacity.psiMemoryFull ?? null,
    sampledAt: capacity.sampledAt ?? null,
    // 明确保留为 null 的旧字段：读模型**不**假装它知道磁盘空闲（实测无人采集）
    diskFreeGb: capacity.diskFreeGb ?? null,
  };
}

function executorRecord(
  record: ExecutorNodeRecord,
  placement: TaskRunPlacementSummary | undefined,
  decision: DecisionHint | null,
): Record<string, unknown> {
  return {
    nodeId: record.nodeId,
    nodeKind: record.nodeKind,
    hostLabel: record.hostLabel,
    status: record.status,
    baseUrl: record.baseUrl,
    version: record.version,
    targetVersion: record.targetVersion,
    rolloutState: record.rolloutState,
    connectModes: record.connectModes,
    queueDepth: record.queueDepth,
    activeTaskCount: record.activeTaskCount,
    lastHeartbeatAt: record.lastHeartbeatAt,
    lastProbeAt: record.lastProbeAt,
    capabilities: {
      sandbox: record.capabilities?.sandbox,
      runAgent: record.capabilities?.run_agent,
      resourceClass: record.capabilities?.resourceClass,
      heavyTaskSafe: record.capabilities?.heavy_task_safe,
      workspaceRead: record.capabilities?.workspace_read,
    },
    // ⚠️ 已知契约漂移：`ExecutorNodeCapacity` 的类型比**实测数据**窄 —— 契约
    // （contracts/node-registry.yaml）声明的是 snake_case 且只有 9 个字段，而心跳实际写进来的是
    // camelCase 并多出 cpuCores/cpuLoad1m/sampledAt（实测 36/36 节点都有）。这里按**运行时字段**读，
    // 不假装类型知道它们；等契约与实现对齐后再把 cast 去掉（跟踪项见母仓 G10）。
    capacity: record.capacity ? readCapacity(record.capacity) : null,
    // execution.blockers 是"为什么这台现在不能用"的**结构化原因**，比 status=offline 信息量大得多
    execution: record.execution ? { candidate: record.execution.candidate, mode: record.execution.mode, blockers: record.execution.blockers, warnings: record.execution.warnings } : null,
    placement: placement ?? null,
    decision,
  };
}
