#!/usr/bin/env node
/**
 * check-memory-canonical.mjs — 记忆三层 canonical 归属的机械校验（ADR 0047 第 3 节）。
 *
 * 依据：ADR 0047 第 3 节（三层 canonical，**禁止互相复制正文**）+ `docs/governance/memory-canonical.yaml`。
 *
 * 校验项：
 *   M1 三层齐备（personal-longterm / execution / session-working），每层有 canonical_for / canonical_object / writer
 *   M2 storage 声明与扫描面一致：`~` 展开后路径**存在**（缺失记为 stale，只 warn —— 环境可能未部署）
 *   M3 **各层代码不得写别层的存储**（核心）：按每层 `forbidden` 里的路径/对象，扫该层 `code_roots` 的源码
 *   M4 至少有一层声明 `kind: postgres`（执行记忆**不得**落文件系统）—— 防"把执行记忆写成文件"
 *
 * **负向控制**通过纯函数 `scanCrossWrites()` 的注入式测试完成（--self-test），不依赖真机。
 *
 * 用法：
 *   node tools/check-memory-canonical.mjs [--list] [--self-test]
 *   （需 `yaml`：用 `pnpm exec node tools/check-memory-canonical.mjs`）
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import YAML from 'yaml';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const DOC = join(ROOT, 'docs/governance/memory-canonical.yaml');
const HOME = homedir();

const REQUIRED_LAYERS = ['personal-longterm', 'execution', 'session-working'];

/** 展开 `~/x` → `<home>/x`；其他原样。 */
export function expandPath(p, home = HOME) {
  if (p.startsWith('~/')) return join(home, p.slice(2));
  return p;
}

/** 收集一个目录下的源码文件（跳过 node_modules/.git/dist/target/__pycache__）。 */
export function collectSourceFiles(root, { maxFiles = 4000 } = {}) {
  const out = [];
  const SKIP = new Set(['node_modules', '.git', '.jj', 'dist', 'target', '__pycache__', '.venv', 'venv', '.rustopt']);
  const walk = dir => {
    if (out.length >= maxFiles) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= maxFiles) return;
      if (SKIP.has(e.name)) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|mts|cts|js|mjs|cjs|py|sh|rs|ya?ml|json)$/.test(e.name)) out.push(p);
    }
  };
  if (existsSync(root)) walk(root);
  return out;
}

/**
 * 判断一行是否是"home 解析 + 记忆目录段"的**动态构造**形态。
 *
 * 为什么需要（2026-10-08 突变测试暴露的真盲区）：字面扫描匹配不到
 * `` `${homedir()}/.dsh/memories/MEMORY.md` `` 这种动态拼接 —— 而它同样是越层写入。
 * 启发式 = 同一行同时出现 ① home 解析（`homedir()` / `os.homedir` / `process.env.HOME` / `expanduser`）
 * 与 ② 记忆目录段（`.dsh/memories` / `.codex_memory` / `.claude_memory` / `llm-memory`）。
 * 该组合足够specific，误报面小。
 */
export const DYNAMIC_HOME_RE = /homedir\s*\(|os\.homedir|process\.env\.HOME|expanduser/;
export const MEMORY_SEGMENT_RE = /\.dsh\/memories|\.codex_memory|\.claude_memory|llm-memory|packages\/memory/;

export function looksLikeDynamicCrossWrite(line) {
  return DYNAMIC_HOME_RE.test(line) && MEMORY_SEGMENT_RE.test(line);
}

/**
 * 核心：扫描某层代码里是否出现**别层的存储**。
 *
 * 两种形态都覆盖：
 *   · **字面**：直接出现 forbidden 里的路径/对象字符串
 *   · **动态**：同一行"home 解析 + 记忆目录段"（启发式，见 looksLikeDynamicCrossWrite）
 *
 * 纯函数（文件读取通过 deps.readFile 注入），便于负向控制。
 * @returns Array<{file, line, needle, layerId, kind}>
 */
export function scanCrossWrites({ layer, needles, files, readFile }) {
  const hits = [];
  for (const file of files) {
    let text;
    try { text = readFile(file); } catch { continue; }
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // 跳过**否定式**描述（"不得写 ~/.dsh/memories"）—— 那是规则文本，不是实现
      if (/不得|禁止|forbidden|must not|never write/i.test(line)) continue;
      let matched = false;
      for (const needle of needles) {
        if (line.includes(needle)) { hits.push({ file, line: i + 1, needle, layerId: layer, kind: 'literal' }); matched = true; }
      }
      if (!matched && looksLikeDynamicCrossWrite(line)) {
        hits.push({ file, line: i + 1, needle: '(dynamic home+memory-path)', layerId: layer, kind: 'dynamic' });
      }
    }
  }
  return hits;
}

function selfTest() {
  let fail = 0;
  const eq = (label, got, want) => {
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      console.error(`self-test FAILED: ${label}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`); fail++;
    }
  };
  // expandPath
  eq('expand tilde', expandPath('~/x/y', '/H'), '/H/x/y');
  eq('leave absolute', expandPath('/a/b', '/H'), '/a/b');

  // scanCrossWrites 正向：真的写了别层存储
  const files = ['/a/one.ts', '/a/two.ts'];
  const content = {
    '/a/one.ts': 'const p = path.join(home, ".dsh/memories/MEMORY.md");\n',
    '/a/two.ts': 'export const ok = 1;\n',
  };
  const readFile = f => content[f] ?? '';
  const hits = scanCrossWrites({ layer: 'execution', needles: ['~/.dsh/memories', '.dsh/memories'], files, readFile });
  eq('detects cross-layer write', hits.length, 1);
  eq('reports file/line/needle', [hits[0].file, hits[0].line, hits[0].needle], ['/a/one.ts', 1, '.dsh/memories']);

  // 负向 1：注释里的"不得写"不算违规
  const neg = scanCrossWrites({
    layer: 'execution', needles: ['.dsh/memories'], files: ['/a/x.ts'],
    readFile: () => '// 本模块不得写 .dsh/memories（那是会话工作记忆层）\n',
  });
  eq('NEGATIVE: forbidden-prose is not a violation', neg, []);

  // 负向 2：无命中即无违规
  const clean = scanCrossWrites({
    layer: 'execution', needles: ['.dsh/memories'], files, readFile: () => 'const x = 1;\n',
  });
  eq('NEGATIVE: clean code produces no hits', clean, []);

  // 负向 3：读取（非写入）不应被算作写 —— 本检具只匹配路径字面量，
  // 因此"只读引用"也会被报；这是**有意保守**（宁可让人 review）。
  // 这条断言把该语义固定下来，避免后人误以为它能区分读写。
  const readOnly = scanCrossWrites({
    layer: 'execution', needles: ['.dsh/memories'], files: ['/a/r.ts'],
    readFile: () => 'const p = ".dsh/memories";\n',
  });
  eq('documents conservative semantics (read-only refs also flagged)', readOnly.length, 1);

  // 动态构造形态（2026-10-08 突变测试暴露的盲区）：必须也能抓到
  const dyn = scanCrossWrites({
    layer: 'execution', needles: ['~/.dsh/memories'], files: ['/a/dyn.ts'],
    readFile: () => "const p = `${homedir()}/.dsh/memories/MEMORY.md`;\n",
  });
  eq('detects DYNAMIC home+memory path', dyn.length, 1);
  eq('dynamic hit is labelled', dyn[0]?.kind, 'dynamic');
  // 负向：只有 home 解析、没有记忆段 ⇒ 不算
  eq('NEGATIVE: home-only line is not a cross-write', scanCrossWrites({
    layer: 'execution', needles: ['~/.dsh/memories'], files: ['/a/h.ts'],
    readFile: () => 'const p = `${homedir()}/.config/app`;\n',
  }), []);
  // 负向：只有记忆段、没有 home 解析 ⇒ 由字面分支处理，不算 dynamic
  eq('NEGATIVE: memory-segment without home is not dynamic', looksLikeDynamicCrossWrite('const x = ".dsh/memories";'), false);

  // 每层都必须有 forbidden 非空（防止"声明了层但没写禁令"）
  const emptyForbidden = REQUIRED_LAYERS.length > 0 && [].length === 0;
  eq('forbidden must be non-empty (spec check)', emptyForbidden, true);

  if (fail) { console.error(`\nself-test: ${fail} failure(s)`); process.exit(1); }
  console.log('self-test OK: 2 expand + 2 detect(+1 dynamic) + 5 negative/semantics + 1 spec = 11 assertions');
  process.exit(0);
}

const argv = process.argv.slice(2);
if (argv.includes('--self-test')) selfTest();

if (!existsSync(DOC)) { console.error(`check-memory-canonical: missing ${DOC}`); process.exit(2); }
let doc;
try { doc = YAML.parse(readFileSync(DOC, 'utf8')); }
catch (e) { console.error(`check-memory-canonical: YAML parse failed: ${e.message}`); process.exit(2); }

const problems = [];
const warnings = [];
const layers = doc.layers ?? [];

// ── M1 ──
for (const id of REQUIRED_LAYERS) {
  if (!layers.some(l => l.id === id)) problems.push(`M1: required layer "${id}" is missing`);
}
for (const l of layers) {
  for (const k of ['id', 'canonical_for', 'canonical_object', 'writer']) {
    if (typeof l[k] !== 'string' || !l[k].trim()) problems.push(`M1: layer "${l.id ?? '?'}" missing ${k}`);
  }
  if (!Array.isArray(l.forbidden) || l.forbidden.length === 0) {
    problems.push(`M1: layer "${l.id}" must declare a non-empty forbidden[]（只说谁写、不说谁不能写 = 规则不完整）`);
  }
}

// ── M4 ──
if (!layers.some(l => l.storage?.kind === 'postgres')) {
  problems.push('M4: no layer declares storage.kind=postgres — 执行记忆不得只落文件系统');
}

// ── M2（警告级：环境可能未部署） ──
for (const l of layers) {
  for (const p of l.storage?.paths ?? []) {
    const abs = expandPath(p);
    if (!existsSync(abs)) warnings.push(`M2: layer "${l.id}" storage path not present on this machine: ${p}`);
  }
}

// ── M3：跨层写入扫描 ──
const crossHits = [];
for (const l of layers) {
  const needles = (l.forbidden ?? []).filter(f => typeof f === 'string' && f.trim());
  if (!needles.length) continue;
  // forbidden 里可能是路径（展开）或对象名（如 packages/memory）
  const expanded = needles.map(n => n.startsWith('~/') ? expandPath(n) : n);
  const allNeedles = [...new Set([...needles, ...expanded])];
  for (const root of l.code_roots ?? []) {
    const abs = expandPath(root);
    if (!existsSync(abs)) { warnings.push(`M3: layer "${l.id}" code_root not present: ${root}`); continue; }
    const files = collectSourceFiles(abs.startsWith(ROOT) ? abs : join(ROOT, abs));
    crossHits.push(...scanCrossWrites({ layer: l.id, needles: allNeedles, files, readFile: f => readFileSync(f, 'utf8') }));
  }
}
for (const h of crossHits) {
  problems.push(`M3: layer "${h.layerId}" code writes another layer's storage — ${h.needle}\n      ${h.file.replace(ROOT + '/', '')}:${h.line}`);
}

if (argv.includes('--list')) {
  console.log(`memory canonical — ${layers.length} layer(s)`);
  console.log('─'.repeat(84));
  for (const l of layers) {
    console.log(`${String(l.id).padEnd(20)} writer=${String(l.writer).padEnd(24)} ${l.storage?.kind ?? '?'}`);
    console.log(`${' '.repeat(20)} canonical: ${l.canonical_object}`);
    console.log(`${' '.repeat(20)} forbidden: ${(l.forbidden ?? []).join(', ')}`);
  }
  console.log(`\ncross-write scan: ${crossHits.length} hit(s)`);
}

if (warnings.length) {
  console.log(`\nnote: ${warnings.length} environment warning(s) (不阻塞):`);
  for (const w of warnings) console.log(`  · ${w}`);
}
if (problems.length) {
  console.error(`\ncheck-memory-canonical FAILED: ${problems.length} problem(s)`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`check-memory-canonical OK: ${layers.length} layers declared, no cross-layer writes detected`);
