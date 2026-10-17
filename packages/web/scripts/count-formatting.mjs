#!/usr/bin/env node
// ── count-formatting.mjs — 展示格式化违规面的棘轮（B0，2026-10-17）──
//
// 目的：把"UI 层自己格式化时间/数字"这件事变成**可复核的数字**，然后只许降。
//
// ## 两档口径（这是刻意的，不是偷懒）
//
// **可归零档**（目标是 0）：
//   toFixed(  · toLocaleString  · toLocaleTimeString  · toLocaleDateString
//   这四类一旦出现在 `src/**`，就说明该处绕过 `components/format.mjs` 自己格式化。
//
// **仅记录档**（不要求归零）：
//   new Date(
//   绝大多数是 `new Date(x).getTime()` 这类**非展示运算**，把它归零是错的。
//   真正常要管的是"它出现在 JSX 文本 / `title=` / `aria-label=` 位置"，
//   而那需要 AST 才能判准 —— 用正则会**同时**产生假阳性与假阴性，
//   所以本脚本只把总数作为趋势参考，**不**据此判红。
//
// ⇒ 因此本脚本的红/绿只取决于"可归零档"是否上涨。
//
// ## 用法
//   node scripts/count-formatting.mjs             # 人读
//   node scripts/count-formatting.mjs --emit json # 机读
//   node scripts/count-formatting.mjs --write-baseline   # 复核后重拍基线
//
// ## exit
//   0 = 没有上涨（含下降；下降时会提示可以收紧基线）
//   1 = 有"可归零档"上涨
//   2 = 判不了（src 不存在 / 基线坏了）
//
// ## ⚠️ 扫描面只含 `.ts` / `.tsx`（**不含 `.mjs`**）
//
// 格式化自己的实现住在 `components/format.mjs`，它内部当然会用 `toFixed`。
// 不扫 `.mjs` 是有意的：本脚本判的是"**组件绕过 format 自己格式化**"，
// 而不是"仓里存在 toFixed"。
// 副作用要知道：B1 把 `components/format.ts` 的实现搬进 `format.mjs` 后，
// 计数从 41→38 / 15→14（搬走了 3 处 toFixed、1 处 toLocaleString）。
// 这不是"违规被偷偷清掉"，是实现换了家。
//
// ## 为什么基线住在本仓
//   跨仓门禁会读别的仓的路径 ⇒ 判据取决于 checkout 布局，
//   违反 dsfolder/AGENTS.md §3「判据只取决于仓库内容」。所以棘轮住在这里。

import { readdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const WEB = dirname(HERE)                  // packages/web
const SRC = join(WEB, 'src')
const BASELINE = join(WEB, 'FORMAT-BASELINE.json')

/** 必须归零的模式 */
const ZERO_PATTERNS = ['toFixed(', 'toLocaleString', 'toLocaleTimeString', 'toLocaleDateString']
/** 仅记录趋势的模式 */
const INFO_PATTERNS = ['new Date(']

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p)
  }
  return out
}

const count = (text, pat) => text.split(pat).length - 1

function scan() {
  if (!existsSync(SRC) || !statSync(SRC).isDirectory()) return null
  const files = walk(SRC)
  const totals = Object.fromEntries([...ZERO_PATTERNS, ...INFO_PATTERNS].map((p) => [p, 0]))
  const perFile = {}
  for (const f of files) {
    const text = readFileSync(f, 'utf8')
    const rel = relative(WEB, f)
    for (const pat of Object.keys(totals)) {
      const n = count(text, pat)
      if (n > 0) {
        totals[pat] += n
        perFile[rel] ??= {}
        perFile[rel][pat] = n
      }
    }
  }
  return { files: files.length, totals, perFile }
}

const argv = process.argv.slice(2)
const asJson = argv.includes('--emit') && argv[argv.indexOf('--emit') + 1] === 'json'
const writeBaseline = argv.includes('--write-baseline')

const r = scan()
if (!r) {
  if (asJson) process.stdout.write(JSON.stringify({ ok: false, error: 'src-not-found' }) + '\n')
  else console.error(`  ✗ 找不到 ${SRC} —— 判不了`)
  process.exit(2)
}

if (writeBaseline) {
  const baseline = {
    schemaVersion: 1,
    note: '可归零档的棘轮基线：只许下降。新增/上涨 ⇒ count-formatting.mjs exit 1。'
      + ' INFO_PATTERNS 不参与判定（多为非展示运算，正则会误判）。',
    writtenAt: new Date().toISOString(),
    zeroPatterns: Object.fromEntries(ZERO_PATTERNS.map((p) => [p, r.totals[p]])),
    infoPatterns: Object.fromEntries(INFO_PATTERNS.map((p) => [p, r.totals[p]])),
  }
  writeFileSync(BASELINE, JSON.stringify(baseline, null, 2) + '\n')
  if (asJson) process.stdout.write(JSON.stringify({ ok: true, baseline }) + '\n')
  else console.log(`  已写基线 ${relative(WEB, BASELINE)}：` + ZERO_PATTERNS.map((p) => `${p}=${r.totals[p]}`).join(' · '))
  process.exit(0)
}

let baseline = null
if (existsSync(BASELINE)) {
  try {
    baseline = JSON.parse(readFileSync(BASELINE, 'utf8'))
  } catch {
    if (asJson) process.stdout.write(JSON.stringify({ ok: false, error: 'baseline-unreadable' }) + '\n')
    else console.error('  ✗ FORMAT-BASELINE.json 不可解析 —— 判不了')
    process.exit(2)
  }
}

const grown = []
const tightened = []
for (const p of ZERO_PATTERNS) {
  const base = baseline?.zeroPatterns?.[p]
  if (typeof base !== 'number') continue
  if (r.totals[p] > base) grown.push({ pattern: p, now: r.totals[p], base })
  if (r.totals[p] < base) tightened.push({ pattern: p, now: r.totals[p], base })
}

const payload = {
  schemaVersion: 1,
  scannedFiles: r.files,
  zero: Object.fromEntries(ZERO_PATTERNS.map((p) => [p, r.totals[p]])),
  info: Object.fromEntries(INFO_PATTERNS.map((p) => [p, r.totals[p]])),
  baseline: baseline?.zeroPatterns ?? null,
  grown,
  tightened,
  verdict: grown.length ? 'fail' : 'ok',
}

if (asJson) {
  process.stdout.write(JSON.stringify(payload, null, 2) + '\n')
} else {
  console.log('=== 展示格式化违规面（可归零档）')
  for (const p of ZERO_PATTERNS) {
    const base = baseline?.zeroPatterns?.[p]
    const delta = typeof base === 'number' ? r.totals[p] - base : null
    const mark = delta == null ? ' ' : delta > 0 ? '✗' : delta < 0 ? '↓' : ' '
    console.log(`  ${mark} ${p.padEnd(22)} ${String(r.totals[p]).padStart(4)}${typeof base === 'number' ? `  (基线 ${base})` : ''}`)
  }
  console.log('--- 仅记录（不参与判定）')
  for (const p of INFO_PATTERNS) console.log(`    ${p.padEnd(22)} ${String(r.totals[p]).padStart(4)}`)
  console.log(`\n  扫描 ${r.files} 个文件 · 结论: ${payload.verdict}`)
  if (grown.length) {
    console.log('  ✗ 上涨：' + grown.map((g) => `${g.pattern} ${g.base}→${g.now}`).join(' · '))
    console.log('  ⇒ 新代码必须走 components/format.mjs，不要在组件里自己格式化。')
  }
  if (tightened.length) {
    console.log('  ↓ 下降：' + tightened.map((g) => `${g.pattern} ${g.base}→${g.now}`).join(' · '))
    console.log('  ⇒ 复核后 node scripts/count-formatting.mjs --write-baseline 收紧基线。')
  }
}

process.exit(grown.length ? 1 : 0)
