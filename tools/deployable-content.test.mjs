/**
 * deployable-content.test.mjs — 锁住"可部署内容标识"的语义。
 *
 * 为什么这些不变量值得单独一个门禁：摘要的失败形态是**全机队永不收敛**，而它的症状
 * 与"内容真的不同"长得一模一样（2026-10-11 M3 事故：一个被上游删除的文件留在节点上，
 * 摘要永远差一截，排查方向却一度指向传输）。所以下面每一条都对应一次真实事故或一个
 * 明确的设计决定，不是形式化断言：
 *
 *   - 剪枝目录（node_modules/dist/.turbo/.los/.los-runtime）不参与摘要 —— 参与过一次，
 *     后果是每台节点各报一个数（2026-10-06）；
 *   - 网关侧脚本不参与摘要 —— 参与过一次，后果是"改一个网关工具"逼出全集群无谓滚动
 *     （2026-10-07）；
 *   - 摘要与 `--files` 必须同源 —— 诊断"差在哪"完全依赖这一点；
 *   - 修改/新增被覆盖文件必须改变摘要 —— 否则节点会静默停在旧内容；
 *   - 符号链接不跟随（= `find -type f` 的语义）—— 否则同一棵树在两个实现下清单不同。
 *
 * 最后一条 golden 值刻意写死：它把**格式**（逐文件 sha256 → `<hash>  <path>\n` 拼接 →
 * 整串 sha256 → 前 12 位，前缀 `<base>+b`）钉住。改格式必须是一次有意识的迁移，而不是
 * 顺手重构 —— 那会让全机队的收敛声明在无人察觉时失效。
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { describe, digestOf, listFiles } from './deployable-content.mjs';

/** 合成一棵最小树：既包含被覆盖的文件，也包含每一类必须被排除的文件。 */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'los-digest-'));
  const write = (rel, body) => {
    const abs = join(root, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, body);
  };
  write('packages/executor/package.json', JSON.stringify({ name: '@los/executor', version: '9.9.9' }));
  write('packages/agent/src/index.ts', 'export const a = 1;\n');
  write('contracts/x.yaml', 'a: 1\n');
  write('deploy/a.txt', 'deploy\n');
  write('tools/a.sh', '#!/bin/sh\necho a\n');
  write('package.json', '{"name":"fixture"}\n');
  write('pnpm-lock.yaml', 'lockfileVersion: 9\n');
  write('pnpm-workspace.yaml', 'packages:\n  - "packages/*"\n');
  write('tsconfig.base.json', '{}\n');
  write('turbo.json', '{}\n');
  // 以下全部必须**不**参与摘要
  write('tools/node_modules/junk.js', 'junk\n');
  write('packages/agent/dist/out.js', 'junk\n');
  write('packages/agent/.turbo/log', 'junk\n');
  write('packages/agent/.los/state', 'junk\n');
  write('tools/skip.tsbuildinfo', 'junk\n');
  write('tools/.DS_Store', 'junk\n');
  write('tools/._sidecar', 'junk\n');
  write('tools/deploy-to-remote.sh', '#!/bin/bash\n# gateway only\n');
  write('tools/los-fleet-rollout.sh', '#!/bin/bash\n# gateway only\n');
  write('tools/deploy-drivers/windows-service.sh', '#!/bin/bash\n# gateway only\n');
  write('tools/los-governance-daily.sh', '#!/bin/bash\n# gateway only\n');
  write('tools/fleet-maintenance.mts', '// gateway only\n');
  return root;
}

const COVERED = [
  'contracts/x.yaml',
  'deploy/a.txt',
  'package.json',
  'packages/agent/src/index.ts',
  'packages/executor/package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'tools/a.sh',
  'tsconfig.base.json',
  'turbo.json',
];

const NEVER_COVERED = [
  'packages/agent/.los/state',
  'packages/agent/.turbo/log',
  'packages/agent/dist/out.js',
  'tools/._sidecar',
  'tools/.DS_Store',
  'tools/deploy-drivers/windows-service.sh',
  'tools/deploy-to-remote.sh',
  'tools/fleet-maintenance.mts',
  'tools/los-fleet-rollout.sh',
  'tools/los-governance-daily.sh',
  'tools/node_modules/junk.js',
  'tools/skip.tsbuildinfo',
];

test('文件清单就是摘要覆盖的那一份，且剪枝/排除逐条生效', () => {
  const root = fixture();
  try {
    const files = listFiles(root);
    assert.deepEqual(files, COVERED, '清单应恰好等于被覆盖的文件（= --files 的输出）');
    for (const excluded of NEVER_COVERED) {
      assert.ok(!files.includes(excluded), `${excluded} 不应参与摘要`);
    }
    // --digest 必须由同一份清单派生，否则"逐文件比对"这条诊断路径就失效了
    assert.equal(digestOf(root), digestOf(root, files));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('格式被钉住：合成树的版本串等于 golden 值', () => {
  const root = fixture();
  try {
    // golden 值 = sha256 覆盖清单里每个文件的 sha256 行（"<hash>  <path>\n"）后的前 12 位
    assert.equal(describe(root).version, '9.9.9+bedec7a008fa1');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('改动被覆盖的文件会改变摘要（否则节点会静默停在旧内容）', () => {
  const root = fixture();
  try {
    const before = digestOf(root);
    writeFileSync(join(root, 'packages/agent/src/index.ts'), 'export const a = 2;\n');
    assert.notEqual(digestOf(root), before);
    writeFileSync(join(root, 'tools/new-file.sh'), '#!/bin/sh\n');
    assert.notEqual(digestOf(root), before, '新增被覆盖文件同样必须改变摘要');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('剪枝目录与排除项怎么动都不影响摘要', () => {
  const root = fixture();
  try {
    const before = digestOf(root);
    // 越界增删：这些都是"节点上会变、但不该让收敛声明失效"的东西
    writeFileSync(join(root, 'packages/agent/dist/new-bundle.js'), 'x\n');
    writeFileSync(join(root, 'tools/node_modules/another.js'), 'x\n');
    writeFileSync(join(root, 'packages/agent/src/foo.tsbuildinfo'), 'x\n');
    writeFileSync(join(root, 'tools/deploy-drivers/new-driver.sh'), 'x\n');
    writeFileSync(join(root, 'tools/deploy-to-remote.sh'), '#!/bin/bash\n# changed\n');
    rmSync(join(root, 'packages/agent/dist/out.js'));
    assert.equal(digestOf(root), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('符号链接不跟随（与 find -type f 对齐）', () => {
  const root = fixture();
  try {
    const before = digestOf(root);
    symlinkSync(join(root, 'tools/a.sh'), join(root, 'tools/link.sh'));
    assert.equal(digestOf(root), before, '符号链接既不进清单也不进摘要');
    assert.ok(!listFiles(root).includes('tools/link.sh'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('同一棵树重复求摘要稳定（收敛判据的前提）', () => {
  const root = fixture();
  try {
    assert.equal(digestOf(root), digestOf(root));
    assert.equal(describe(root).version, describe(root).version);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
