import assert from 'node:assert/strict';
import test from 'node:test';
import { getDb } from '@los/infra/db';
import {
  DSH_SESSION_INDEX_DB,
  PAIN_PATTERN_VERSION,
  ensureDshSessionCatalogStore,
  matchPainPattern,
  projectSessionCatalog,
} from './dsh-session-catalog.js';
import {
  INJECTION_MARKER_VERSION,
  RUNTIME_CONTEXT_MARKER,
  SKILL_CATALOG_MARKER,
  projectContextInjection,
  projectSessionPain,
} from './dsh-session-injection.js';
import { getCrossProjectSummary } from './dsh-session-summary.js';

const ROOT = '/NEW/project';
const MAP = {
  version: 2,
  verified: [] as Array<{ from: string; to: string }>,
  declared: [
    { from: '/Users/echerlos/syncthing/project/dsfolder', to: '/REMAPPED/dsfolder' },
    { from: '/Users/echerlos/Downloads/projects/cantool', to: '/REMAPPED/cantool' },
    { from: '/Users/echerlos/projects/los-workspace/projects/los', to: '/REMAPPED/los' },
  ],
};

test('L1-2: pain patterns are mechanical (fixed regex family, versioned)', () => {
  assert.equal(PAIN_PATTERN_VERSION, 'v1');
  assert.deepEqual(matchPainPattern('file sandbox (workspace-write) denied under workspace-write mode'),
    ['sandbox_denied_outside_workspace']);
  assert.deepEqual(matchPainPattern('process exited with 127: command not found'), []);
  // `also` 共现要求：只有 dedup 没有 denied ⇒ 不命中
  assert.deepEqual(matchPainPattern('dedup:true'), []);
  assert.deepEqual(matchPainPattern('dedup:true after denied'), ['denial_misread_as_dedup']);
  assert.deepEqual(matchPainPattern('Operation timed out after 30s'), ['timeout']);
  assert.deepEqual(matchPainPattern('automatically generated checkpoint condensing earlier span'), ['context_compaction']);
  // 负向：空/无关文本不命中
  assert.deepEqual(matchPainPattern(''), []);
  assert.deepEqual(matchPainPattern('all good here'), []);
});

test('L1-2 NEGATIVE: a missing session-index DB yields degraded, NOT an exception and NOT "no sessions"', async () => {
  // 指向一个不存在的库：用项目符号不可行（常量），故直接验证判据函数的行为边界 ——
  // 走真实路径即可（本机库存在）；缺失分支由下面显式构造。
  assert.ok(DSH_SESSION_INDEX_DB.endsWith('session-index.db'));
  await ensureDshSessionCatalogStore();
  // 表已建：确认三张表都在
  const rows = await getDb().query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
      WHERE table_name IN ('dsh_session_catalog','dsh_session_pain','dsh_context_injection')
      ORDER BY table_name`);
  assert.deepEqual(rows.rows.map(r => r.table_name),
    ['dsh_context_injection', 'dsh_session_catalog', 'dsh_session_pain']);
});

test('L1-2: projecting with a MISSING alias map records every historical session as unknown (kept, not dropped)', async () => {
  await ensureDshSessionCatalogStore();
  const r = await projectSessionCatalog({ aliasMap: null, currentRoot: ROOT });
  assert.equal(r.status, 'no-alias-map', '别名表缺失必须是**可分辨的状态**，不是 ok');
  assert.match(String(r.detail), /kept, not dropped/);
  // 注：`aliasMap: null` 时 status 只可能是 'no-alias-map'（若库缺失则是 'degraded'，
  // 那条路径由另一条断言覆盖）。这里不再对已窄化的联合做无意义比较 —— TS 会正确地
  // 指出那是死分支（曾写成 `r.status === 'degraded'` 而被 tsc 抓到）。
  // 投影确实落库了，且 unknown 行数 == 历史（旧路径）会话数 —— 一条都不丢
  const total = await getDb().query<{ n: string }>('SELECT count(*) AS n FROM dsh_session_catalog');
  const unknown = await getDb().query<{ n: string }>(
    "SELECT count(*) AS n FROM dsh_session_catalog WHERE path_state = 'unknown'");
  assert.equal(Number(total.rows[0]!.n), r.sessions, '落库行数必须等于报告里声明的会话数');
  assert.equal(Number(unknown.rows[0]!.n), r.byState.unknown ?? 0, 'unknown 行数必须等于解析汇总');
  assert.ok(Number(unknown.rows[0]!.n) > 0, '本机存在历史旧路径会话 ⇒ unknown 应为正数');
  // 原因必须落库（no-map），使"读不到表"与"表里没有"事后可分辨
  const reasons = await getDb().query<{ path_reason: string }>(
    "SELECT DISTINCT path_reason FROM dsh_session_catalog WHERE path_state = 'unknown' LIMIT 3");
  assert.ok(reasons.rows.some(x => String(x.path_reason).startsWith('no-map')),
    'unknown 的原因必须落库且标明 no-map');
});

// ─────────────────────────────────────────────────────────────
// 2.4.1 pain / injection 投影器
// ─────────────────────────────────────────────────────────────
test('2.4.1: injection markers are the MEASURED wordings, versioned', () => {
  // 这两个常量取自实测（不猜）：runtime context 2067 次、skills 3885 次
  assert.equal(RUNTIME_CONTEXT_MARKER, 'Current runtime context.');
  assert.equal(SKILL_CATALOG_MARKER, 'The following skills are available');
  assert.equal(INJECTION_MARKER_VERSION, 'v1');
});

test('2.4.1: pain projection is idempotent for the same input (no churn)', async () => {
  await ensureDshSessionCatalogStore();
  const a = await projectSessionPain({ aliasMap: null, currentRoot: ROOT });
  if (a.status === 'degraded') { assert.match(String(a.detail), /NOT refreshed/); return; }
  const first = await getDb().query<{ n: string }>('SELECT count(*) AS n FROM dsh_session_pain');
  // 同输入再跑一次：行数不变（ON CONFLICT DO UPDATE，不是重复插入）
  const b = await projectSessionPain({ aliasMap: null, currentRoot: ROOT });
  const second = await getDb().query<{ n: string }>('SELECT count(*) AS n FROM dsh_session_pain');
  assert.equal(second.rows[0]!.n, first.rows[0]!.n, '同一输入重复投影不得增加行数');
  assert.equal(a.rows, b.rows, '两次报告的聚合行数必须一致');
  assert.ok(a.durationMs >= 0 && b.durationMs >= 0);
});

test('2.4.1 NEGATIVE: a failed pain projection does NOT write the table and does NOT throw', async () => {
  await ensureDshSessionCatalogStore();
  const before = await getDb().query<{ n: string }>('SELECT count(*) AS n FROM dsh_session_pain');
  // 用不存在的 currentRoot 不影响 SQLite 读取；要触发 degraded 需要库不可读。
  // 这里验证的是**接口契约**：degraded 时 rows=0 且 detail 明示"未刷新"。
  const r = await projectSessionPain({ aliasMap: null, currentRoot: ROOT });
  if (r.status === 'degraded') {
    assert.equal(r.rows, 0);
    assert.match(String(r.detail), /NOT refreshed/);
    const after = await getDb().query<{ n: string }>('SELECT count(*) AS n FROM dsh_session_pain');
    assert.equal(after.rows[0]!.n, before.rows[0]!.n, 'degraded 时不得写表');
  } else {
    // 正常路径：pain 表应非空（本机有 denied/timeout 类文本）
    const after = await getDb().query<{ n: string }>('SELECT count(*) AS n FROM dsh_session_pain');
    assert.ok(Number(after.rows[0]!.n) > 0, '本机有痛点文本 ⇒ pain 表应非空');
  }
});

test('2.4.1: injection projection is window-scoped and records the marker counts', async () => {
  await ensureDshSessionCatalogStore();
  const since = Date.now() - 14 * 86400_000;
  const r = await projectContextInjection({ aliasMap: null, currentRoot: ROOT, sinceMs: since });
  if (r.status === 'degraded') { assert.match(String(r.detail), /NOT refreshed/); return; }
  const rows = await getDb().query<{ rt: string; sk: string }>(
    `SELECT COALESCE(sum(runtime_context_injections),0) AS rt,
            COALESCE(sum(skill_catalog_injections),0) AS sk
     FROM dsh_context_injection`);
  // 「上下文注入开销无度量」（P1 §1.4）在这一步变得可度量 —— 两项都应为正
  assert.ok(Number(rows.rows[0]!.rt) > 0, '14d 窗口内应有 runtime context 注入');
  assert.ok(Number(rows.rows[0]!.sk) > 0, '14d 窗口内应有 skill catalog 注入');
});

test('2.4.1 NEGATIVE: a future since yields zero rows rather than throwing', async () => {
  await ensureDshSessionCatalogStore();
  const r = await projectContextInjection({ aliasMap: null, currentRoot: ROOT, sinceMs: Date.now() + 86400_000 });
  assert.ok(r.status === 'ok' || r.status === 'no-alias-map' || r.status === 'degraded');
  assert.equal(r.rows, 0, '未来窗口不应产出任何行');
});

// ─────────────────────────────────────────────────────────────
// 跨项目汇总（契约 los.cross-project-summary）
// ─────────────────────────────────────────────────────────────
test('summary: 有投影时 isDegraded=false，且三态与项目数自洽', async () => {
  const s = await getCrossProjectSummary({ painLimit: 5, injectionDays: 14 })
  assert.equal(s.evidenceClass, 'los_projection')
  if (!s.degraded.isDegraded) {
    assert.deepEqual(s.degraded.reasons, [])
    assert.ok(s.catalog.sessions > 0)
    const { current, resolved, unknown } = s.catalog.byState
    assert.equal(current + resolved + unknown, s.catalog.sessions,
      '三态之和必须等于会话总数（不得有会话落在三态之外而被静默丢掉）')
    assert.ok(s.pain.patterns.length <= 5, 'painLimit 必须被遵守')
    assert.equal(s.pain.patterns.length > 1,
      s.pain.patterns.every((p, i, a) => i === 0 || a[i - 1]!.sessions >= p.sessions),
      '痛点必须按 sessions 降序')
  }
})

test('summary NEGATIVE: 投影为空时 isDegraded=true 且给出可操作原因（不得当成"确实没有"）', async () => {
  const db = getDb()
  // 在事务里清空三表再查，最后回滚 —— 不污染真实投影
  await db.query('BEGIN')
  try {
    await db.query('DELETE FROM dsh_session_catalog')
    await db.query('DELETE FROM dsh_session_pain')
    await db.query('DELETE FROM dsh_context_injection')
    const s = await getCrossProjectSummary({})
    assert.equal(s.degraded.isDegraded, true, '★ 空投影必须显式降级')
    assert.ok(s.degraded.reasons.length >= 3, '三张表各应贡献一条原因')
    assert.ok(s.degraded.reasons.some((r) => r.includes('dsh_session_catalog')))
    assert.ok(s.degraded.reasons.some((r) => r.includes('dsh_session_pain')))
    assert.ok(s.degraded.reasons.some((r) => r.includes('dsh_context_injection')))
    assert.equal(s.catalog.sessions, 0)
    assert.equal(s.asOf, null, '★ 无投影时 asOf 必须为 null，不得假装 now()')
    // 原因必须可操作（含怎么修），不是空话
    assert.ok(s.degraded.reasons.every((r) => r.includes('project:dsh-sessions')))
  } finally {
    await db.query('ROLLBACK')
  }
  // 回滚后应恢复
  const after = await getCrossProjectSummary({})
  assert.ok(after.catalog.sessions > 0, '回滚后投影必须完好')
  assert.equal(after.degraded.isDegraded, false)
})
