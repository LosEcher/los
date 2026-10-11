import { getConfig } from '@los/infra/config';
import { getDb } from '@los/infra/db';
import { loadExecutorNode, type ExecutorNodeRecord } from '../executor-nodes.js';
import { resolveExecutorCommandUrl } from '../executor-node-utils.js';
import { _buildBwrapArgs } from '../tools/external/shell-sandbox.js';
import { createNodeCheckRunner } from './node-check-runner.js';
import { normalizeOptionalString, normalizePositiveInteger, readObject } from './helpers.js';

/**
 * placement — 放置策略：**先核实，再轮转**（S7，2026-10-11）。
 *
 * ## 为什么需要它
 *
 * 2026-10-11 实测（`scheduler_decisions` 全量）：按注册表选择时 **673 次里 659 次落 mbp（97.9%）**，
 * 非本机只赢过 14 次。原因不是"没有路由"，而是路由**只看得见注册表**：
 *
 * 1. `sortExecutorCandidates` 的末段键是 `Object.keys(capacity).length`（executor-nodes.ts:458，
 *    注释自称 "approximate by presence"）——**报字段多的机器赢，不是资源多的机器赢**
 *    （实测 m3pro 有 28 GB 可用却排在只报 5 个字段的 mbp 之后）；
 * 2. 候选资格里**没有任何一条**问过"这台机器上到底有没有这个工作区"。
 *    实测工作区分布（只读探测，见 S7 阶段总结）：Mac 工作区**只在 mbp**、
 *    `/opt/los/los-workspace` **只在 node34**、`/Users/echerlos/projects/cantool` **只在 m3pro**。
 *    ⇒ 今天"总是选 mbp"**对 Mac 工作区的任务恰好是对的**，但那是巧合，不是判据；
 *    一旦任务的工作区在别处（或 mbp 探测失败），选择就会把一个必然读不到文件的任务派出去。
 *
 * ## 这一层做什么（三件，都可机械复核）
 *
 * - **核实**：派发前，用**既有的受治理节点命令通道**（`run-check`，与 requiredChecks 同一条）
 *   在候选节点上跑**一条只读命令**，确认 ①它活着 ②工作区在它本地存在 ③（有 VCS 时）拿到它的 revision。
 *   结果带 TTL 缓存：正结果长 TTL、**负结果短 TTL**（瞬时失败不许粘住十分钟）。
 * - **轮转**：在**通过核实**的候选里按"最近窗口内被选次数最少"选择。轮转状态**不另存**——
 *   它就是 `scheduler_decisions` 本身（台账即状态），因此可事后复算。
 * - **留证**：把候选的 capacity 快照 + 每个节点的探测结果 + 轮转计数 + 选中理由一起交给调用方，
 *   由调用方写进 `scheduler_decisions.metadata`。这是 NEXT-STEPS §4.2 点名的欠账
 *   （"关键任务的路由依据要能被事后复核"——改前**做不到**，因为决策记录里没有 capacity）。
 *
 * ## 安全阀（为什么默认不会砸坏现有任务）
 *
 * - `workspacePolicy='verify'`（默认）：**只有工作区确实在节点上**才算通过。工作区只在一台机器上时，
 *   核实结果就只有那一个候选 ⇒ 结果与今天一致（但现在是**查过的**，不是猜的）。
 * - 所有候选都没通过 ⇒ **回退到既有健康序**并把 `basis` 记成 `probe_fallback_health`，
 *   不 fail-closed（可用性优先），但证据面上能看出这次是"没核实成"。
 * - 调用方显式给了 `nodeId`/`nodeUrls`（硬钉）时**根本不进本层**——硬隔离优先级高于轮转。
 */

/** 一次工作区探测的结果。`reachable=false` 表示**命令没跑通**，此时 `present` 无意义。 */
export interface WorkspaceProbeOutcome {
  nodeId: string;
  checkedAt: string;
  durationMs: number;
  reachable: boolean;
  present: boolean;
  /** 节点本地工作区的 VCS revision（短 hash）。无 `.git` / 无 `git` 时为 undefined。 */
  revision?: string;
  error?: string;
  /** 结果是否来自缓存（缓存命中的探测**不能**当作"刚刚可达"的证据）。 */
  cached?: boolean;
}

export type WorkspacePolicy = 'verify' | 'portable';
export type PlacementPolicy = 'health' | 'verified-rotate';

export function _normalizeWorkspacePolicy(value: unknown): WorkspacePolicy {
  const explicit = normalizeOptionalString(value);
  if (explicit === 'portable' || explicit === 'verify') return explicit;
  return configuredExecutorPolicy('workspacePolicy') === 'portable' ? 'portable' : 'verify';
}

export function _normalizePlacementPolicy(value: unknown): PlacementPolicy {
  const explicit = normalizeOptionalString(value);
  if (explicit === 'health' || explicit === 'verified-rotate') return explicit;
  return configuredExecutorPolicy('placementPolicy') === 'health' ? 'health' : 'verified-rotate';
}

/**
 * 配置读取要能容忍"配置还没加载"（很多单测只测选择逻辑，不该被迫起配置）。
 * 读不到就按代码里的默认值走 —— 与 ConfigSchema 的 default 同值。
 */
function configuredExecutorPolicy(key: 'placementPolicy' | 'workspacePolicy'): unknown {
  try {
    return getConfig().executor?.[key];
  } catch {
    return undefined;
  }
}

const PROBE_TTL_MS = () => normalizePositiveInteger(process.env.LOS_PLACEMENT_PROBE_TTL_MS) ?? 600_000;
const PROBE_NEGATIVE_TTL_MS = () => normalizePositiveInteger(process.env.LOS_PLACEMENT_PROBE_NEGATIVE_TTL_MS) ?? 60_000;
const PROBE_TIMEOUT_MS = () => normalizePositiveInteger(process.env.LOS_PLACEMENT_PROBE_TIMEOUT_MS) ?? 8_000;
const ROTATION_WINDOW_MINUTES = () => normalizePositiveInteger(process.env.LOS_PLACEMENT_ROTATION_WINDOW_MIN) ?? 30;
/**
 * 每轮最多探几个候选。默认 **8**（= 覆盖全部在线 executor）而不是 3：
 * **探测数直接决定可分流的上限**，而 probe 有 TTL 缓存，多探几个的边际成本接近 0。
 *
 * 2026-10-11 实测两次踩到这条：
 * ① 限 3 时"已核实"集合只有 3 个节点，判据 ≥3 恰好卡在边界；
 * ② 限 6 时**受约束节点（oracle/tencent，内存压力为 warning 类）被排在 Windows 桌面机之后**，
 *   于是永远轮不到它们被探、也就永远不参与分流——`sortExecutorCandidates` 的压力分档
 *    让"小机器"默认沉底，而 portable 的只读任务本来就可以跑在小机器上。
 */
const MAX_PROBES = () => normalizePositiveInteger(process.env.LOS_PLACEMENT_MAX_PROBES) ?? 8;
/** 节点级失败的回看窗口：刚证明"跑不了 agent"的节点不该继续被轮转选中。 */
const NODE_FAILURE_WINDOW_MINUTES = () => normalizePositiveInteger(process.env.LOS_PLACEMENT_FAILURE_WINDOW_MIN) ?? 60;

const _cache = new Map<string, { at: number; outcome: WorkspaceProbeOutcome }>();

/** 测试用：清空探测缓存（进程级缓存，跨用例会互相污染）。 */
export function _clearWorkspaceProbeCache(): void {
  _cache.clear();
}

/**
 * 只读探测命令：**一条**，同时回答 存在/不存在、revision，以及**声明的沙箱到底能不能跑**。
 *
 * 为什么不用 `test -d` + 单独取 revision：两次往返 = 两倍的瞬时失败面，而这里每一次探测
 * 都在派发路径上。命令对不支持 POSIX 的节点（实测 Win 节点 `cmd.exe` ENOENT）会失败，
 * 那是**正确的**——它确实跑不了 POSIX 工作区的任务。
 *
 * ⚠️ 2026-10-11 实测（本模块第一次上线就被自己的证据面抓到）：这里少写一个 `;`，
 * 整条命令在**所有**节点上都以 `Syntax error: "then" unexpected` 立刻失败，
 * 而当时的 `reachable` 只看"有没有退出码" ⇒ 每个节点都被当成"已核实"。
 * 现在有两条防线：① 本函数由单测用 `sh -n` 做**语法**校验；② `reachable` 要求
 * **退出码 0 且输出可解析**。教训：判据必须能区分"跑通了"与"跑过了"。
 *
 * ⚠️⚠️ 同一天的第二个实例（vultr）：节点上报 `capabilities.sandbox = linux-bwrap`（二进制在），
 * 但因为宿主策略，**以服务用户身份**跑 bwrap 会 `bwrap: loopback: Failed RTM_NEWADDR:
 * Operation not permitted` —— 声明的能力**实际不可用**，任务跑到一半才炸（agent 侧
 * `run_shell` 全失败，最后由 self-check 兜住并 blocked）。
 * ⇒ 探测必须**在任务的真实上下文里演练那条沙箱**，而不是只问"有没有这个二进制"。
 * 现在：节点上有 bwrap 就**通过 bwrap 跑探测**，bwrap 起不来就回 `SANDBOX_FAILED rc=… <stderr>`，
 * 于是"沙箱跑不动"在**派发之前**就变成不可核实，而不是运行中的失败。
 */
export function _buildWorkspaceProbeCommand(
  workspaceRoot: string,
  options: { bwrapPath?: string } = {},
): string {
  const quoted = shQuote(workspaceRoot);
  const inner = [
    `d=${quoted};`,
    `if [ -d "$d" ]; then printf PRESENT;`,
    `r=$(git -C "$d" rev-parse --short HEAD 2>/dev/null);`,
    `[ -n "$r" ] && printf ' %s' "$r";`,
    `else printf ABSENT; fi;`,
    `true`,
  ].join(' ');
  const bwrapPath = options.bwrapPath ?? '/usr/bin/bwrap';
  // 与 agent 真正执行 shell 时**同一套**参数（单一来源：_buildBwrapArgs），避免"探测用的沙箱"
  // 与"任务用的沙箱"漂移——那正是这个探测要防的事。
  // ⚠️ `_buildBwrapArgs` 只返回 **argv**；可执行文件由调用方拼（真实现见 shell-sandbox.ts 的
  // `runWithLinuxBwrap`）。漏掉这个前缀会让探测以 `--ro-bind` 当命令名执行，于是**每个有 bwrap
  // 的节点都假红**（单测里那条"假 bwrap"用例就是抓这个的）。
  const wrapped = [
    shQuote(bwrapPath),
    ..._buildBwrapArgs(bwrapPath, workspaceRoot, inner, 'readonly', 'isolated').map(shQuote),
  ].join(' ');
  return [
    `if [ -x ${shQuote(bwrapPath)} ]; then`,
    `out=$(${wrapped} 2>&1); rc=$?;`,
    `if [ "$rc" -eq 0 ]; then printf '%s' "$out";`,
    `else printf 'SANDBOX_FAILED rc=%s %s' "$rc" "$out"; fi;`,
    `else ${inner}; fi`,
  ].join(' ');
}

function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function parseProbeOutput(stdout: string): { responded: boolean; present: boolean; revision?: string } {
  const text = stdout.trim();
  if (text.startsWith('ABSENT')) return { responded: true, present: false };
  if (!text.startsWith('PRESENT')) {
    // 输出形态不认识 ⇒ "没核实成"，不要猜（Windows 节点返回的乱码就走这条路）。
    return { responded: false, present: false };
  }
  const revision = text.slice('PRESENT'.length).trim().split(/\s+/).filter(Boolean)[0];
  return { responded: true, present: true, revision: normalizeOptionalString(revision) };
}

export async function _probeNodeWorkspace(input: {
  nodeId: string;
  workspaceRoot: string;
  agentKey?: string;
  /** 调用方已解析的命令端点（省一次节点查询；测试可注入）。 */
  commandUrl?: string;
  timeoutMs?: number;
  /** 绕过缓存（自检/验收时用来拿"此刻"的真值）。 */
  force?: boolean;
}): Promise<WorkspaceProbeOutcome> {
  const key = `${input.nodeId}::${input.workspaceRoot}`;
  const hit = _cache.get(key);
  if (hit && !input.force) {
    const ttl = hit.outcome.reachable && hit.outcome.present ? PROBE_TTL_MS() : PROBE_NEGATIVE_TTL_MS();
    if (Date.now() - hit.at < ttl) return { ...hit.outcome, cached: true };
  }

  const started = Date.now();
  const checkedAt = new Date().toISOString();
  const commandUrl = input.commandUrl ?? await resolveCommandUrlFor(input.nodeId);
  if (!commandUrl) {
    return remember(key, {
      nodeId: input.nodeId, checkedAt, durationMs: Date.now() - started,
      reachable: false, present: false,
      error: `node ${input.nodeId} exposes no governed command endpoint (agent_http.commandUrl)`,
    });
  }

  const timeoutMs = input.timeoutMs ?? PROBE_TIMEOUT_MS();
  const runner = createNodeCheckRunner({
    nodeId: input.nodeId,
    agentKey: input.agentKey,
    commandUrl,
    defaultTimeoutMs: timeoutMs,
  });
  const result = await runner(_buildWorkspaceProbeCommand(input.workspaceRoot), {
    cwd: '/tmp',
    timeoutMs,
  });
  const parsed = parseProbeOutput(result.outputSummary);
  // `reachable` 的口径是**"这个节点听懂了并回答了"**，不是"某个 shell 退出了"。
  // 2026-10-11 实测教训（这条判据是踩出来的）：命令写坏时远端 `sh` 会以**非零码**
  // 立刻返回（`Syntax error: "then" unexpected`），Windows 节点则返回一段乱码；
  // 只要判"有输出/有退出码"就会把它们当成"可达"，于是把任务派给必然跑不动的节点。
  const reachable = result.exitCode === 0 && parsed.responded;
  return remember(key, {
    nodeId: input.nodeId,
    checkedAt,
    durationMs: Date.now() - started,
    reachable,
    present: reachable ? parsed.present : false,
    revision: reachable ? parsed.revision : undefined,
    error: reachable
      ? result.error
      : result.error ?? `probe did not answer (exit=${String(result.exitCode)}): ${result.outputSummary.slice(0, 200)}`,
  });
}

function remember(key: string, outcome: WorkspaceProbeOutcome): WorkspaceProbeOutcome {
  _cache.set(key, { at: Date.now(), outcome });
  return outcome;
}

async function resolveCommandUrlFor(nodeId: string): Promise<string | undefined> {
  const node = await loadExecutorNode(nodeId).catch(() => null);
  if (!node) return undefined;
  return resolveExecutorCommandUrl(node.connectConfig);
}

/**
 * 最近窗口内的**注册表选择**次数（不含 URL 硬钉与手工放置）。
 *
 * 为什么直接查台账而不是在内存里计数：网关重启就丢，且内存计数无法事后复算
 * ——而"为什么选了它"必须能被第三方从持久记录里重算出来。
 */
export async function _recentSelectionCounts(
  windowMinutes = ROTATION_WINDOW_MINUTES(),
): Promise<Record<string, number>> {
  try {
    const db = getDb();
    const rows = await db.query<{ node_id: string; n: string | number }>(
      `SELECT node_id, count(*) AS n FROM scheduler_decisions
        WHERE kind = 'executor_selection' AND reason = 'executor_registry'
          AND node_id IS NOT NULL
          AND created_at > now() - make_interval(mins => $1)
        GROUP BY node_id`,
      [windowMinutes],
    );
    return Object.fromEntries(rows.rows.map(row => [row.node_id, Number(row.n) || 0]));
  } catch {
    // 台账读不到**不能**变成"没有路由"：当作空计数（等价于纯序选择），并让调用方在证据里看到。
    return {};
  }
}

export interface PlacementChoice {
  node: ExecutorNodeRecord;
  evidence: Record<string, unknown>;
}

/**
 * **节点级**失败的识别（不是任务级）。
 *
 * 为什么需要它（2026-10-11 实测）：可移植任务被轮转派到 `vultr-executor` 后**两条全失败**，
 * 原因是节点上没有任何 provider 凭据——`Provider 'deepseek' not configured
 * (Set DEEPSEEK_API_KEY or add to ~/.los/accounts/)`。这在派发**之前**是看不见的
 * （节点心跳正常、`run_agent` 能力为 true、命令通道也能跑），只能从**失败台账**里学。
 *
 * 判据是"节点自身的问题"，不是"这个任务没写好"：只匹配节点/环境级错误，
 * 任务级失败（模型答得不对、验证不过）**不得**让节点被降权。
 */
const NODE_LEVEL_FAILURE_PATTERNS: Array<{ id: string; re: RegExp }> = [
  { id: 'provider_not_configured', re: /Provider '.*' not configured|API_KEY.*not (?:set|configured)/i },
  { id: 'transport', re: /ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ETIMEDOUT|fetch failed|socket hang up/i },
  { id: 'auth', re: /unauthorized|\b401\b|invalid api key/i },
  { id: 'draining', re: /executor_draining|draining/i },
  { id: 'no_shell', re: /cmd\.exe.*ENOENT|command not found|no such file or directory: .*cmd\.exe/i },
];

export function _classifyNodeFailure(message: string | null | undefined): string | undefined {
  const text = message ?? '';
  return NODE_LEVEL_FAILURE_PATTERNS.find(pattern => pattern.re.test(text))?.id;
}

/**
 * 回看窗口内**出过节点级失败**的节点。
 *
 * 与轮转计数同一个哲学：状态不另存，**台账即状态**（`task_runs` 是唯一真源），
 * 因此"为什么这个节点这轮没被选"可以从库里复算。
 */
export async function _recentUnavailableNodes(
  windowMinutes = NODE_FAILURE_WINDOW_MINUTES(),
): Promise<Record<string, string>> {
  try {
    const db = getDb();
    const rows = await db.query<{ node_id: string; error: string | null }>(
      `SELECT DISTINCT ON (node_id) node_id, metadata_json->>'error' AS error
         FROM task_runs
        WHERE status = 'failed' AND node_id IS NOT NULL
          AND created_at > now() - make_interval(mins => $1)
        ORDER BY node_id, created_at DESC`,
      [windowMinutes],
    );
    const out: Record<string, string> = {};
    for (const row of rows.rows) {
      const reason = _classifyNodeFailure(row.error);
      if (reason) out[row.node_id] = reason;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * 在**已通过能力/维护窗口/压力过滤**的候选上做核实 + 轮转。
 *
 * 返回 null 只在 `ordered` 为空时发生（调用方另有错误路径处理）。
 */
export async function choosePlacement(input: {
  ordered: readonly ExecutorNodeRecord[];
  workspaceRoot?: string;
  workspacePolicy?: WorkspacePolicy;
  placementPolicy?: PlacementPolicy;
  agentKey?: string;
  /** 最多探测几个候选（按既有健康序取前 N）：探测在派发路径上，必须封顶。 */
  maxProbes?: number;
}): Promise<PlacementChoice | null> {
  const ordered = [...input.ordered];
  if (ordered.length === 0) return null;

  const policy = input.placementPolicy ?? _normalizePlacementPolicy(undefined);
  const workspacePolicy = input.workspacePolicy ?? _normalizeWorkspacePolicy(undefined);
  const capacitySnapshot = snapshotCapacity(ordered);

  // 'health'：保持 2026-10-11 之前的行为（只把 capacity 快照补上，供事后复核）。
  if (policy === 'health') {
    return {
      node: ordered[0]!,
      evidence: {
        policy,
        workspacePolicy,
        workspaceRoot: input.workspaceRoot ?? null,
        basis: 'health_order',
        eligibleRanked: ordered.map(node => node.nodeId),
        capacity: capacitySnapshot,
      },
    };
  }

  const workspaceRoot = normalizeOptionalString(input.workspaceRoot);

  // 没声明工作区、也不是 portable ⇒ 没有"要核实的东西"。
  // 直接走既有健康序：既省掉一轮无意义的网络探测（探测在派发路径上），
  // 也避免把"没声明"误解成"工作区不存在"。
  if (!workspaceRoot && workspacePolicy !== 'portable') {
    return {
      node: ordered[0]!,
      evidence: {
        policy,
        workspacePolicy,
        workspaceRoot: null,
        basis: 'no_workspace_declared',
        eligibleRanked: ordered.map(node => node.nodeId),
        capacity: capacitySnapshot,
        chosen: ordered[0]!.nodeId,
      },
    };
  }

  const maxProbes = Math.min(input.maxProbes ?? MAX_PROBES(), ordered.length);
  const targets = ordered.slice(0, maxProbes);
  const probes = await Promise.all(targets.map(node => _probeNodeWorkspace({
    nodeId: node.nodeId,
    workspaceRoot: workspaceRoot ?? '',
    agentKey: input.agentKey,
    // 候选记录里就带着端点 ⇒ 不必再查一次注册表（探测在派发路径上，省一次往返）。
    commandUrl: resolveExecutorCommandUrl(node.connectConfig),
  })));

  const byNode = new Map(probes.map(probe => [probe.nodeId, probe]));
  const recent = await _recentSelectionCounts();
  const unavailable = await _recentUnavailableNodes();

  // 'portable'：任务声明自己不依赖工作区文件 ⇒ 只要**可达**就算通过。
  // 'verify'：必须证明工作区在节点本地存在。
  // 两者之上还有一条：**刚出过节点级失败的节点不参与轮转**（探测查不出"节点上有没有
  // provider 凭据"，但失败台账查得出——实测 vultr 心跳/命令都正常，agent 一跑就失败）。
  const verified = ordered.filter((node) => {
    const probe = byNode.get(node.nodeId);
    if (!probe) return false; // 没探到（超出 maxProbes）⇒ 不参与轮转
    if (!probe.reachable) return false;
    if (unavailable[node.nodeId]) return false;
    return workspacePolicy === 'portable' ? true : probe.present;
  });

  const base = {
    policy,
    workspacePolicy,
    workspaceRoot: workspaceRoot ?? null,
    probes: probes.map(probe => ({
      nodeId: probe.nodeId,
      reachable: probe.reachable,
      present: probe.present,
      revision: probe.revision ?? null,
      durationMs: probe.durationMs,
      cached: probe.cached === true,
      error: probe.error ?? null,
    })),
    recentSelections: recent,
    recentUnavailableNodes: unavailable,
    verifiedNodeIds: verified.map(node => node.nodeId),
    eligibleRanked: ordered.map(node => node.nodeId),
    capacity: capacitySnapshot,
  };

  if (verified.length === 0) {
    return {
      node: ordered[0]!,
      evidence: {
        ...base,
        basis: 'probe_fallback_health',
        chosen: ordered[0]!.nodeId,
      },
    };
  }

  // 轮转：先比"最近窗口内被选次数"，同票保持既有健康序（稳定、可复算）。
  const ranked = [...verified].sort((a, b) => {
    const delta = (recent[a.nodeId] ?? 0) - (recent[b.nodeId] ?? 0);
    if (delta !== 0) return delta;
    return ordered.indexOf(a) - ordered.indexOf(b);
  });
  const node = ranked[0]!;
  return {
    node,
    evidence: {
      ...base,
      basis: verified.length === 1 ? 'single_verified' : 'verified_rotation',
      rotationOrder: ranked.map(item => item.nodeId),
      chosen: node.nodeId,
      chosenRecentSelections: recent[node.nodeId] ?? 0,
    },
  };
}

function snapshotCapacity(nodes: readonly ExecutorNodeRecord[]): Record<string, unknown> {
  return Object.fromEntries(nodes.map((node) => {
    const capacity = readObject(node.capacity);
    return [node.nodeId, {
      memoryAvailableMb: capacity.memoryAvailableMb ?? null,
      memoryTotalMb: capacity.memoryTotalMb ?? null,
      psiIoFull: capacity.psiIoFull ?? null,
      resourceClass: node.resourceClass ?? null,
      queueDepth: node.queueDepth ?? null,
      activeTaskCount: node.activeTaskCount ?? null,
      status: node.status,
      version: node.version ?? null,
      lastHeartbeatAt: node.lastHeartbeatAt ?? null,
      warnings: node.execution?.warnings ?? [],
    }];
  }));
}
