#!/usr/bin/env node
/**
 * path-split-report.mjs — 路径分裂报告 + alias map 生成（只读）。
 *
 * 背景（2026-10-08 盘点）：本机项目根从 `~/syncthing/project/*` 迁到
 * `~/syncfolder/project/*`，但 DSH 的历史会话 cwd 仍指旧路径：
 *   ~/syncthing/project/*   : 214 条会话，2026-08-14 → 2026-08-27（无重叠）
 *   ~/syncfolder/project/*  : 328 条会话，2026-08-30 → 2026-10-08
 * 而 `~/.dsh/storages/session-index.db` 按 `cwd` 归项目 ⇒ 旧路径的历史无法与
 * 今天的仓关联。本脚本产出映射，供 P1 的只读读模型在归项目时使用。
 *
 * 依据：ADR 0047 第 1 节 R3（真相优先级）与 J7（投影必须标明 canonical 源）；
 *       批次文档 2026-10-08-p1-cross-project-observability.md（A6 风险）。
 *
 * 纪律：
 *   - **只读**；不改任何东西（写入 alias map 需显式 --write）
 *   - 映射必须**可验证**：只对"旧路径不存在 / 新路径存在 / 末段名相同"的候选给映射
 *   - 无法映射的历史**不得丢弃**：报告为 unmapped，读模型的降级行为是标 `unknown`
 *
 * 用法：
 *   node tools/path-split-report.mjs                 # 报告
 *   node tools/path-split-report.mjs --json
 *   node tools/path-split-report.mjs --write         # 写 ~/.dsh/storages/path-alias-map.json
 *   node tools/path-split-report.mjs --self-test     # 负向控制（纯函数）
 */
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

const HOME = homedir();
const INDEX = join(HOME, '.dsh', 'storages', 'session-index.db');
const ALIAS_MAP = join(HOME, '.dsh', 'storages', 'path-alias-map.json');
const NEW_ROOT = join(HOME, 'syncfolder', 'project');

/**
 * 已知的**历史项目根**（2026-10-08 实测：三者磁盘上均已不存在，但 session-index
 * 里仍有会话 cwd 指向它们 ⇒ 必须显式登记，否则这些历史的归属不可判）。
 * 顺序无关；匹配时取最长前缀。
 */
const HISTORY_ROOTS = [
  join(HOME, 'syncthing', 'project'),        // 214 sessions, 2026-08-14 → 08-27
  join(HOME, 'Downloads', 'projects'),       // cantool 25 / dsh 45 / lzlyx 36
  join(HOME, 'projects'),                    // los-workspace/projects/los 23
];

/**
 * **人工声明的迁移**（declared）：旧路径已不在盘上时，"旧→新"无法机械验证，
 * 只能由人声明。声明必须带 basis 与 declaredBy，并与机械推导的映射**分开存放**，
 * 使读模型能区分"已验证"与"已声明"。**禁止把声明伪装成推导。**
 */
const DECLARED_MIGRATIONS = [
  // 旧根整体搬迁：/Users/echerlos/syncthing/project  →  /Users/echerlos/syncfolder/project
  { fromRoot: join(HOME, 'syncthing', 'project'),  toRoot: NEW_ROOT,
    basis: 'root-relocation-2026-08-28', declaredBy: 'operator', declaredAt: '2026-10-08' },
  // 逐项搬迁：~/Downloads/projects/X → ~/syncfolder/project/X
  { fromRoot: join(HOME, 'Downloads', 'projects'), toRoot: NEW_ROOT,
    basis: 'root-relocation-per-project', declaredBy: 'operator', declaredAt: '2026-10-08' },
  // ~/projects/los-workspace/projects/los → ~/syncfolder/project/los-workspace/projects/los
  { fromRoot: join(HOME, 'projects'),              toRoot: join(NEW_ROOT, 'los-workspace', 'projects', '..', '..'),
    basis: 'los-workspace-relocation', declaredBy: 'operator', declaredAt: '2026-10-08' },
];

/** 找到 cwd 命中的最长历史根。 */
export function matchHistoryRoot(cwd, roots) {
  let best = null;
  for (const r of roots) {
    const norm = r.replace(/\/+$/, '');
    if (cwd === norm || cwd.startsWith(norm + '/')) {
      if (!best || norm.length > best.length) best = norm;
    }
  }
  return best;
}

/**
 * 纯函数：由 (cwd 列表, 历史根列表, 新根, 声明表) 推导映射。
 *
 * 两类映射**分开存放**：
 *   verified : 旧路径仍在盘上 + 新路径在盘上 + 末段一致  ⇒ 机械可验证
 *   declared : 旧路径已不在盘上，但有**人工声明**的根级迁移 ⇒ 只能声明，不得伪装成推导
 * 其余进 unmapped（读模型降级为 unknown，**不得丢弃**）。
 */
export function buildAliasMap({ cwds, roots, newRoot, declared = [], existsFn }) {
  const verified = [], declaredOut = [], unmapped = [];
  const norm = p => p.replace(/\/+$/, '');
  const nRoot = norm(newRoot);

  for (const raw of cwds) {
    const p = norm(raw);
    // 已在当前根下 ⇒ 无需映射（它不是迁移源）
    if (p === nRoot || p.startsWith(nRoot + '/')) { continue; }
    const hit = matchHistoryRoot(p, roots);
    if (!hit) { unmapped.push({ path: p, reason: 'not-under-any-history-root' }); continue; }
    const rest = p.slice(hit.length + 1);

    // ① 优先机械验证（旧路径必须还在盘上）
    if (existsFn(p)) {
      const candidate = `${nRoot}/${rest}`;
      const lastOld = rest.split('/').pop(), lastNew = norm(candidate).split('/').pop();
      if (lastOld !== lastNew) { unmapped.push({ path: p, reason: 'leaf-name-mismatch' }); continue; }
      if (!existsFn(candidate)) { unmapped.push({ path: p, reason: 'new-path-absent-on-disk', candidate }); continue; }
      verified.push({ from: p, to: candidate, basis: 'same-leaf-under-sibling-root' });
      continue;
    }

    // ② 旧路径已不在盘上 ⇒ 查声明表（根级前缀匹配）
    const dec = declared.find(d => hit === norm(d.fromRoot));
    if (dec) {
      const to = `${norm(dec.toRoot)}/${rest}`;
      declaredOut.push({ from: p, to, basis: dec.basis, declaredBy: dec.declaredBy, declaredAt: dec.declaredAt,
        note: existsFn(to) ? 'target-exists' : 'target-absent' });
    } else {
      unmapped.push({ path: p, reason: 'old-path-absent-on-disk' });
    }
  }
  return { version: 2, generatedFrom: { roots: roots.map(norm), newRoot: nRoot }, verified, declared: declaredOut, unmapped };
}

function queryCwds() {
  if (!existsSync(INDEX)) return null;
  try {
    const out = execFileSync('sqlite3', ['-readonly', INDEX,
      `SELECT cwd || '|' || count(*) || '|' || min(datetime(created_at/1000,'unixepoch','localtime')) || '|' || max(datetime(created_at/1000,'unixepoch','localtime')) FROM sessions GROUP BY cwd ORDER BY cwd;`],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30_000 });
    return out.split('\n').filter(Boolean).map(l => {
      const [cwd, n, first, last] = l.split('|');
      return { cwd, sessions: Number(n), first, last };
    });
  } catch { return null; }
}

function selfTest() {
  let fail = 0;
  const eq = (label, got, want) => {
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      console.error(`self-test FAILED: ${label}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`); fail++;
    }
  };
  const oldRoot = '/old/project', newRoot = '/new/project';
  const exists = list => p => list.includes(p.replace(/\/+$/, ''));

  // 正向：旧在盘上 + 新在盘上 + 末段一致 ⇒ verified
  let r = buildAliasMap({ cwds: ['/old/project/alpha'], roots: [oldRoot], newRoot, existsFn: exists(['/old/project/alpha', '/new/project/alpha']) });
  eq('verified when both exist', r.verified.map(v => v.to), ['/new/project/alpha']);
  eq('verified is not declared', r.declared.length, 0);

  // 负向 1：旧不在盘上且**无声明** ⇒ unmapped（不猜）
  r = buildAliasMap({ cwds: ['/old/project/gone'], roots: [oldRoot], newRoot, existsFn: exists(['/new/project/gone']) });
  eq('unmapped without declaration', r.unmapped.map(u => u.reason), ['old-path-absent-on-disk']);
  eq('no invented mapping', r.verified.length + r.declared.length, 0);

  // 负向 2：旧不在盘上但**有声明** ⇒ declared（且与 verified 分开）
  r = buildAliasMap({ cwds: ['/old/project/gone'], roots: [oldRoot], newRoot,
    declared: [{ fromRoot: oldRoot, toRoot: newRoot, basis: 'b', declaredBy: 'op', declaredAt: 'd' }],
    existsFn: exists(['/new/project/gone']) });
  eq('declared when old absent but declared', r.declared.map(d => d.to), ['/new/project/gone']);
  eq('declared carries provenance', [r.declared[0].basis, r.declared[0].declaredBy], ['b', 'op']);
  eq('declared not in verified', r.verified.length, 0);

  // 负向 3：新路径也不存在 ⇒ declared 但标 target-absent（诚实）
  r = buildAliasMap({ cwds: ['/old/project/gone'], roots: [oldRoot], newRoot,
    declared: [{ fromRoot: oldRoot, toRoot: newRoot, basis: 'b', declaredBy: 'op', declaredAt: 'd' }], existsFn: () => false });
  eq('declared marks target-absent', r.declared[0].note, 'target-absent');

  // 负向 4：不在任何历史根下 ⇒ 不参与
  r = buildAliasMap({ cwds: ['/elsewhere/y'], roots: [oldRoot], newRoot, existsFn: () => true });
  eq('outside all roots', r.unmapped.map(u => u.reason), ['not-under-any-history-root']);

  // 当前根下的 cwd 不得进 unmapped（它不是迁移源）
  r = buildAliasMap({ cwds: ['/new/project/already-here'], roots: [oldRoot], newRoot, existsFn: () => true });
  eq('current-root cwd produces nothing', [r.verified.length, r.declared.length, r.unmapped.length], [0, 0, 0]);

  // 最长前缀优先（防 ~/projects 抢走 ~/projects/los-workspace/...）
  eq('longest prefix wins', matchHistoryRoot('/a/b/c/d', ['/a/b', '/a/b/c']), '/a/b/c');
  eq('exact root matches', matchHistoryRoot('/a/b', ['/a/b']), '/a/b');
  eq('no match returns null', matchHistoryRoot('/x', ['/a']), null);
  eq('trailing slash tolerated', matchHistoryRoot('/a/b/c', ['/a/b/']), '/a/b');

  if (fail) { console.error(`\nself-test: ${fail} failure(s)`); process.exit(1); }
  console.log('self-test OK: 2 positive + 10 negative/edge assertions');
  process.exit(0);
}

const argv = process.argv.slice(2);
if (argv.includes('--self-test')) selfTest();

const cwds = queryCwds();
if (!cwds) {
  console.error('path-split-report: session-index.db unreadable or sqlite3 unavailable (this is NOT "no split")');
  process.exit(2);
}

const groups = new Map();
for (const row of cwds) {
  const hit = matchHistoryRoot(row.cwd, HISTORY_ROOTS) ?? '(current)';
  if (!groups.has(hit)) groups.set(hit, []);
  groups.get(hit).push(row);
}
const sum = rows => rows.reduce((a, r) => a + r.sessions, 0);
const window = rows => (rows.length ? { first: rows.map(r => r.first).sort()[0], last: rows.map(r => r.last).sort().slice(-1)[0] } : null);

const map = buildAliasMap({
  cwds: cwds.map(r => r.cwd),
  roots: HISTORY_ROOTS, newRoot: NEW_ROOT,
  declared: DECLARED_MIGRATIONS, existsFn: existsSync,
});

const report = {
  schemaVersion: 2,
  generatedAt: new Date().toISOString(),
  roots: { history: HISTORY_ROOTS, new: NEW_ROOT },
  declaredMigrations: DECLARED_MIGRATIONS,
  perRoot: [...groups.entries()].map(([root, rows]) => ({
    root, distinctCwds: rows.length, sessions: sum(rows), window: window(rows),
  })).sort((a, b) => b.sessions - a.sessions),
  aliasMap: map,
};

if (argv.includes('--json')) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log('path-split-report — 项目根迁移造成的路径分裂（只读）');
  console.log('═'.repeat(92));
  console.log(`当前根: ${NEW_ROOT}\n`);
  console.log('按根聚合（按 sessions 降序）:');
  for (const g of report.perRoot) {
    const w = g.window ? `${g.window.first} → ${g.window.last}` : '—';
    console.log(`  ${String(g.sessions).padStart(4)} sessions  ${String(g.distinctCwds).padStart(2)} cwds  ${g.root}`);
    console.log(`        ${w}`);
  }
  console.log(`\n── verified 映射（旧在盘上 + 新在盘上 + 末段一致）: ${map.verified.length} ──`);
  for (const m of map.verified) console.log(`  ${m.from}\n    → ${m.to}`);
  if (!map.verified.length) console.log('  (none — 历史根已全部不在盘上，机械验证不可能)');
  console.log(`\n── declared 映射（人工声明，旧路径已不在盘上）: ${map.declared.length} ──`);
  for (const m of map.declared) console.log(`  ${m.from}\n    → ${m.to}   [${m.basis} · by ${m.declaredBy} · ${m.note}]`);
  // 读模型降级面：区分"已声明可映射的迁移源"与"确实未知"。非项目 cwd（临时目录、
  // 调度报告目录等）不属于"待映射"，单列，避免把噪音当成缺口。
  const NONE_PROJECT = [/^\/private\/tmp/, /^\/private\/var\/folders/, /\.dsh\/scheduler-reports/, /\.dsh-wechat\/workspace/, /^$/, /^\/Users\/[^/]+\/Downloads\/[^/]*[\u4e00-\u9fa5]/];
  const nonProject = map.unmapped.filter(u => NONE_PROJECT.some(re => re.test(u.path)));
  const unknown = map.unmapped.filter(u => !NONE_PROJECT.some(re => re.test(u.path)));
  console.log(`\n── unmapped 未知（读模型必须降级为 unknown，不得丢弃）: ${unknown.length} ──`);
  for (const u of unknown) console.log(`  ${u.path}   [${u.reason}]`);
  if (!unknown.length) console.log('  (none)');
  console.log(`\n── 非项目 cwd（临时/调度目录等，不属待映射）: ${nonProject.length} ──`);
  for (const u of nonProject) console.log(`  ${u.path || '(empty)'}`);
}

if (argv.includes('--write')) {
  writeFileSync(ALIAS_MAP, JSON.stringify(map, null, 2) + '\n', 'utf8');
  console.log(`\nwrote ${ALIAS_MAP}  (verified=${map.verified.length}, declared=${map.declared.length}, unmapped=${map.unmapped.length})`);
}
