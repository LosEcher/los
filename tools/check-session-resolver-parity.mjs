#!/usr/bin/env node
/**
 * check-session-resolver-parity.mjs — 两份路径解析实现的**一致性**检查。
 *
 * ## 为什么有两份实现（这是有意的边界，不是重复）
 * | 实现 | 服务于 | 为什么不能共用 |
 * | --- | --- | --- |
 * | `tools/lib/session-path-resolver.mjs` | build-time 检具（`tools/*.mjs`，直接 `node` 跑） | 检具**不该依赖构建产物 / tsx** |
 * | `packages/agent/src/session-path-resolver.ts` | runtime（`@los/agent` 的跨项目投射） | 运行时**不该依赖 tools/** |
 *
 * 代价是可能漂移 ⇒ 本检具锁住：同一组夹具下两份必须给出**逐字段相同**的结果。
 * 放在 tools/ 而不是包测试里，是因为**只有这里能干净地同时导入两边**
 * （包测试用相对路径向上穿五级到仓根，既脆弱又跨越包边界）。
 *
 * 用法：`node tools/check-session-resolver-parity.mjs`
 */
import { pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

const mjsUrl = pathToFileURL(resolve(ROOT, 'tools/lib/session-path-resolver.mjs')).href;
const tsPath = resolve(ROOT, 'packages/agent/src/session-path-resolver.ts');

const ROOT_DIR = '/NEW/project';
const MAP = {
  version: 2,
  verified: [{ from: '/OLD/project/x', to: '/NEW/project/x', basis: 'same-leaf' }],
  declared: [{ from: '/GONE/project/y', to: '/NEW/project/y', basis: 'reloc', declaredBy: 'operator' }],
};

const CASES = [
  ['/NEW/project/a', MAP], ['/NEW/project', MAP], ['/OLD/project/x', MAP],
  ['/GONE/project/y', MAP], ['/ELSEWHERE/z', MAP], ['/OLD/project/x/', MAP],
  ['', MAP], ['/NEW/project/a', null], ['/OLD/project/x', null],
  ['/ELSEWHERE/z', null], ['', null],
];

async function main() {
  const mjs = await import(mjsUrl);
  // TS 版需要 tsx 加载器。**不在此处动态注册**（仓根解析不到 `tsx/esm/api`）——
  // 由调用方提供：`pnpm check:session-resolver-parity` 会用 `node --import tsx` 起。
  let ts;
  try {
    ts = await import(pathToFileURL(tsPath).href);
  } catch (e) {
    console.error(`check-session-resolver-parity: cannot load the TS resolver (${String(e).slice(0, 140)})`);
    console.error('  this is a TOOLING/ENV fault, not a parity failure — run `pnpm check:session-resolver-parity`');
    process.exit(2);
  }

  let fail = 0;
  for (const [cwd, map] of CASES) {
    const opts = { currentRoot: ROOT_DIR, aliasMap: map };
    const a = mjs.resolveSessionCwd(cwd, opts);
    const b = ts.resolveSessionCwd(cwd, opts);
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      console.error(`PARITY FAIL cwd=${JSON.stringify(cwd)} map=${map ? 'present' : 'null'}`);
      console.error(`  .mjs: ${JSON.stringify(a)}`);
      console.error(`  .ts : ${JSON.stringify(b)}`);
      fail++;
    }
  }
  // 批量入口也要一致（它有自己的 byState/unknownCwds 形状）
  const cwds = ['/NEW/project/a', '/OLD/project/x', '/ELSEWHERE/z', '/GONE/project/y', ''];
  for (const map of [MAP, null]) {
    const a = mjs.resolveSessionCwds(cwds, { currentRoot: ROOT_DIR, aliasMap: map });
    const b = ts.resolveSessionCwds(cwds, { currentRoot: ROOT_DIR, aliasMap: map });
    if (JSON.stringify(a.byState) !== JSON.stringify(b.byState)) {
      console.error(`PARITY FAIL byState (map=${map ? 'present' : 'null'}): ${JSON.stringify(a.byState)} vs ${JSON.stringify(b.byState)}`);
      fail++;
    }
  }

  if (fail) { console.error(`\ncheck-session-resolver-parity FAILED: ${fail} divergence(s)`); process.exit(1); }
  console.log(`check-session-resolver-parity OK: ${CASES.length} single + 2 batch case(s) agree across both implementations`);
}

await main();
