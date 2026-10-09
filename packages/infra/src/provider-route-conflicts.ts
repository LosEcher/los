/**
 * provider-route-conflicts.ts — provider 路由的「冲突可见化」。
 *
 * 依据：ADR 0047 第 2 节 (c) —— **禁止静默覆盖**。
 *
 * 问题（2026-10-08 实测）：`mergeDiscoveredProviders` 里 cc-switch 的 `is_current`
 * 会把它的 baseUrl/model/apiShape/apiKey **直接覆盖**掉 config 里已有的值
 * （`config-sources.ts:148` 的注释原文：`active cc-switch accounts overwrite`），
 * 但覆盖**不留任何痕迹** ⇒ 事后无法回答"某个 provider 的 baseUrl 是谁定的、
 * 有没有被别的决策中心改过"。这正是分析文档里的 A1 事故形态：
 * 「切了 provider 但没生效，而没有任何面能判定谁对」。
 *
 * 本模块把"覆盖"变成"**可见的冲突记录**"：
 *   · 仍然是 cc-switch（prefer）赢 —— 不改现有优先级语义（那是 operator 的选择）
 *   · 但每一次**值不同**的覆盖都记一条 `ProviderRouteConflict`
 *   · 同一来源的重复声明（source 相同）不算冲突，只算冗余
 *
 * 纪律：本模块**纯函数**，不读磁盘、不写状态；由调用方决定如何呈现/落库。
 */

export type ProviderRouteField = 'apiKey' | 'baseUrl' | 'model' | 'apiShape';

/** 会被 prefer 覆盖的字段（顺序即比较顺序）。 */
export const OVERRIDABLE_FIELDS: readonly ProviderRouteField[] = ['apiKey', 'baseUrl', 'model', 'apiShape'];

export interface ProviderRouteConflict {
  provider: string;
  field: ProviderRouteField;
  /** 被覆盖掉的值。**apiKey 一律记 `<redacted>`**，绝不落明文。 */
  previous: string;
  next: string;
  /** 谁赢（本次覆盖的来源）。 */
  winnerSource: string;
  /** 谁被覆盖（原值的来源，未知则 null）。 */
  loserSource: string | null;
  /** 归属层（ADR 0047 第 1 节）：桌面工具由 cc-switch 管。 */
  ownerLayer: 'cc-switch-desktop' | 'discovery' | 'config';
}

/**
 * 决策中心命名空间：`cc-switch/codex/PackyCode` 与 `cc-switch` 同属 **cc-switch**。
 *
 * 为什么需要：实测（2026-10-08）cc-switch 的 codex 路由（`api-slb.packyapi.com`）与
 * grokbuild 路由（`cf.api.fan`）**本来就指向不同端点** —— 那是**合理路由，不是冲突**。
 * 按完整 source 字符串比较会把它们误报成冲突。
 *
 * 冲突的语义是「**跨决策中心的覆盖**」（例如 operator 的 yaml 被 cc-switch 覆盖），
 * 同命名空间内的差异只记为 `sameCenterVariants`（信息级，供查证）。
 */
export function sourceNamespace(source: string): string {
  if (!source) return '(unknown)';
  if (source.startsWith('cc-switch')) return 'cc-switch';
  if (source.startsWith('env:')) return 'env';
  return source.split('/')[0] ?? source;
}

/** apiKey 永不落明文。 */
function safeValue(field: ProviderRouteField, value: unknown): string {
  if (field === 'apiKey') return '<redacted>';
  return typeof value === 'string' ? value : String(value);
}

/**
 * 计算一次合并中产生的路由冲突。
 *
 * @param existing      当前 providers 表（合并前）
 * @param incoming      本期要合并的 discovered provider
 * @param prefer        该 discovered 是否带 prefer（cc-switch is_current）
 * @returns 冲突列表（**只报告值确实不同且非空**的覆盖）
 */
export function detectRouteConflicts(input: {
  provider: string;
  existing: Record<string, unknown> | undefined;
  incoming: {
    baseUrl?: string; model?: string; apiShape?: string; apiKey?: string;
    source: string; sourceTool?: string;
  };
  prefer: boolean;
  /** existing 的来源（若有），用于标注 loser 侧。默认取 existing.source。 */
  existingSource?: string | null;
}): ProviderRouteConflict[] {
  return detectRouteRouting(input).conflicts;
}

export interface RouteRoutingReport {
  /** **跨决策中心**的覆盖 ⇒ 真冲突，应可见/可告警。 */
  conflicts: ProviderRouteConflict[];
  /** **同决策中心内**的差异（如 cc-switch 的 codex vs grokbuild 路由）⇒ 信息级，不告警。 */
  sameCenterVariants: ProviderRouteConflict[];
  /** 因字段不可判等（apiKey 已脱敏）而 **无法判定** 的覆盖 ⇒ 明示未验证，不当作无冲突。 */
  unverifiable: Array<{ provider: string; field: ProviderRouteField; reason: string }>;
}

/**
 * 区分「跨中心冲突」/「同中心差异」/「不可判定」。
 * 用 `detectRouteConflicts` 拿 conflicts；需要完整三态时用本函数。
 */
export function detectRouteRouting(input: {
  provider: string;
  existing: Record<string, unknown> | undefined;
  incoming: {
    baseUrl?: string; model?: string; apiShape?: string; apiKey?: string;
    source: string; sourceTool?: string;
  };
  prefer: boolean;
  existingSource?: string | null;
}): RouteRoutingReport {
  const { provider, existing, incoming, prefer } = input;
  const report: RouteRoutingReport = { conflicts: [], sameCenterVariants: [], unverifiable: [] };
  if (!prefer || !existing) return report;

  const winnerSource = incoming.sourceTool === 'cc-switch' || incoming.source.startsWith('cc-switch/')
    ? 'cc-switch'
    : incoming.source;
  const existingSource = input.existingSource !== undefined
    ? input.existingSource
    : (typeof existing.source === 'string' ? existing.source : null);

  for (const field of OVERRIDABLE_FIELDS) {
    const next = (incoming as Record<string, unknown>)[field];
    const prev = existing[field];
    if (typeof next !== 'string' || next.length === 0) continue;   // 无新值 → 不覆盖
    if (typeof prev !== 'string' || prev.length === 0) continue;   // 原本为空 → 首次填充，不算冲突
    if (prev === next) continue;                                   // 值相同 → 不冲突

    const record: ProviderRouteConflict = {
      provider,
      field,
      previous: safeValue(field, prev),
      next: safeValue(field, next),
      winnerSource,
      loserSource: existingSource,
      ownerLayer: winnerSource === 'cc-switch' ? 'cc-switch-desktop' : 'discovery',
    };

    // 同决策中心内 ⇒ 记信息级副本，不告警
    if (existingSource && sourceNamespace(existingSource) === sourceNamespace(winnerSource)) {
      report.sameCenterVariants.push(record);
      continue;
    }

    // apiKey：两侧都被脱敏成 <redacted> ⇒ 判据本身不可判等，明示"无法判定"而不是当作无冲突
    if (field === 'apiKey') {
      report.unverifiable.push({ provider, field, reason: 'apiKey is redacted on both sides; equality is not decidable' });
      report.conflicts.push(record);
      continue;
    }

    report.conflicts.push(record);
  }
  return report;
}

/** 把多条冲突折成一行摘要（供日志/日报）。 */
export function summarizeConflicts(conflicts: readonly ProviderRouteConflict[]): string {
  if (!conflicts.length) return 'no provider route conflicts';
  const byProvider = new Map<string, string[]>();
  for (const c of conflicts) {
    if (!byProvider.has(c.provider)) byProvider.set(c.provider, []);
    byProvider.get(c.provider)!.push(`${c.field}:${c.loserSource ?? '?'}→${c.winnerSource}`);
  }
  return [...byProvider.entries()].map(([p, fs]) => `${p}(${fs.join(', ')})`).join('; ');
}
