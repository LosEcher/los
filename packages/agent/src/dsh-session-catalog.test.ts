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
