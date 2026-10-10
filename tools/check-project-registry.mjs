#!/usr/bin/env node
/**
 * check-project-registry.mjs — 工作区仓拓扑登记（projects.json）的机械校验器。
 *
 * 依据：ADR 0047 第 4 节 + 判据 J9（内嵌仓必须被登记）/ J10（无 VCS 的代码目录不得进入交付链）。
 *
 * 校验项：
 *   R1 version 是正整数；workspaceRoot 存在
 *   R2 project.key 全局唯一（含 children）
 *   R3 project.path 存在
 *   R4 kind ∈ {repo, umbrella, dir}
 *   R5 kind=repo ⇒ vcs ≠ none，除非提供 vcsExemptReason
 *   R6 vcs ∈ {git, jj, git+jj, none}；vcs=none 时 remote 必须为 null
 *   R7 agentsDoc 声明为路径时必须存在（null 表示"确认缺失"，不算错）
 *   R8 kind=umbrella ⇒ 必须有非空 children[]，且每个 child 的 path 在磁盘上存在
 *   R9 反向完备性：扫描 ~/.dsh/sessions/* 的 cwd，凡近 N 天有会话但未登记的仓 → 报告
 *      为 unregistered（**默认只警告**，因为会有 /tmp、/.dsh 等非仓 cwd；--strict 时红）
 *   R10 manifest 声明为路径时必须存在于该仓根
 *
 * 负向控制（--self-test）：语料内注入 R2/R5/R7/R8 违规，必须全部被咬住。
 *
 * 用法：
 *   node tools/check-project-registry.mjs [--strict] [--self-test] [--list]
 *   （需在安装了 `yaml` 的工作区语境下跑；本脚本只用 node 内置 + JSON，故可直接跑）
 */
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
// tools/ → <repo>/ → projects/ → los-workspace/
const WORKSPACE_ROOT = resolve(HERE, '../../..');
const REGISTRY = resolve(WORKSPACE_ROOT, '.workspace/projects.json');
const DSH_SESSIONS = join(homedir(), '.dsh', 'sessions');

const KINDS = new Set(['repo', 'umbrella', 'dir', 'archived']);
// 'archived' = 已裁决退役但保留代码的条目：豁免 R5（J10 无 VCS 禁入交付链），
// 因为"移出交付链"正是归档动作本身；但必须写 archivedAt / archiveReason / reviveCondition。
const ARCHIVE_REQUIRED = ['archivedAt', 'archiveReason', 'reviveCondition'];
const VCS = new Set(['git', 'jj', 'git+jj', 'none']);

/** 把 registry 摊平成 entries（含 children），便于统一校验。 */
export function flatten(registry) {
  const out = [];
  for (const p of registry.projects ?? []) {
    out.push({ ...p, _parent: null });
    for (const c of p.children ?? []) out.push({ ...c, _parent: p.key });
  }
  return out;
}

/** 纯函数：校验一份已解析的 registry，返回 problems[]。 */
export function validateRegistry(registry) {
  const problems = [];
  if (!registry || typeof registry !== 'object') return ['registry is not an object'];
  if (!Number.isInteger(registry.version) || registry.version < 1) problems.push('version must be a positive integer');
  if (typeof registry.workspaceRoot !== 'string' || !existsSync(registry.workspaceRoot)) {
    problems.push(`workspaceRoot does not exist: ${registry.workspaceRoot}`);
  }
  if (!Array.isArray(registry.projects) || registry.projects.length === 0) {
    problems.push('projects must be a non-empty list');
    return problems;
  }

  const entries = flatten(registry);
  const seen = new Map();

  for (const e of entries) {
    const where = `${e._parent ? `${e._parent}/` : ''}${e.key ?? '(no key)'}`;

    // R2
    if (typeof e.key !== 'string' || !e.key.trim()) {
      problems.push(`${where}: key must be a non-empty string`);
    } else if (seen.has(e.key)) {
      problems.push(`${where}: duplicate key "${e.key}" (also at ${seen.get(e.key)})`);
    } else {
      seen.set(e.key, where);
    }

    // R4
    if (!KINDS.has(e.kind)) problems.push(`${where}: kind "${e.kind}" not in [${[...KINDS].join(', ')}]`);

    // R3
    if (typeof e.path !== 'string' || !existsSync(e.path)) {
      problems.push(`${where}: path does not exist: ${e.path}`);
    }

    // R6
    if (!VCS.has(e.vcs)) problems.push(`${where}: vcs "${e.vcs}" not in [${[...VCS].join(', ')}]`);
    if (e.vcs === 'none' && e.remote !== null && e.remote !== undefined) {
      problems.push(`${where}: vcs=none must have remote=null (got ${JSON.stringify(e.remote)})`);
    }

    // R5 / J10（archived 豁免，因为归档本身就是"移出交付链"）
    if (e.kind === 'repo' && e.vcs === 'none' && !e.vcsExemptReason) {
      problems.push(`${where}: kind=repo with vcs=none requires vcsExemptReason (J10: no-VCS dirs must not enter the delivery chain silently)`);
    }

    // R11：archived 条目必须写明归档理由与复活条件
    if (e.kind === 'archived') {
      for (const k of ARCHIVE_REQUIRED) {
        if (typeof e[k] !== 'string' || !e[k].trim()) {
          problems.push(`${where}: kind=archived requires ${k} (归档必须写明理由与复活条件，否则无法复审)`);
        }
      }
    }

    // R7
    if (typeof e.agentsDoc === 'string' && e.agentsDoc.length > 0) {
      const docPath = join(e.path ?? '', e.agentsDoc);
      if (!existsSync(docPath)) problems.push(`${where}: agentsDoc "${e.agentsDoc}" declared but missing at ${docPath}`);
    }

    // R12：archived 条目不应再声明 manifest（它已移出交付链）
    if (e.kind === 'archived' && typeof e.manifest === 'string' && e.manifest.length > 0) {
      problems.push(`${where}: kind=archived must not declare manifest (it is out of the delivery chain)`);
    }

    // R10
    if (typeof e.manifest === 'string' && e.manifest.length > 0) {
      const mPath = join(e.path ?? '', e.manifest);
      if (!existsSync(mPath)) problems.push(`${where}: manifest "${e.manifest}" declared but missing at ${mPath}`);
    }

    // R8
    if (e.kind === 'umbrella') {
      if (!Array.isArray(e.children) || e.children.length === 0) {
        problems.push(`${where}: kind=umbrella requires a non-empty children[]`);
      }
    }
    if (e._parent && Array.isArray(e.children)) {
      problems.push(`${where}: nested children not supported (one level only)`);
    }
  }

  // R9 反向完备性（警告级）
  const warnings = unregisteredProjects(registry, entries);
  if (warnings.length) {
    for (const w of warnings) problems.push(`UNREGISTERED (warning): ${w}`);
  }
  return problems;
}

/**
 * R9：从 DSH 会话的 **cwd 明文列** 反查未登记的顶层仓。
 *
 * ⚠️ 为什么不用 `~/.dsh/sessions/<slug>/` 目录名解码：DSH 把 cwd 编成
 * `--Users-…--` 形式，**`-` 与真实连字符无法区分**（实测
 * `.dsh/scheduler-reports` → 天真解码成 `.dsh/scheduler/reports`），
 * `~` 还有 ~XXXX 转义。按 slug 解码会让本判据**静默失效**（返回 0 个候选却看似正常）。
 * 因此改读 `~/.dsh/storages/session-index.db` 的 `sessions.cwd`（明文、精确）。
 */
export function unregisteredProjects(registry, entries, { days = 30, indexPath = DSH_SESSIONS } = {}) {
  const dbPath = join(homedir(), '.dsh', 'storages', 'session-index.db');
  if (!existsSync(dbPath)) return [];
  const cutoff = Date.now() - days * 86400_000;
  let rows = [];
  try {
    // 不加 -readonly：对缺失 -shm 的 WAL 库会以 (14) 失败（只跑 SELECT，不写）
    const out = execFileSync('sqlite3', [
      dbPath,
      `SELECT DISTINCT cwd FROM sessions WHERE created_at > ${cutoff} ORDER BY cwd;`,
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 20_000 });
    rows = out.split('\n').map(s => s.trim()).filter(Boolean);
  } catch {
    // sqlite3 不可用或库被占用 → 不阻断校验，但也**不得**静默报"全部已登记"
    return ['WARNING: could not read session-index.db (sqlite3 unavailable or locked) — reverse-completeness not verified'];
  }

  const registered = entries.filter(e => !e._parent).map(e => String(e.path ?? '').replace(/\/+$/, ''));
  const out = [];
  for (const abs of rows) {
    const norm = abs.replace(/\/+$/, '');
    if (!existsSync(norm)) continue;
    // 已登记仓本身或其子目录 ⇒ 不算未登记
    if (registered.some(r => r && (norm === r || norm.startsWith(r + '/')))) continue;
    // 看起来像仓/项目根才报（过滤 /private/tmp、~/.dsh 缓存等）
    const looksLikeProject = existsSync(join(norm, '.git')) || existsSync(join(norm, '.jj'))
      || ['package.json', 'Cargo.toml', 'go.mod', 'pyproject.toml', 'Makefile'].some(m => existsSync(join(norm, m)));
    if (!looksLikeProject) continue;
    // 已登记 umbrella 的子仓目录（如 dsfolder/rustopt）不算未登记
    if (registered.some(r => r && norm.startsWith(r + '/'))) continue;
    out.push(`${norm} has sessions in the last ${days}d and looks like a repo but is not registered`);
  }
  return out.sort();
}

// ── 负向控制 ──
function selfTest() {
  const tmp = '/tmp';
  const good = {
    version: 1,
    workspaceRoot: tmp,
    projects: [
      { key: 'a', path: tmp, kind: 'repo', vcs: 'git', remote: 'x', agentsDoc: null, manifest: null },
      {
        key: 'u', path: tmp, kind: 'umbrella', vcs: 'git', remote: 'x', agentsDoc: null,
        children: [{ key: 'c1', path: tmp, kind: 'repo', vcs: 'git', remote: 'y', agentsDoc: null }],
      },
    ],
  };
  const clone = () => JSON.parse(JSON.stringify(good));
  const cases = [
    ['R2 duplicate key', () => { const d = clone(); d.projects.push({ key: 'a', path: tmp, kind: 'repo', vcs: 'git', remote: null }); return d; }, /duplicate key/],
    ['R5 repo with vcs=none and no exempt', () => { const d = clone(); d.projects[0].vcs = 'none'; d.projects[0].remote = null; return d; }, /requires vcsExemptReason/],
    ['R5 repo vcs=none WITH exempt passes rule', () => { const d = clone(); d.projects[0].vcs = 'none'; d.projects[0].remote = null; d.projects[0].vcsExemptReason = 'ok'; return d; }, null],
    ['R3 missing path', () => { const d = clone(); d.projects[0].path = '/nonexistent/xyz'; return d; }, /path does not exist/],
    ['R4 bad kind', () => { const d = clone(); d.projects[0].kind = 'weird'; return d; }, /kind "weird" not in/],
    ['R6 vcs=none with remote set', () => { const d = clone(); d.projects[0].vcs = 'none'; d.projects[0].remote = 'x'; d.projects[0].vcsExemptReason = 'ok'; return d; }, /must have remote=null/],
    ['R7 agentsDoc declared but missing', () => { const d = clone(); d.projects[0].agentsDoc = 'AGENTS.md'; return d; }, /agentsDoc "AGENTS.md" declared but missing/],
    ['R8 umbrella without children', () => { const d = clone(); delete d.projects[1].children; return d; }, /requires a non-empty children/],
    ['R10 manifest declared but missing', () => { const d = clone(); d.projects[0].manifest = 'package.json'; return d; }, /manifest "package.json" declared but missing/],
    ['R1 bad version', () => { const d = clone(); d.version = 'one'; return d; }, /version must be a positive integer/],
    ['R11 archived without archiveReason', () => { const d = clone(); d.projects[0].kind = 'archived'; d.projects[0].vcs = 'none'; d.projects[0].remote = null; d.projects[0].archivedAt = 'x'; d.projects[0].reviveCondition = 'y'; return d; }, /kind=archived requires archiveReason/],
    ['R12 archived with manifest', () => { const d = clone(); d.projects[0].kind = 'archived'; d.projects[0].vcs = 'none'; d.projects[0].remote = null; d.projects[0].archivedAt = 'x'; d.projects[0].archiveReason = 'y'; d.projects[0].reviveCondition = 'z'; d.projects[0].manifest = 'Cargo.toml'; return d; }, /kind=archived must not declare manifest/],
  ];
  let failures = 0;
  for (const [label, make, expect] of cases) {
    const problems = validateRegistry(make());
    if (expect === null) {
      const real = problems.filter(p => !/UNREGISTERED/.test(p));
      if (real.length) { console.error(`self-test FALSE POSITIVE: ${label} should pass but got: ${real.join('; ')}`); failures++; }
      continue;
    }
    if (!problems.some(p => expect.test(p))) {
      console.error(`self-test NEGATIVE CONTROL FAILED: ${label} not caught (got: ${problems.join('; ') || 'none'})`);
      failures++;
    }
  }
  if (failures) { console.error(`\nself-test: ${failures} failure(s) out of ${cases.length}`); process.exit(1); }
  console.log(`self-test OK: ${cases.length - 1}/${cases.length - 1} negative controls caught + 1 positive case clean`);
  process.exit(0);
}

const argv = process.argv.slice(2);
if (argv.includes('--self-test')) selfTest();

if (!existsSync(REGISTRY)) {
  console.error(`check-project-registry: missing ${REGISTRY}`);
  process.exit(2);
}
let registry;
try {
  registry = JSON.parse(readFileSync(REGISTRY, 'utf8'));
} catch (e) {
  console.error(`check-project-registry: JSON parse failed: ${e.message}`);
  process.exit(2);
}

const problems = validateRegistry(registry);
const hard = problems.filter(p => !/^UNREGISTERED/.test(p));
const soft = problems.filter(p => /^UNREGISTERED/.test(p));
const entries = flatten(registry);

if (argv.includes('--list')) {
  console.log(`project registry v${registry.version} — ${registry.projects.length} top-level, ${entries.length} entries`);
  console.log('─'.repeat(90));
  for (const e of entries) {
    const indent = e._parent ? '    └─ ' : '';
    const vcs = String(e.vcs ?? '?').padEnd(7);
    const remote = e.remote ? 'remote' : (e.vcsExemptReason || e.remoteExemptReason ? 'exempt' : '—');
    console.log(`${indent}${String(e.key).padEnd(28)} ${String(e.kind).padEnd(9)} ${vcs} ${remote.padEnd(6)} ${e.role ?? ''}`);
  }
}

if (soft.length) {
  console.log(`\nunregistered candidates (${soft.length}) — 这些目录近 ${30} 天有 DSH 会话且像仓，但未登记：`);
  for (const s of soft) console.log(`  · ${s.replace(/^UNREGISTERED \(warning\): /, '')}`);
}

if (hard.length) {
  console.error(`\ncheck-project-registry FAILED: ${hard.length} problem(s)`);
  for (const p of hard) console.error(`  - ${p}`);
  process.exit(1);
}
if (soft.length && argv.includes('--strict')) {
  console.error(`\ncheck-project-registry FAILED (--strict): ${soft.length} unregistered candidate(s)`);
  process.exit(1);
}
console.log(`\ncheck-project-registry OK: ${entries.length} entries across ${registry.projects.length} top-level projects${soft.length ? ` (${soft.length} unregistered candidate(s) reported, not fatal)` : ''}`);
