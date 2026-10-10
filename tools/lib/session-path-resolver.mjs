/**
 * session-path-resolver.mjs — 会话 `cwd` 的路径分裂解析（三态）。
 *
 * 依据：ADR 0047 第 1 节 R3（真相优先级）+ B3.3 出口判据：
 *   「映射表缺失时降级为 `unknown` 而**非静默丢弃**」。
 *
 * ## 背景
 * 本机项目根从 `~/syncthing/project/*` 迁到 `~/syncfolder/project/*`（2026-08-14 →
 * 08-27 旧根，08-30 起新根，无重叠），但 DSH 的历史会话 `cwd` 仍指旧路径。三条旧根
 * **磁盘上均已不存在** ⇒ "旧→新"无法机械验证，只能**人工声明**
 *（见 `tools/path-split-report.mjs` 的 `DECLARED_MIGRATIONS`）。
 *
 * ## 三态（这是本模块存在的主要理由）
 * | 态 | 含义 | 消费方该怎么用 |
 * | --- | --- | --- |
 * | `current` | cwd 已在当前根下 | 直接归项目 |
 * | `resolved` | 命中声明/验证过的映射 | 归到**映射后的**项目 |
 * | `unknown` | 既不在当前根下、也无法映射 | **标 unknown 并保留**，绝不丢弃 |
 *
 * `unknown` 的两种来源要分清（都归 `unknown`，但原因不同）：
 *   · `no-map`     —— 映射表缺失/不可读 ⇒ **不能假装它不在迁移范围内**
 *   · `unmapped`   —— 映射表在，但没有这条 cwd 的条目
 *
 * 关键纪律：**"没读到映射表" ≠ "没有需要映射的会话"**。把前者当后者，就会把
 * 214 条历史会话静默丢掉（这正是本判据要防的）。
 */

/** 三态之一。 */
export const RESOLUTION_STATES = ['current', 'resolved', 'unknown'];

/**
 * 解析一条 cwd（纯函数）。
 *
 * @param {string} cwd
 * @param {object} opts
 * @param {string} opts.currentRoot  当前项目根（如 ~/syncfolder/project）
 * @param {object|null} opts.aliasMap 别名表（schemaVersion 2：{verified,declared}）；
 *                                    **null/不可读 = 映射表缺失**，不是"无映射"
 * @returns {{state:'current'|'resolved'|'unknown', target:string|null, reason:string|null, basis:string|null}}
 */
export function resolveSessionCwd(cwd, { currentRoot, aliasMap }) {
  const norm = (p) => String(p ?? '').replace(/\/+$/, '');
  const c = norm(cwd);
  const root = norm(currentRoot);

  // ① 已在当前根下 —— 无需映射
  if (root && (c === root || c.startsWith(root + '/'))) {
    return { state: 'current', target: c, reason: null, basis: null };
  }

  // ② 映射表缺失 ⇒ **明示 unknown（no-map）**，不当作"无映射需求"
  if (!aliasMap) {
    return {
      state: 'unknown', target: null,
      reason: 'no-map: alias map unavailable — cannot tell "not migrated" from "map not read"',
      basis: null,
    };
  }

  // ③ 映射表在 ⇒ 查 verified（机械可验证）与 declared（人工声明）
  const entries = [...(aliasMap.verified ?? []), ...(aliasMap.declared ?? [])];
  const hit = entries.find((e) => norm(e.from) === c);
  if (hit) {
    return {
      state: 'resolved', target: norm(hit.to),
      reason: null,
      basis: hit.basis ?? (hit.declaredBy ? `declared-by-${hit.declaredBy}` : 'unknown-basis'),
    };
  }

  // ④ 映射表在但没这条 ⇒ unknown（unmapped）
  return {
    state: 'unknown', target: null,
    reason: 'unmapped: alias map present but has no entry for this cwd',
    basis: null,
  };
}

/**
 * 批量解析，并给出**可入账的汇总**（消费方直接用它，避免各自统计口径不一致）。
 *
 * `unmappedCwds` 是**必须保留**的清单 —— 它是"哪些历史无法归属"的证据，
 * 不是可以丢掉的日志。
 */
export function resolveSessionCwds(cwds, opts) {
  const results = [];
  const byState = { current: 0, resolved: 0, unknown: 0 };
  const unknown = [];
  for (const cwd of cwds) {
    const r = resolveSessionCwd(cwd, opts);
    byState[r.state] += 1;
    results.push({ cwd, ...r });
    if (r.state === 'unknown') unknown.push({ cwd, reason: r.reason });
  }
  return { results, byState, unknownCwds: unknown };
}

/**
 * 自检（负向控制为主）。判据的核心是：**"映射表缺失"绝不能被当成
 * "无需映射"**，否则历史会话会被静默丢掉。
 */
export function selfTest() {
  let fail = 0;
  const eq = (label, got, want) => {
    const a = JSON.stringify(got); const b = JSON.stringify(want);
    if (a !== b) { console.error(`FAIL ${label}\n  got ${a}\n  want ${b}`); fail++; }
  };
  const root = '/NEW/project';
  const map = {
    version: 2,
    verified: [{ from: '/OLD/project/x', to: '/NEW/project/x', basis: 'same-leaf' }],
    declared: [{ from: '/GONE/project/y', to: '/NEW/project/y', basis: 'reloc', declaredBy: 'operator' }],
  };
  // 三态
  eq('current', resolveSessionCwd('/NEW/project/a', { currentRoot: root, aliasMap: map }).state, 'current');
  eq('resolved via verified', resolveSessionCwd('/OLD/project/x', { currentRoot: root, aliasMap: map }).state, 'resolved');
  eq('resolved via declared', resolveSessionCwd('/GONE/project/y', { currentRoot: root, aliasMap: map }).state, 'resolved');
  eq('resolved target', resolveSessionCwd('/GONE/project/y', { currentRoot: root, aliasMap: map }).target, '/NEW/project/y');
  eq('unknown when unmapped', resolveSessionCwd('/ELSEWHERE/z', { currentRoot: root, aliasMap: map }).state, 'unknown');
  eq('trailing slash normalized', resolveSessionCwd('/OLD/project/x/', { currentRoot: root, aliasMap: map }).state, 'resolved');

  // ★ 核心负向：映射表缺失
  const noMap = resolveSessionCwd('/GONE/project/y', { currentRoot: root, aliasMap: null });
  eq('NEGATIVE: missing map => unknown', noMap.state, 'unknown');
  eq('NEGATIVE: missing map is never current', noMap.state === 'current', false);
  eq('NEGATIVE: missing map reason distinguishable', /no-map/.test(noMap.reason), true);
  eq('unmapped reason distinguishable from no-map', /unmapped/.test(
    resolveSessionCwd('/ELSEWHERE/z', { currentRoot: root, aliasMap: map }).reason), true);

  // ★ 核心负向：批量时一条都不能少
  const many = Array.from({ length: 214 }, (_, i) => `/GONE/project/r${i}`);
  const b = resolveSessionCwds(many, { currentRoot: root, aliasMap: null });
  eq('NEGATIVE: all 214 kept as unknown', b.byState.unknown, 214);
  eq('NEGATIVE: none dropped', b.results.length, 214);
  eq('NEGATIVE: unknown list preserved', b.unknownCwds.length, 214);

  const mixed = resolveSessionCwds(['/NEW/project/a', '/OLD/project/x', '/ELSEWHERE/z'], { currentRoot: root, aliasMap: map });
  eq('byState counts', mixed.byState, { current: 1, resolved: 1, unknown: 1 });

  if (fail) { console.error(`\nself-test: ${fail} failure(s)`); process.exit(1); }
  console.log('self-test OK: 14 assertions (4 core negative controls)');
  process.exit(0);
}
