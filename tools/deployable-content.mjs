#!/usr/bin/env node
/**
 * deployable-content.mjs — 「可部署内容标识」的唯一实现。
 *
 * 设计依据：docs/architecture/2026-10-11-cross-platform-content-identity-design.md
 *
 * 为什么把它从 bash 里抽出来：内容摘要此前只存在于 `tools/los.sh` 的一个函数里，
 * 于是 (a) Windows 节点根本算不出内容标识（协调器只能看到 <no-response>，每轮都重跑驱动，
 * 一台崩溃循环的节点长期被记成"已安全回退到旧版"），(b) 文件清单与排除规则无法被第二个
 * 消费者复用（谁要用就得抄一份，而本仓已经两次被"两套实现必然漂移"打中），
 * (c) 诊断"某台节点的摘要为什么不一样"必须手抄那段 find。
 *
 * Node 是机队已有的硬依赖 —— 执行器本身就是 Node 进程，每台节点上都有 node（实测均 v24）。
 *
 * 摘要算法与旧的 bash 管道**逐位一致**（等价性由测试与迁移记录证明）：
 *   逐文件 sha256 → 按路径**字节序**排序 → 以 "<hash>  <path>\n" 拼文本 → 整串 sha256 → 前 12 位十六进制
 * 版本串格式不变：`<base>+b<12hex>`，base 取 packages/executor/package.json 的 version。
 *
 * 用法：
 *   node tools/deployable-content.mjs            # 打印版本串（同 `tools/los.sh build-version`）
 *   node tools/deployable-content.mjs --digest   # 同上
 *   node tools/deployable-content.mjs --files    # 打印摘要覆盖的文件清单（诊断用）
 *   node tools/deployable-content.mjs --json     # { version, base, revision, files }
 *   node tools/deployable-content.mjs --root <dir>   # 对别的树求摘要（默认：本文件所在仓的根）
 *
 * 退出码：0 正常 / 1 用法或读取错误。
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** 摘要覆盖的树根。 */
const ROOTS = ['tools', 'deploy', 'packages', 'contracts'];

/** 任意深度都剪掉的目录（与旧实现逐条一致）。 */
const PRUNED_DIRS = new Set(['node_modules', 'dist', '.turbo', '.los', '.los-runtime']);

/** 文件名层面排除的模式（与旧实现逐条一致）。 */
const EXCLUDED_FILE_PATTERNS = [
  (name) => name.endsWith('.tsbuildinfo'),
  (name) => name === '.DS_Store',
  (name) => name.startsWith('._'), // bsdtar 的 AppleDouble sidecar
];

/**
 * 只在网关主机上跑、因此**不进摘要**的路径（与旧实现逐条一致）。
 *
 * 刻意用排除清单而非包含清单：两个方向的失败代价不对称 —— 新增网关脚本忘记排除只是多一次
 * 无谓滚动（吵但安全），而包含清单漏掉节点侧脚本会让节点静默停在旧内容（安静但危险）。
 */
const EXCLUDED_PATHS = new Set([
  'tools/deploy-to-remote.sh',
  'tools/los-fleet-rollout.sh',
  'tools/los-governance-daily.sh',
  'tools/los-fleet-consistency.sh',
  'tools/los-schedule-ctl.sh',
  'tools/install-los-fleet-snapshot.sh',
  'tools/install-network-observe-bridge.sh',
  'tools/los-fleet-snapshot.plist',
  'tools/network-observe-bridge.plist',
  'tools/sync-network-observe.sh',
  'tools/los-launchd.plist',
  'tools/los-launchd-wrapper.sh',
  'tools/los-wechat-bot-launchd.sh',
  'tools/fleet-maintenance.mts',
  'tools/fleet-maintenance-window.mjs',
  'tools/fleet-maintenance-window.test.mjs',
]);

/** 树根之外的根清单（与旧实现逐条一致）。 */
const ROOT_MANIFESTS = [
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'tsconfig.base.json',
  'turbo.json',
];

/** 路径是否命中 `tools/deploy-drivers/*`。 */
function isExcludedPath(relPath) {
  if (EXCLUDED_PATHS.has(relPath)) return true;
  return relPath.startsWith('tools/deploy-drivers/');
}

/**
 * 摘要覆盖的文件清单，已按**路径字节序**排序。
 *
 * 与旧 `find` 的语义对齐：只收常规文件 —— `find -type f` **不跟随符号链接**，
 * 这里同样跳过（`lstatSync` 而不是 `statSync`），否则同一棵树在两个实现下会得到不同的清单。
 * 非 ASCII 路径按字节序排（旧实现是 `LC_ALL=C sort`）；当前树里全是 ASCII，但这不能靠假设。
 */
export function listFiles(root) {
  const out = [];
  for (const tree of ROOTS) {
    walk(root, tree, out);
  }
  for (const manifest of ROOT_MANIFESTS) {
    const abs = join(root, manifest);
    if (isRegularFile(abs)) out.push(manifest);
  }
  return out.sort(compareBytes);
}

function walk(root, relDir, out) {
  const absDir = join(root, relDir);
  let entries;
  try {
    entries = readdirSync(absDir, { withFileTypes: true });
  } catch {
    return; // 树不存在（例如某节点没有该目录）：跳过，与 find 的行为一致
  }
  for (const entry of entries) {
    const rel = `${relDir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (PRUNED_DIRS.has(entry.name)) continue;
      walk(root, rel, out);
      continue;
    }
    if (entry.isSymbolicLink()) continue; // find -type f 不收符号链接
    if (!entry.isFile()) continue;
    if (EXCLUDED_FILE_PATTERNS.some((match) => match(entry.name))) continue;
    if (isExcludedPath(rel)) continue;
    out.push(rel);
  }
}

function isRegularFile(abs) {
  try {
    return statSync(abs).isFile();
  } catch {
    return false;
  }
}

/** 字节序比较（等价于 `LC_ALL=C sort`；`Array#sort()` 默认的 UTF-16 码元序对非 ASCII 不等价）。 */
function compareBytes(a, b) {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/** 逐文件 sha256 → `"<hash>  <path>\n"` 拼接 → 整串 sha256 → 前 12 位。 */
export function digestOf(root, files = listFiles(root)) {
  const lines = files.map((rel) => {
    const hash = createHash('sha256').update(readFileSync(join(root, rel))).digest('hex');
    // 两个空格是 `shasum -a 256` 的输出格式，必须逐字符一致
    return `${hash}  ${rel}\n`;
  });
  return createHash('sha256').update(lines.join('')).digest('hex').slice(0, 12);
}

export function baseVersion(root) {
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'packages/executor/package.json'), 'utf8'));
    return typeof pkg.version === 'string' && pkg.version ? pkg.version : '0.1.0';
  } catch {
    return '0.1.0';
  }
}

export function describe(root = resolve(HERE, '..')) {
  const files = listFiles(root);
  const revision = digestOf(root, files);
  const base = baseVersion(root);
  return {
    version: revision ? `${base}+b${revision}` : base,
    base,
    revision,
    files,
    root,
  };
}

function main(argv) {
  let mode = 'digest';
  let root = resolve(HERE, '..');
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--digest') mode = 'digest';
    else if (arg === '--files') mode = 'files';
    else if (arg === '--json') mode = 'json';
    else if (arg === '--root') {
      root = resolve(argv[i + 1] ?? '');
      i += 1;
      if (!argv[i]) {
        process.stderr.write('deployable-content: --root needs a directory\n');
        return 1;
      }
    } else if (arg === '-h' || arg === '--help') {
      process.stdout.write(
        'usage: deployable-content.mjs [--digest|--files|--json] [--root <dir>]\n',
      );
      return 0;
    } else {
      process.stderr.write(`deployable-content: unknown argument ${arg}\n`);
      return 1;
    }
  }

  const info = describe(root);
  if (mode === 'files') process.stdout.write(info.files.join('\n') + (info.files.length ? '\n' : ''));
  else if (mode === 'json') process.stdout.write(JSON.stringify(info, null, 2) + '\n');
  else process.stdout.write(info.version + '\n');
  return 0;
}

// 只在被直接执行时跑 main（被 import 时只导出函数，便于测试与复用）
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exit(main(process.argv.slice(2)));
}
