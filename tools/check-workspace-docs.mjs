#!/usr/bin/env node
/**
 * check-workspace-docs.sh 的 node 实现 —— 工作区文档一致性（判据 J4 + J9 的文档侧）。
 *
 * 依据：ADR 0047 第 1 节 R2（引用只能上层→下层）+ 判据 J4
 *       （L2 项目规则可引用 L1 工作区；**路径式引用必须可解析**）
 *
 * 背景（2026-10-08 实测）：
 *   · `los-memory/AGENTS.md` 指向 `~/projects/los-workspace/*`，而 **`~/projects` 不存在**
 *   · `los-workspace/WORKSPACE.md` 声称 `projects/` 下有 7 个项目，实际只有 `los` 与 `weclaw`
 *   两者都是"文档描述了它不拥有的范围"。
 *
 * 校验项：
 *   W1 被扫描文档里的**路径式引用必须可解析**（`~/…`、`$HOME/…`、`../…` 相对、`/Users/…` 绝对）
 *   W1b **裸相对路径**中的**文件名式**引用（`a/b.md`、`x/y.jsonl`、`p/q.tsx`…）：
 *       默认记为**提示**（不阻塞）；`--strict-relative` 时记为**问题**（exit 1）。
 *       为什么只收"文件名式"而不收所有裸相对路径（2026-10-09 实测，12 篇扫描集）：
 *         · 所有裸相对路径 token：候选 181 → **75 个解析不到**，几乎全是**散文斜杠**
 *           （`TypeScript/pnpm`、`los/infra`、`provider/harness`、`ADR/source/contract`）、
 *           日期区间（`2026-08-05/08-08`）、JS 语法（`import/export`）⇒ 全量收会变成噪音门禁。
 *         · 只收带**文件扩展名**且带**右边界**的：候选 67（md）+ 8（json）+ 5（ts）… →
 *           md 解析不到 **0 个**；json/ts 那 6 个**全部是正则假象**（文件里写的是
 *           `.jsonl` / `.tsv` / `.tsx`，被没有右边界的写法截成 `.json` / `.ts`）；
 *           补上 `(?![\w])` 后**归零**。⇒ 本规则在扫描集上**零发现、零误报**。
 *       价值是**预防性**的：它抓的是"写成裸相对路径的 `.md` 却解析不到"这一类 ——
 *       2026-10-09 修掉的 `dsfolder/AGENTS.md` 那 5 处死链正是此类（当时 J4 对裸相对路径
 *       全盲，所以它们能长期存活）。
 *       为什么默认不阻塞：它今天在扫描集上零发现，但**其它仓的文档随时会新增**裸相对
 *       文件名引用；按本项目纪律（门禁要么可达、要么先只告警），先只提示，稳定后再翻默认。
 *   W2 `WORKSPACE.md` 里形如 `projects/<name>` 的目录名**必须真实存在**（或显式标为已归档）
 *   W3 工作区内的仓必须能在 `.workspace/projects.json` 找到（J9 的文档侧，反向由 registry 校验器负责）
 *
 * 例外（跳过，不算引用）：
 *   · 代码块内的示例路径（``` 围栏内）
 *   · `node_modules`、`.git`、`<placeholder>`、`…`（省略号）、`$VAR`（未定义变量）
 *   · 明确标 `历史`/`legacy`/`已归档`/`不存在` 的行
 *
 * 用法：
 *   node tools/check-workspace-docs.mjs [--list] [--self-test] [--strict-relative]
 *   （需可读 `~/.dsh` 之外的工作区；运行在 los 仓内）
 */
import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');                     // <repo>/
const WORKSPACE = resolve(ROOT, '../..');             // los-workspace/
const PROJECT_ROOT = resolve(WORKSPACE, '..');        // ~/syncfolder/project/
const HOME = homedir();

/** 扫描面：工作区文档 + 各仓的 AGENTS.md（只取与工作区/路径引用相关的最小集合）。 */
function targets() {
  const out = [
    join(WORKSPACE, 'AGENTS.md'),
    join(WORKSPACE, 'WORKSPACE.md'),
    join(ROOT, 'AGENTS.md'),
    join(ROOT, 'CLAUDE.md'),
  ];
  for (const repo of ['los-memory', 'cantool', 'cankey', 'canpad', 'lot2extension', 'wechatpy', 'wechatdp', 'lzlyx', 'dsfolder']) {
    const f = join(PROJECT_ROOT, repo, 'AGENTS.md');
    if (existsSync(f)) out.push(f);
  }
  return out.filter(existsSync);
}

/** 去掉 fenced code block（示例路径不应被校验）。 */
export function stripFences(text) {
  const lines = text.split('\n');
  const out = [];
  let inFence = false;
  for (const l of lines) {
    if (/^\s*```/.test(l)) { inFence = !inFence; continue; }
    out.push(inFence ? '' : l);
  }
  return out.join('\n');
}

/**
 * 纯函数：从一行里抽取"应当可解析"的路径引用。
 *
 * 设计要点（两次自检失败换来的）：
 *   ① 一次抓**完整 token**（含特殊字符），再判是否占位符 —— 否则字符类会在 `<`/`$`/`*`
 *      前截断，把 `~/projects/<name>/` 误抽成 `~/projects/`（假阳性）。
 *   ② 相对引用必须相对**所在文件目录**解析，不是工作区根。
 *   ③ 以 `-`/`_` 结尾的末段是**前缀/模式**（如 `~/Library/Logs/CanKey/diag-`），跳过。
 */
export function extractPathRefs(line, deps) {
  const { home } = deps;
  const baseDir = deps.baseDir ?? deps.workspace;
  const refs = [];
  // 明确标为历史/不存在的行不校验
  if (/历史|legacy|已归档|不存在|不存在于磁盘|deprecated/i.test(line)) return refs;

  const KINDS = [
    { kind: 'tilde', lead: '~/' },
    { kind: 'dollar-home', lead: '$HOME/' },
    { kind: 'relative', lead: '../' },
    { kind: 'absolute', lead: '/Users/' },
  ];
  // 贪婪抓完整 token：允许字母数字与 . _ - / ~ $ < > * ? [ ] { } … 等
  const TOKEN = new RegExp(String.raw`(?:~/|\$HOME/|\.\./|/Users/)[^\s\u0060|()（），,;:'"]*`, 'g');

  let m;
  while ((m = TOKEN.exec(line)) !== null) {
    const raw = m[0].replace(/[).,;:`]+$/, '');
    if (!raw) continue;
    const hit = KINDS.find(k => raw.startsWith(k.lead));
    if (!hit) continue;
    // 占位符 / 变量 / 通配 / 省略号 → 不是字面路径
    // `$HOME` 是**已定义**变量（我们正是用它解析的），不算占位符；其他 $VAR 跳过
    if (/<|>|…|\$(?!HOME\b)[A-Z_]+|[*?\[\]{}]/.test(raw)) continue;
    // 前缀/模式（末段以 - 或 _ 结尾）
    if (/[-_]$/.test(raw)) continue;
    if (/(node_modules|\.git\/)/.test(raw)) continue;
    if (raw === hit.lead) continue;

    let abs;
    if (hit.kind === 'relative') abs = resolve(baseDir, raw.replace(/\/+$/, '') || '.');
    else if (hit.kind === 'absolute') abs = raw.replace(/\/+$/, '');   // 已是绝对路径，勿拼 home
    else abs = join(home, raw.replace(/^~\/|^\$HOME\//, ''));
    refs.push({ raw, abs, kind: hit.kind });
  }

  // pass 2：裸相对路径里的**文件名式**引用（`a/b.md`、`x/y.jsonl`）——理由见文件头 W1b 的实测。
  // 右边界 `(?![A-Za-z0-9_])` 是必须的：没有它 `runs.jsonl` 会被截成 `runs.json`（实测 2 例假阳性）。
  // 前置排除 `(?<![\w./~$:-])` 保证不与 pass 1 的四种前缀重叠（也不吃 URL 的 `//` 之后）。
  const REL_FILE = /(?<![\w./~$:-])((?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.(?:jsonl|json|toml|ya?ml|tsv|tsx|ts|mjs|cjs|js|sh|bash|rs|csv|txt|log|lock|md))(?![A-Za-z0-9_])/g;
  let rf;
  while ((rf = REL_FILE.exec(line)) !== null) {
    const raw = rf[1];
    // `../` / `./` 开头的由 pass 1（或不该校验）负责。行首时前置 lookbehind 挡不住 `../`，
    // 实测它会让 `../../AGENTS.md` 被 pass 1 与 pass 2 各抓一次（自检 `relative ref resolved
    // from FILE dir` 与 `pass 2 does not double-catch prefixed refs` 就是这么红的）。
    if (raw.startsWith('../') || raw.startsWith('./')) continue;
    if (/<|>|…|\$(?!HOME\b)[A-Z_]+|[*?\[\]{}]/.test(raw)) continue;
    if (/(node_modules|\.git\/)/.test(raw)) continue;
    refs.push({ raw, abs: resolve(baseDir, raw), kind: 'relative-file' });
  }
  return refs;
}

/**
 * 纯函数：WORKSPACE.md 里**声称存在**的 projects/<name> 是否真实存在。
 *
 * 三种声明形态都要认（2026-10-08 自检发现只认第一种会漏检）：
 *   ① `projects/<name>` 明写路径
 *   ② 目录树行：`│   ├── <name>/        # 说明`（名字后有**填充空格**，故不能要求紧跟 `#`）
 *   ③ 项目身份表格行：`| <name> | 语言 | 端口 | 角色 | 状态 |`
 *
 * **标为「历史/legacy/已归档」的声明不算"声称存在"** —— 它们可以不在盘上，
 * 但不能出现在"目录结构"与"身份表"里却暗示当前存在（这正是 2026-10-08 的 W2 缺口）。
 */
export function claimedProjects(text, { workspace, existsFn }) {
  const claims = new Map();   // name -> { line, historical }
  const lines = text.split('\n');
  // 三种状态：
  //   historical  = 明确标为历史/legacy（可以不在盘上）
  //   clarified   = **同时**写明"不在磁盘/已移除/已归档到别处" ⇒ 已澄清，不该 warn
  //   未澄清的历史项才会进 missingButHistorical（文档仍暗示它在那儿）
  const isHist = l => /历史|legacy|已归档|已弃用|deprecated/i.test(l);
  const isClarified = l => /不在磁盘|已移除|不在盘上|removed-from-disk|not-on-disk/i.test(l);

  lines.forEach((line, idx) => {
    let m;
    // ① 明写路径
    const re1 = /`?projects\/([a-z0-9][a-z0-9-]*)\/?`?/gi;
    while ((m = re1.exec(line)) !== null) claims.set(m[1], { line: idx + 1, historical: isHist(line), clarified: isClarified(line) });
    // ② 目录树：允许名字后有填充空格/注释
    const re2 = /^[\s│├└─]*([a-z0-9][a-z0-9-]*)\/\s*(?:#.*)?$/;
    m = re2.exec(line);
    if (m) claims.set(m[1], { line: idx + 1, historical: isHist(line), clarified: isClarified(line) });
    // ③ 表格行：| name | ... | status |  且 status 含 legacy/历史
    const re3 = /^\|\s*([a-z0-9][a-z0-9-]*)\s*\|/;
    m = re3.exec(line);
    if (m && !/^\|\s*(项目|project)\s*\|/i.test(line)) {
      claims.set(m[1], { line: idx + 1, historical: isHist(line), clarified: isClarified(line) });
    }
  });

  const claimed = [...claims.keys()];
  const missing = claimed.filter(n => !existsFn(join(workspace, 'projects', n)) && !claims.get(n).historical);
  // 只有"标了历史但**未澄清不在磁盘**"才算漂移
  const missingButHistorical = claimed.filter(n => {
    const c = claims.get(n);
    return !existsFn(join(workspace, 'projects', n)) && c.historical && !c.clarified;
  });
  return { claimed, missing, missingButHistorical, detail: claims };
}

function selfTest() {
  let fail = 0;
  let total = 0;
  const eq = (label, got, want) => {
    total++;
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      console.error(`self-test FAILED: ${label}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`); fail++;
    }
  };
  const done = () => {
    if (fail) { console.error(`\nself-test: ${fail} of ${total} assertion(s) failed`); process.exit(1); }
    // 计数是**动态**的：此前这里写死过 "… = 15 assertions"，加断言后它就变成了假信息
    // （实测 2026-10-09：实际 25 个断言，那行仍写着 15）。别再写死。
    console.log(`self-test OK: ${String(total)} assertion(s) passed`);
  };
  const deps = { home: '/H', workspace: '/W/los-workspace', projectRoot: '/W' };

  // 抽取
  eq('tilde ref', extractPathRefs('见 `~/projects/los-workspace/AGENTS.md`', deps).map(r => r.abs), ['/H/projects/los-workspace/AGENTS.md']);
  eq('dollar-home ref', extractPathRefs('$HOME/x/y', deps).map(r => r.kind), ['dollar-home']);
  eq('relative ref resolved from FILE dir',
     extractPathRefs('读 ../../AGENTS.md', { ...deps, baseDir: '/W/los-workspace/projects/los' }).map(r => r.abs),
     ['/W/los-workspace/AGENTS.md']);
  eq('relative ref NOT resolved from workspace root',
     extractPathRefs('读 ../../AGENTS.md', { ...deps, baseDir: '/W/los-workspace/projects/los' }).map(r => r.abs)[0] === '/AGENTS.md',
     false);
  eq('absolute ref', extractPathRefs('路径 /Users/e/x', deps).map(r => r.abs), ['/Users/e/x']);
  // 负向：占位符/变量/通配不抽
  eq('skips placeholder', extractPathRefs('`~/projects/<name>/`', deps), []);
  eq('skips $VAR', extractPathRefs('`~/projects/$REPO/`', deps), []);
  eq('skips wildcard', extractPathRefs('`~/projects/*/x`', deps), []);
  // 负向：历史行不校验
  eq('skips historical line', extractPathRefs('历史参考源 ~/projects/lsclaw（已归档）', deps), []);
  // 围栏剥离
  eq('stripFences removes block', stripFences('a\n```\n~/x/y\n```\nb'), 'a\n\nb');
  eq('skips glob prefix', extractPathRefs('`~/Library/Logs/CanKey/diag-`', deps), []);
  eq('skips bracketed glob', extractPathRefs('`~/x/[a-z]*`', deps), []);

  // W1b：裸相对路径里的**文件名式**引用（2026-10-09 加；实测精度见文件头）
  eq('bare relative file ref detected', extractPathRefs('见 `docs/adr/0047-x.md`', deps).map(r => r.kind), ['relative-file']);
  eq('bare relative file ref resolves from FILE dir',
     extractPathRefs('读 `docs/adr/0047-x.md`', { ...deps, baseDir: '/W/los-workspace/projects/los' }).map(r => r.abs),
     ['/W/los-workspace/projects/los/docs/adr/0047-x.md']);
  eq('right boundary keeps .jsonl intact',
     extractPathRefs('`dsfolder/.fmtguard/runs.jsonl`', deps).map(r => r.raw), ['dsfolder/.fmtguard/runs.jsonl']);
  eq('bare relative tsx ref detected', extractPathRefs('`frontend/src/main.tsx`', deps).map(r => r.kind), ['relative-file']);
  // 负向：散文斜杠（这是"全量收裸相对路径"会炸的地方，必须一条都不收）
  eq('skips prose slashes (lang/pkg)', extractPathRefs('| los | TypeScript/pnpm | 平台 |', deps), []);
  eq('skips prose slashes (or-words)', extractPathRefs('ADR/source/contract reconciliation', deps), []);
  eq('skips prose slashes (date range)', extractPathRefs('`in_progress` rows (2026-08-05/08-08 case).', deps), []);
  // 负向：无文件名的裸路径（目录）不属本规则
  eq('skips dir-only bare path', extractPathRefs('见 `docs/adr/`', deps), []);
  // 负向：四种前缀由 pass 1 负责，pass 2 不得重复捕获
  eq('pass 2 does not double-catch prefixed refs',
     extractPathRefs('读 `../x.md`', { ...deps, baseDir: '/W/los-workspace/projects/los' }).map(r => r.kind), ['relative']);

  // claimedProjects
  const existsFn = p => ['/W/los-workspace/projects/los', '/W/los-workspace/projects/weclaw'].includes(p);
  // ① 明写路径 + ② 目录树（名字后有填充空格）+ ③ 表格行
  const doc = [
    '| `projects/los/` ★ |',
    '│   ├── lsclaw/                     # 历史参考源',
    '│   ├── phantom/                    # 当前项目',
    '| weclaw | Node | 1 | 渠道桥 | active |',
  ].join('\n');
  const r = claimedProjects(doc, { workspace: '/W/los-workspace', existsFn });
  eq('claimed found (3 forms)', r.claimed.sort(), ['los', 'lsclaw', 'phantom', 'weclaw']);
  eq('missing only non-historical', r.missing, ['phantom']);
  eq('unclarified historical flagged', r.missingButHistorical, ['lsclaw']);
  const r2 = claimedProjects('│   ├── gone/   # 历史参考源 · **不在磁盘**', { workspace: '/W/los-workspace', existsFn });
  eq('clarified historical NOT flagged', r2.missingButHistorical, []);

  done();
  process.exit(0);
}

const argv = process.argv.slice(2);
if (argv.includes('--self-test')) selfTest();
/** W1b（裸相对的文件名式引用）是否阻塞。默认只提示 —— 见文件头"为什么默认不阻塞"。 */
const STRICT_RELATIVE = argv.includes('--strict-relative');

const deps = { home: HOME, workspace: WORKSPACE, projectRoot: PROJECT_ROOT };
const problems = [];
const warnings = [];
const scanned = [];

for (const abs of targets()) {
  scanned.push(relative(PROJECT_ROOT, abs));
  const text = stripFences(readFileSync(abs, 'utf8'));
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    for (const ref of extractPathRefs(lines[i], { ...deps, baseDir: dirname(abs) })) {
      if (existsSync(ref.abs)) continue;
      const entry = { file: relative(PROJECT_ROOT, abs), line: i + 1, ref: ref.raw, resolved: ref.abs };
      // 裸相对的文件名式引用（W1b）：默认只提示，`--strict-relative` 才阻塞 —— 理由见文件头。
      if (ref.kind === 'relative-file' && !STRICT_RELATIVE) {
        warnings.push({ ...entry, kind: 'W1b-relative-file-unresolved' });
      } else {
        problems.push({ ...entry, kind: ref.kind === 'relative-file' ? 'W1b-relative-file-unresolved' : 'W1-unresolvable-path' });
      }
    }
  }
  // W2 只对 WORKSPACE.md 做
  if (abs.endsWith('WORKSPACE.md')) {
    const { missing, missingButHistorical } = claimedProjects(text, { workspace: WORKSPACE, existsFn: existsSync });
    for (const n of missing) {
      problems.push({ file: relative(PROJECT_ROOT, abs), line: 0, kind: 'W2-claimed-project-missing', ref: `projects/${n}`, resolved: join(WORKSPACE, 'projects', n) });
    }
    // 标为"历史"但不在盘上 ⇒ 不应继续出现在"目录结构/身份表"里（warn 可见，不 error）
    for (const n of missingButHistorical) {
      warnings.push({ file: relative(PROJECT_ROOT, abs), line: 0, kind: 'W2-historical-listed-as-present', ref: `projects/${n}` });
    }
  }
}

/** 每类提示的处置建议（`--list` 与汇总都用它，避免把 W1b 说成 W2 的话）。 */
const WARN_HINT = {
  'W2-historical-listed-as-present': '（文档声明它在，但盘上已无 —— 应移出目录结构表或标为"不在磁盘"）',
  'W1b-relative-file-unresolved': '（裸相对路径解析不到：修正文件名，或写成 `../<工作区相对路径>` 让它可被校验；加 `--strict-relative` 可让它阻塞）',
};

if (argv.includes('--list')) {
  console.log(`扫描 ${scanned.length} 个文档：`);
  for (const s of scanned) console.log(`  · ${s}`);
  console.log(`\n发现 ${problems.length} 条问题、${warnings.length} 条提示：`);
  for (const p of problems) console.log(`  [ERR ] [${p.kind}] ${p.file}${p.line ? ':' + p.line : ''}  ${p.ref}\n      → ${p.resolved}`);
  for (const w of warnings) console.log(`  [WARN] [${w.kind}] ${w.file}${w.line ? ':' + w.line : ''}  ${w.ref}${WARN_HINT[w.kind] ?? ''}`);
}

if (warnings.length) {
  console.log(`\nnote: ${warnings.length} 条文档漂移提示（不阻塞，但应修）：`);
  for (const w of warnings) console.log(`  · [${w.kind}] ${w.file}${w.line ? ':' + w.line : ''}  ${w.ref}`);
  if (warnings.some(w => w.kind === 'W1b-relative-file-unresolved')) {
    console.log('  提示：W1b 类可用 `--strict-relative` 升级为阻塞（扫描集上当前零发现，稳定后可翻默认）。');
  }
}
if (problems.length) {
  console.error(`check-workspace-docs FAILED: ${problems.length} problem(s)`);
  for (const p of problems) console.error(`  - [${p.kind}] ${p.file}${p.line ? ':' + p.line : ''}  ${p.ref}`);
  process.exit(1);
}
console.log(`check-workspace-docs OK: ${scanned.length} doc(s) scanned, all path refs resolve and no phantom project claims${warnings.length ? ` (${warnings.length} drift warning(s))` : ''}`);
