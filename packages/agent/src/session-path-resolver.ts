/**
 * session-path-resolver.ts — 会话 `cwd` 的路径分裂解析（三态）。
 *
 * 依据：ADR 0047 第 1 节 R3（真相优先级）+ B3.3 出口判据：
 *   「映射表缺失时降级为 `unknown` 而**非静默丢弃**」。
 *
 * ## 为什么这里有一份 TS 版（与 tools/lib/session-path-resolver.mjs 并存）
 * `.mjs` 那份服务于 **build-time 检具**（`tools/*.mjs`，直接 `node` 跑，不经 tsx），
 * 本文件服务于 **runtime**（`@los/agent` 的投射）。两份并存是**有意的边界**：
 * 检具不该依赖构建产物，运行时不该依赖 tools/。
 * **代价是可能漂移** ⇒ 由 `session-path-resolver.test.ts` 的一致性测试锁住
 * （同一组夹具下两份实现必须给出相同三态）。
 *
 * ## 三态
 * | 态 | 含义 | 消费方 |
 * | --- | --- | --- |
 * | `current` | cwd 已在当前根下 | 直接归项目 |
 * | `resolved` | 命中声明/验证过的映射 | 归到**映射后的**项目 |
 * | `unknown` | 既不在当前根下、也无法映射 | **标 unknown 并保留**，绝不丢弃 |
 *
 * `unknown` 的两种来源都归 `unknown`，但原因不同、**必须可分辨**：
 *   · `no-map`   —— 映射表缺失/不可读 ⇒ **不能假装它不在迁移范围内**
 *   · `unmapped` —— 映射表在，但没有这条 cwd 的条目
 */

export type ResolutionState = 'current' | 'resolved' | 'unknown';

export interface AliasEntry { from: string; to: string; basis?: string; declaredBy?: string }
export interface AliasMap { version?: number; verified?: AliasEntry[]; declared?: AliasEntry[] }

export interface SessionCwdResolution {
  state: ResolutionState;
  target: string | null;
  reason: string | null;
  basis: string | null;
}

const norm = (p: unknown): string => String(p ?? '').replace(/\/+$/, '');

/** 解析一条 cwd（纯函数）。`aliasMap: null` = 映射表缺失，**不是**"无映射"。 */
export function resolveSessionCwd(
  cwd: string,
  opts: { currentRoot: string; aliasMap: AliasMap | null },
): SessionCwdResolution {
  const c = norm(cwd);
  const root = norm(opts.currentRoot);

  if (root && (c === root || c.startsWith(root + '/'))) {
    return { state: 'current', target: c, reason: null, basis: null };
  }

  if (!opts.aliasMap) {
    return {
      state: 'unknown', target: null,
      reason: 'no-map: alias map unavailable — cannot tell "not migrated" from "map not read"',
      basis: null,
    };
  }

  const entries = [...(opts.aliasMap.verified ?? []), ...(opts.aliasMap.declared ?? [])];
  const hit = entries.find((e) => norm(e.from) === c);
  if (hit) {
    return {
      state: 'resolved', target: norm(hit.to), reason: null,
      basis: hit.basis ?? (hit.declaredBy ? `declared-by-${hit.declaredBy}` : 'unknown-basis'),
    };
  }

  return {
    state: 'unknown', target: null,
    reason: 'unmapped: alias map present but has no entry for this cwd',
    basis: null,
  };
}

/** 批量解析，并给出可入账的汇总。`unknownCwds` 是**必须保留**的证据清单。 */
export function resolveSessionCwds(
  cwds: string[],
  opts: { currentRoot: string; aliasMap: AliasMap | null },
): {
  results: Array<SessionCwdResolution & { cwd: string }>;
  byState: Record<ResolutionState, number>;
  unknownCwds: Array<{ cwd: string; reason: string | null }>;
} {
  const results: Array<SessionCwdResolution & { cwd: string }> = [];
  const byState: Record<ResolutionState, number> = { current: 0, resolved: 0, unknown: 0 };
  const unknownCwds: Array<{ cwd: string; reason: string | null }> = [];
  for (const cwd of cwds) {
    const r = resolveSessionCwd(cwd, opts);
    byState[r.state] += 1;
    results.push({ cwd, ...r });
    if (r.state === 'unknown') unknownCwds.push({ cwd, reason: r.reason });
  }
  return { results, byState, unknownCwds };
}
