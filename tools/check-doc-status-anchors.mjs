#!/usr/bin/env node
/**
 * check-doc-status-anchors.mjs — 文档「状态断言」必须绑定可机械核对的锚（判据 J6）。
 *
 * 依据：
 *   · ADR 0047 第 1 节 R3（真相优先级：持久化证据 > 运行时可观测事实 > 文档声称 > 记忆）
 *   · 判据 J6（计划 / 实现 / 证据三态必须分离）
 *   · P4 L4-3（本脚本的完整规格）
 *
 * 问题：文档的「状态段」是**自由文本**，与 VCS 无机械绑定 ⇒ 任何"只读文档判断状态"的
 * 流程（含 agent 自己）都会系统性出错。2026-10-08 实测 D1–D7 七条漂移，例如：
 *   · 架构缺口清单 P0 行未回填 ✅ 而 closeout 已宣告"P0 全清"
 *   · 代码行号漂移 13–25 行（引 `openai-compat-route.ts:60,74`，实测 `:73`/`:87`）
 *
 * 规则：**含状态断言的行必须带锚**，锚为三者之一：
 *   `commit:<7-40 hex>`      —— 必须在 `git log --all` 里存在
 *   `file:<path>:<line>`     —— 路径必须存在，且**行号必须在文件行数内**（行号错就是错，不放宽）
 *   `adr:<NNNN>`             —— `docs/adr/<NNNN>-*.md` 必须存在
 *
 * **例外（只 warn 不 error）**：
 *   · `docs/research/**`（调研笔记，状态表述是当时的观察）
 *   · 显式标 `dated snapshot` / `历史快照` 的文档
 *
 * **存量债（baseline）**：为让门禁可落地，历史无锚行记入 baseline；**新增无锚行必须红**，
 * **baseline 行数只减不增**（棘轮）。与 `wiring-topology-baseline.txt` / `migration-drift-baseline.txt` 同型。
 *
 * 用法：
 *   node tools/check-doc-status-anchors.mjs                  # 校验（baseline 内只提示）
 *   node tools/check-doc-status-anchors.mjs --strict         # baseline 也报错
 *   node tools/check-doc-status-anchors.mjs --update-baseline
 *   node tools/check-doc-status-anchors.mjs --list           # 列出全部状态行及其锚
 *   node tools/check-doc-status-anchors.mjs --self-test      # 负向控制（纯函数）
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const DOCS = join(ROOT, 'docs');
const BASELINE = join(ROOT, 'tools/doc-status-anchor-baseline.txt');

/**
 * 状态断言行的判据（保守：宁少报不漏错，避免噪音）：
 *   行内出现以下任一标记，即视为**声明了某件事的状态**
 *   · ✅ / ❌ 且与"已修/已实现/已完成/已落地/已闭环/已验证"等词同现
 *   · "已修（" / "已实现（" / "已落地（" 这类带证据的完成声明
 *   刻意**不**匹配纯描述性文字（如"当前状态"章节标题）与 `done/todo` 这类表格枚举。
 */
export const STATUS_LINE_RE = /(?:✅|❌)[^\n]{0,80}(?:已修|已实现|已落地|已完成|已闭环|已接线|已验证|已退役|已归档)|(?:已修|已实现|已落地|已完成|已闭环|已接线|已验证)\s*[（(][^\n]{0,80}(?:commit|file|adr)/;

const ANCHOR_RE = {
  commit: /\bcommit:([0-9a-f]{7,40})\b/gi,
  file: /\bfile:([^\s:]+):(\d+)(?:-(\d+))?\b/gi,
  adr: /\badr:(\d{3,4})\b/gi,
};

/** 该文件是否属于"只 warn"的例外面。 */
export function isExempt(relPath, text) {
  if (relPath.startsWith('docs/research/')) return 'docs/research';
  if (/dated snapshot|历史快照|dated-snapshot/i.test(text)) return 'dated-snapshot';
  return null;
}

/** 从一行里抽出所有锚。 */
export function extractAnchors(line) {
  const out = { commit: [], file: [], adr: [] };
  for (const [kind, re] of Object.entries(ANCHOR_RE)) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(line)) !== null) {
      if (kind === 'file') out.file.push({ path: m[1], start: Number(m[2]), end: m[3] ? Number(m[3]) : Number(m[2]) });
      else out[kind].push(m[1]);
    }
  }
  return out;
}

/** 该行是否**至少含一个锚**（不校验锚有效性——那是 verifyAnchors 的事）。 */
export function hasAnchor(line) {
  const a = extractAnchors(line);
  return a.commit.length + a.file.length + a.adr.length > 0;
}

/**
 * 纯函数：校验锚的有效性。
 * deps 注入以便自检：{ readText(path), exists(path), lineCount(path), knownCommits:Set }
 */
export function verifyAnchors({ anchors, deps }) {
  const problems = [];
  const root = deps.root ?? ROOT;   // 可注入：自检需要独立根
  for (const c of anchors.commit) {
    if (deps.knownCommits && !deps.knownCommits.has(c.slice(0, 7)) && !deps.knownCommits.has(c)) {
      problems.push(`commit:${c} not found in git history`);
    }
  }
  for (const f of anchors.file) {
    const abs = resolve(root, f.path);
    if (!deps.exists(abs)) { problems.push(`file:${f.path} does not exist`); continue; }
    const n = deps.lineCount(abs);
    if (n === 0) { problems.push(`file:${f.path} is empty (cannot anchor line ${f.start})`); continue; }
    if (f.start < 1 || f.start > n) problems.push(`file:${f.path}:${f.start} out of range (file has ${n} lines)`);
    if (f.end !== undefined && (f.end < f.start || f.end > n)) {
      problems.push(`file:${f.path}:${f.start}-${f.end} end out of range (file has ${n} lines)`);
    }
  }
  for (const a of anchors.adr) {
    const dir = join(root, 'docs/adr');
    const found = deps.exists(dir) && deps.listDir(dir).some(f => f.startsWith(a.padStart(4, '0') + '-'));
    if (!found) problems.push(`adr:${a} has no docs/adr/${a.padStart(4, '0')}-*.md`);
  }
  return problems;
}

function walkDocs(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walkDocs(p, out);
    else if (e.name.endsWith('.md')) out.push(p);
  }
  return out;
}

function knownCommits() {
  try {
    const out = execFileSync('git', ['log', '--all', '--pretty=%h%n%H'], {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30_000,
    });
    return new Set(out.split('\n').map(s => s.trim()).filter(Boolean));
  } catch { return null; }
}

// ── 自检 ──
function selfTest() {
  let fail = 0;
  const eq = (label, got, want) => {
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      console.error(`self-test FAILED: ${label}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`); fail++;
    }
  };
  // 状态行判据：正向
  eq('detects ✅ 已修', STATUS_LINE_RE.test('| P0-1 | ✅ 已修（2026-10-06） | ... |'), true);
  eq('detects 已实现（commit:...）', STATUS_LINE_RE.test('已实现（commit:abc1234）'), true);
  // 负向：不得把纯描述/枚举当状态断言（防噪音）
  eq('ignores plain prose', STATUS_LINE_RE.test('本文件描述当前状态与边界。'), false);
  eq('ignores status column enum', STATUS_LINE_RE.test('| done | 6 |'), false);
  eq('ignores TODO marker', STATUS_LINE_RE.test('- ⬜ B0.4 三个只读脚本待做'), false);

  // 锚抽取
  const a = extractAnchors('✅ 已修（commit:eae54786ab4c, file:tools/los.sh:1-9, adr:0047）');
  eq('extract commit', a.commit, ['eae54786ab4c']);
  eq('extract file range', a.file, [{ path: 'tools/los.sh', start: 1, end: 9 }]);
  eq('extract adr', a.adr, ['0047']);
  eq('hasAnchor true', hasAnchor('✅ 已修（file:x:1）'), true);
  eq('hasAnchor false', hasAnchor('✅ 已修'), false);

  // 锚校验（注入 deps）
  const deps = {
    root: '/R',
    exists: p => ['/R/tools/a.sh', '/R/docs/adr'].includes(p),
    lineCount: p => (p === '/R/tools/a.sh' ? 100 : 0),
    listDir: () => ['0047-boundary.md', '0001-x.md'],
    knownCommits: new Set(['eae5478', 'eae54786ab4c']),
  };
  const ok = verifyAnchors({ anchors: { commit: ['eae54786ab4c'], file: [{ path: 'tools/a.sh', start: 5, end: 9 }], adr: ['0047'] }, deps });
  eq('valid anchors pass', ok, []);
  // 负向 1：行号越界
  const bad1 = verifyAnchors({ anchors: { commit: [], file: [{ path: 'tools/a.sh', start: 500, end: 500 }], adr: [] }, deps });
  eq('line out of range caught', bad1.some(p => /out of range/.test(p)), true);
  // 负向 2：文件不存在
  const bad2 = verifyAnchors({ anchors: { commit: [], file: [{ path: 'tools/missing.sh', start: 1, end: 1 }], adr: [] }, deps });
  eq('missing file caught', bad2.some(p => /does not exist/.test(p)), true);
  // 负向 3：commit 不存在
  const bad3 = verifyAnchors({ anchors: { commit: ['deadbee'], file: [], adr: [] }, deps });
  eq('unknown commit caught', bad3.some(p => /not found in git history/.test(p)), true);
  // 负向 4：adr 号无对应文件
  const bad4 = verifyAnchors({ anchors: { commit: [], file: [], adr: ['9999'] }, deps });
  eq('missing adr caught', bad4.some(p => /has no docs\/adr/.test(p)), true);
  // 负向 5：范围端点越界
  const bad5 = verifyAnchors({ anchors: { commit: [], file: [{ path: 'tools/a.sh', start: 1, end: 500 }], adr: [] }, deps });
  eq('range end out of range caught', bad5.some(p => /end out of range/.test(p)), true);

  // 例外面
  eq('research exempt', isExempt('docs/research/x.md', 'plain'), 'docs/research');
  eq('dated snapshot exempt', isExempt('docs/architecture/x.md', '> dated snapshot 2026-06-21'), 'dated-snapshot');
  eq('normal doc not exempt', isExempt('docs/architecture/x.md', 'normal'), null);

  if (fail) { console.error(`\nself-test: ${fail} failure(s)`); process.exit(1); }
  console.log('self-test OK: 5 status-line + 5 anchor-extract + 5 anchor-verify + 3 exempt = 18 assertions');
  process.exit(0);
}

const argv = process.argv.slice(2);
if (argv.includes('--self-test')) selfTest();

const commits = knownCommits();
const deps = {
  exists: existsSync,
  lineCount: p => { try { return readFileSync(p, 'utf8').split('\n').length; } catch { return 0; } },
  listDir: d => { try { return readdirSync(d); } catch { return []; } },
  knownCommits: commits,   // null ⇒ 跳过 commit 校验（不静默当通过，下面会标注）
};

const findings = [];  // { file, line, text, reason }
for (const abs of walkDocs(DOCS)) {
  const rel = relative(ROOT, abs);
  let text;
  try { text = readFileSync(abs, 'utf8'); } catch { continue; }
  const exempt = isExempt(rel, text);
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!STATUS_LINE_RE.test(line)) continue;
    if (exempt) continue;
    if (!hasAnchor(line)) { findings.push({ file: rel, line: i + 1, text: line.trim().slice(0, 110), reason: 'no-anchor' }); continue; }
    const problems = verifyAnchors({ anchors: extractAnchors(line), deps });
    for (const p of problems) findings.push({ file: rel, line: i + 1, text: line.trim().slice(0, 110), reason: p });
  }
}

const baseline = existsSync(BASELINE)
  ? new Set(readFileSync(BASELINE, 'utf8').split('\n').map(s => s.trim()).filter(s => s && !s.startsWith('#')))
  : new Set();
const key = f => `${f.file}:${f.line}`;

const inBaseline = findings.filter(f => baseline.has(key(f)));
const isNew = findings.filter(f => !baseline.has(key(f)));

if (argv.includes('--list')) {
  console.log(`状态断言行扫描：命中 ${findings.length} 条问题（baseline ${inBaseline.length} / 新增 ${isNew.length}）`);
  for (const f of findings) console.log(`  ${baseline.has(key(f)) ? '[baseline]' : '[NEW]     '} ${f.file}:${f.line}  ${f.reason}\n      ${f.text}`);
}

// 棘轮的反向：baseline 里的行若已不再有问题（修好了/文档删了），必须删掉它
const staleBaseline = [...baseline].filter(k => {
  const [f, l] = k.split(':');
  const abs = resolve(ROOT, f);
  if (!existsSync(abs)) return true;                       // 文件已不存在
  const line = readFileSync(abs, 'utf8').split('\n')[Number(l) - 1];
  if (line === undefined) return true;                     // 行号越界（文档缩短了）
  if (!STATUS_LINE_RE.test(line)) return true;              // 该行已不是状态断言
  return hasAnchor(line) && verifyAnchors({ anchors: extractAnchors(line), deps }).length === 0;  // 已带有效锚
});

if (argv.includes('--update-baseline')) {
  const body = findings.map(key).sort().join('\n');
  writeFileSync(BASELINE, `# check-doc-status-anchors baseline — 存量无锚/坏锚行（棘轮：只减不增）\n# 格式 <file>:<line>；修好一行就删一行。新增行必须带锚，否则门禁红。\n${body}\n`, 'utf8');
  console.log(`wrote ${BASELINE} with ${findings.length} entr(y/ies)`);
  process.exit(0);
}

if (!commits) console.log('note: git history unavailable — commit: anchors were NOT verified (this is not a pass for them)');

if (isNew.length) {
  console.error(`check-doc-status-anchors FAILED: ${isNew.length} new problem(s) (baseline has ${inBaseline.length})`);
  for (const f of isNew) console.error(`  - ${f.file}:${f.line}  ${f.reason}\n      ${f.text}`);
  process.exit(1);
}
if (argv.includes('--strict') && inBaseline.length) {
  console.error(`check-doc-status-anchors FAILED (--strict): ${inBaseline.length} baseline problem(s) still present`);
  process.exit(1);
}
if (staleBaseline.length) {
  console.log(`note: ${staleBaseline.length} baseline entr(y/ies) are stale (已修好/已失效) — 请跑 --update-baseline 收紧棘轮：`);
  for (const k of staleBaseline.slice(0, 10)) console.log(`  · ${k}`);
}
console.log(`check-doc-status-anchors OK: no new problems (baseline debt: ${inBaseline.length} line(s), stale: ${staleBaseline.length} — 棘轮只减不增)`);
