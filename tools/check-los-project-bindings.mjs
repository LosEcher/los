#!/usr/bin/env node
/**
 * check-los-project-bindings — 「谁可以接 los 派活」与「谁被登记为仓」的机械对照。
 *
 * 依据：ADR 0047（工具/项目边界）、2026-10-11 审计
 * `docs/operations/2026-10-11-dsh-los-cross-project-dispatch-audit.md` §10.3。
 *
 * 背景（实测）：los 的"可派活项目"真源是 `~/.los/projects.json`（binding），而工作区拓扑真源是
 * `los-workspace/.workspace/projects.json`。两者**互不校验** ⇒ 出现两类漂移而不自知：
 *   1. 台账里出现**未绑定项目**的 run（只能来自越权/旁路派发，或绑定被删）——**硬失败**；
 *   2. 已登记仓没有任何 binding 覆盖 ⇒ los 根本够不到（本轮实测 30 个登记仓里 27 个如此）
 *      ——**提示**（是边界，不一定是缺陷；要派活就补 binding）。
 *
 * 判定：
 *   HARD  recent run_specs 的 project_id ∉ bindings         → exit 1（--check 与非 --check 都红）
 *   WARN  登记仓无 binding 覆盖（含父路径覆盖）              → 只报数 + 列前 N 个
 *   WARN  binding 的 workspacePath 不存在                    → 只报
 * 跳过（**显式 skip，不伪装成通过**）：
 *   · binding 文件不存在（CI / 新机器）
 *   · 无 psql 或 DATABASE_URL ⇒ 跳过 HARD 检查并写明原因
 *
 * 用法：
 *   node tools/check-los-project-bindings.mjs            # 报告（HARD 才 exit 1）
 *   node tools/check-los-project-bindings.mjs --json
 *   node tools/check-los-project-bindings.mjs --days 30  # HARD 检查的时间窗（缺省 30 天）
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REGISTRY = resolve(ROOT, '..', '..', '.workspace', 'projects.json');
const BINDINGS_FILE = join(process.env.LOS_PROJECTS_DIR ?? join(homedir(), '.los'), 'projects.json');
const ENV_FILE = join(ROOT, '.env');

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const daysIndex = argv.indexOf('--days');
const DAYS = daysIndex >= 0 ? Number(argv[daysIndex + 1]) : 30;

const readJson = path => {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
};

/** 取单个 .env 键（不 source 整份文件）。 */
const envValue = key => {
  if (!existsSync(ENV_FILE)) return null;
  const line = readFileSync(ENV_FILE, 'utf8').split('\n').find(l => l.startsWith(`${key}=`));
  return line ? line.slice(key.length + 1).replace(/^"|"$/g, '') : null;
};

/** 收集工作区登记里的仓（顶层 + 子仓）；同时给出已归档集合（归档仓无 binding 属预期）。 */
function registeredRepos(registry) {
  const out = [];
  const archived = new Set();
  // 命名口径差异（实测）：登记里子仓 key 是 `run-diff`，而 binding 与台账用 `dsfolder-run-diff`
  // ⇒ 归档豁免要对两种写法都生效，否则历史残留会被误判成漂移。
  const consider = (key, path, kind, parentKey) => {
    if (kind === 'archived') {
      archived.add(key);
      if (parentKey) archived.add(`${parentKey}-${key}`);
    }
    if (path) out.push({ key, path: resolve(path) });
  };
  for (const project of registry?.projects ?? []) {
    consider(project.key, project.path, project.kind);
    for (const child of project.children ?? []) {
      const childPath = child.path ? resolve(child.path) : (project.path ? join(resolve(project.path), child.key) : null);
      consider(child.key, childPath, child.kind, project.key);
    }
  }
  return { repos: out, archived };
}

/** 某路径是否被某 binding 覆盖（binding 路径是其祖先或本身）。 */
const coveredBy = (target, bindings) => bindings.some(binding => {
  const base = `${resolve(binding.workspacePath)}${sep}`;
  const self = resolve(binding.workspacePath);
  return target === self || target.startsWith(base);
});

function dbProjectIds(days) {
  const psql = ['/opt/homebrew/opt/libpq/bin/psql', 'psql']
    .find(candidate => { try { execFileSync(candidate, ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } });
  if (!psql) return { skipped: 'psql 不在 PATH（也未在 /opt/homebrew/opt/libpq/bin）' };
  const url = process.env.DATABASE_URL ?? envValue('DATABASE_URL');
  if (!url) return { skipped: 'DATABASE_URL 未设置（.env 与进程环境都没有）' };
  try {
    const out = execFileSync(psql, [url, '-t', '-A', '-c',
      `select coalesce(project_id,'(null)') || '|' || count(*) from run_specs where created_at > now() - interval '${Number(days)} days' group by project_id order by count(*) desc;`,
    ], { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] });
    return { rows: out.trim().split('\n').filter(Boolean).map(line => {
      const [projectId, count] = line.split('|');
      return { projectId, count: Number(count) };
    }) };
  } catch (error) {
    // stderr 的首行才是真因（如 SQL 语法/连接失败）；不要把静默失败写成"通过"
    const stderr = String(error.stderr ?? '').trim().split('\n')[0];
    return { skipped: `psql 查询失败：${stderr || error.message.split('\n')[0]}` };
  }
}

const registry = readJson(REGISTRY);
const bindingsFile = readJson(BINDINGS_FILE);
if (!bindingsFile) {
  console.log(`SKIP: 未找到 los 项目绑定文件（${BINDINGS_FILE}）——CI/新机器属预期，不判失败`);
  process.exit(0);
}
if (!registry) {
  console.log(`SKIP: 未找到工作区登记（${REGISTRY}）——无法对照`);
  process.exit(0);
}

const bindings = Object.entries(bindingsFile.projects ?? {}).map(([projectId, info]) => ({
  projectId,
  workspacePath: info.workspacePath,
}));
const boundIds = new Set(bindings.map(b => b.projectId));
const { repos, archived } = registeredRepos(registry);

const unreachable = repos.filter(repo => !boundIds.has(repo.key) && !coveredBy(repo.path, bindings));
const missingPaths = bindings.filter(b => !existsSync(b.workspacePath ?? ''));
const db = dbProjectIds(DAYS);
const unboundAll = db.rows ? db.rows.filter(row => row.projectId !== '(null)' && !boundIds.has(row.projectId)) : [];
// 已归档仓（如 run-diff，2026-10-08 退役）的历史 run 属预期残留，不计硬违规；但要在报告里点名
const unboundExempt = unboundAll.filter(row => archived.has(row.projectId));
const unboundRuns = unboundAll.filter(row => !archived.has(row.projectId));

const hard = unboundRuns.length > 0;
const report = {
  bindingsFile: BINDINGS_FILE,
  registry: REGISTRY,
  bindings: bindings.length,
  registeredRepos: repos.length,
  unreachableCount: unreachable.length,
  unreachableSample: unreachable.slice(0, 12).map(r => r.key),
  missingBindingPaths: missingPaths.map(b => `${b.projectId} → ${b.workspacePath}`),
  db: db.skipped ? { skipped: db.skipped } : { windowDays: DAYS, rows: db.rows },
  unboundRunProjects: unboundRuns,
  unboundRunProjectsExemptArchived: unboundExempt,
};

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`los bindings: ${bindings.length} 个（${BINDINGS_FILE}）`);
  console.log(`工作区登记仓: ${repos.length} 个（${REGISTRY}）`);
  console.log(`无 binding 覆盖（los 够不到）: ${unreachable.length} 个${unreachable.length ? ` — ${unreachable.slice(0, 12).map(r => r.key).join(', ')}${unreachable.length > 12 ? ' …' : ''}` : ''}`);
  if (missingPaths.length) console.log(`⚠ binding 指向不存在的路径: ${missingPaths.map(b => b.projectId).join(', ')}`);
  if (db.skipped) {
    console.log(`SKIP(部分): 未做"台账里是否有未绑定项目"检查 — ${db.skipped}`);
  } else {
    console.log(`近 ${DAYS} 天台账项目（${db.rows.length} 个）: ${db.rows.map(r => `${r.projectId}×${r.count}`).join(', ')}`);
    if (unboundExempt.length) {
      console.log(`ℹ 已归档仓的历史 run（绑定已随退役移除，预期残留）: ${unboundExempt.map(r => `${r.projectId}×${r.count}`).join(', ')}`);
    }
    console.log(unboundRuns.length
      ? `❌ 台账出现未绑定项目: ${unboundRuns.map(r => `${r.projectId}×${r.count}`).join(', ')}`
      : '✅ 台账里的活跃项目都有 binding');
  }
}

process.exit(hard ? 1 : 0);
