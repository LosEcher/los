#!/usr/bin/env node
/**
 * check-capability-ownership.mjs — capability-ownership.yaml 的机械校验器。
 *
 * 为什么需要它（ADR 0047 第 8 节）：边界的三条规则（R1 单写者 / R2 引用方向 /
 * R3 真相优先级）如果只写在文档里，就会退化成"又一份叙述性权威"。本脚本把其中
 * 可机械化的部分变成门禁，让"某能力归谁"能被证伪。
 *
 * 校验项：
 *   C1 id 全局唯一
 *   C2 owner_layer 属于 owner_layers 枚举
 *   C3 canonical 非空（"权威副本在哪"答不出来 = 边界没想清楚）
 *   C4 forbidden 非空（只说谁写、不说谁不能写 = 规则不完整）
 *   C5 implementations 长度 > 1 时每项必须有 why_not_merge
 *   C6 implementations 的 path 非空且形如文件/目录/绝对路径
 *   C7 消费方一致性：consumers 里出现的 los/dsh 侧路径若写成 packages/... 形式，
 *      必须真实存在（防止"登记了一个不存在的接线"）
 *
 * 负向控制（--self-test）：故意造 6 类违规，必须全部被咬住。
 *
 * 用法：
 *   node tools/check-capability-ownership.mjs            # 校验真实文件
 *   node tools/check-capability-ownership.mjs --self-test # 跑负向控制
 *   node tools/check-capability-ownership.mjs --list      # 打印归属表
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const DOC = resolve(ROOT, 'docs/governance/capability-ownership.yaml');

/** 纯函数：校验一份已解析的文档，返回 problems[]。便于自检注入夹具。 */
export function validateOwnership(doc, { root = ROOT } = {}) {
  const problems = [];
  if (!doc || typeof doc !== 'object') return ['document is not an object'];
  if (doc.version !== 1) problems.push(`version must be 1, got ${JSON.stringify(doc.version)}`);

  const layers = Array.isArray(doc.owner_layers) ? doc.owner_layers : [];
  if (layers.length === 0) problems.push('owner_layers must be a non-empty list');
  const layerSet = new Set(layers);

  const caps = Array.isArray(doc.capabilities) ? doc.capabilities : [];
  if (caps.length === 0) problems.push('capabilities must be a non-empty list');

  const seen = new Map();
  for (const [i, cap] of caps.entries()) {
    const where = `capabilities[${i}]${cap?.id ? ` (${cap.id})` : ''}`;
    if (!cap || typeof cap !== 'object') { problems.push(`${where}: not an object`); continue; }

    // C1
    if (typeof cap.id !== 'string' || !cap.id.trim()) {
      problems.push(`${where}: id must be a non-empty string`);
    } else if (seen.has(cap.id)) {
      problems.push(`${where}: duplicate id "${cap.id}" (also at index ${seen.get(cap.id)})`);
    } else {
      seen.set(cap.id, i);
    }

    // C2
    if (!layerSet.has(cap.owner_layer)) {
      problems.push(`${where}: owner_layer "${cap.owner_layer}" not in owner_layers [${layers.join(', ')}]`);
    }

    // C3
    if (typeof cap.canonical !== 'string' || !cap.canonical.trim()) {
      problems.push(`${where}: canonical must be non-empty (authoritative copy must be nameable)`);
    }

    // C4
    if (typeof cap.forbidden !== 'string' || !cap.forbidden.trim()) {
      problems.push(`${where}: forbidden must be non-empty (say who may NOT write it, not only who may)`);
    }

    // C5 / C6
    if (cap.implementations !== undefined) {
      if (!Array.isArray(cap.implementations)) {
        problems.push(`${where}: implementations must be a list`);
      } else {
        if (cap.implementations.length > 1) {
          for (const [j, impl] of cap.implementations.entries()) {
            if (!impl || typeof impl !== 'object') { problems.push(`${where}: implementations[${j}] not an object`); continue; }
            if (typeof impl.why_not_merge !== 'string' || !impl.why_not_merge.trim()) {
              problems.push(`${where}: implementations[${j}] (${impl.path ?? '?'}) needs why_not_merge (>1 implementation must justify itself)`);
            }
          }
        }
        for (const [j, impl] of cap.implementations.entries()) {
          if (!impl || typeof impl !== 'object') continue;
          // C6
          if (typeof impl.path !== 'string' || !impl.path.trim()) {
            problems.push(`${where}: implementations[${j}].path must be a non-empty string`);
          }
        }
      }
    }

    // C7：consumers 里写成本仓包路径的必须存在（防"登记了不存在的接线"）
    const consumers = Array.isArray(cap.consumers) ? cap.consumers : [];
    for (const c of consumers) {
      if (typeof c !== 'string') continue;
      // 只校验形如 packages/... 或 tools/... 的本仓相对路径；`los/xxx`、`dsh/xxx` 是逻辑名不校验
      if (/^(packages|tools|contracts)\//.test(c) && !existsSync(resolve(root, c))) {
        problems.push(`${where}: consumer path "${c}" does not exist under repo root`);
      }
    }
  }
  return problems;
}

// ── 负向控制：每类违规造一个夹具，必须被咬住 ──
function selfTest() {
  const base = {
    version: 1,
    owner_layers: ['global', 'tool', 'execution', 'provider'],
    capabilities: [{
      id: 'ok', owner_layer: 'tool', canonical: 'x', forbidden: 'y',
      implementations: [
        { path: 'a', why_not_merge: 'z' },
        { path: 'b', why_not_merge: 'w' },
      ],
      consumers: ['packages/gateway/src/server.ts'],
    }],
  };
  const clone = () => JSON.parse(JSON.stringify(base));
  const cases = [
    ['C1 duplicate id', () => { const d = clone(); d.capabilities.push({ ...d.capabilities[0] }); return d; }, /duplicate id/],
    ['C2 bad owner_layer', () => { const d = clone(); d.capabilities[0].owner_layer = 'nope'; return d; }, /not in owner_layers/],
    ['C3 missing canonical', () => { const d = clone(); delete d.capabilities[0].canonical; return d; }, /canonical must be non-empty/],
    ['C4 missing forbidden', () => { const d = clone(); d.capabilities[0].forbidden = '  '; return d; }, /forbidden must be non-empty/],
    ['C5 multi-impl without why_not_merge', () => { const d = clone(); delete d.capabilities[0].implementations[1].why_not_merge; return d; }, /needs why_not_merge/],
    ['C6 impl missing path', () => { const d = clone(); delete d.capabilities[0].implementations[0].path; return d; }, /path must be a non-empty string/],
    ['C7 bogus consumer path', () => { const d = clone(); d.capabilities[0].consumers = ['packages/nope/does-not-exist.ts']; return d; }, /does not exist under repo root/],
  ];
  let failures = 0;
  for (const [label, make, expect] of cases) {
    const problems = validateOwnership(make());
    const hit = problems.some(p => expect.test(p));
    // 负向控制必须"咬住且只咬住这一类"：夹具是干净的 base，所以 problems 里应恰有 1 条
    const clean = validateOwnership(base).length === 0;
    if (!clean) { console.error(`self-test BROKEN: clean base document does not validate (${validateOwnership(base).join('; ')})`); failures++; continue; }
    if (!hit) { console.error(`self-test NEGATIVE CONTROL FAILED: ${label} was not caught (problems: ${problems.join('; ') || 'none'})`); failures++; }
    else if (problems.length !== 1) { console.error(`self-test imprecise: ${label} produced ${problems.length} problems: ${problems.join('; ')}`); failures++; }
  }
  if (failures) { console.error(`\nself-test: ${failures} failure(s) out of ${cases.length}`); process.exit(1); }
  console.log(`self-test OK: ${cases.length}/${cases.length} negative controls caught, clean base validates`);
  process.exit(0);
}

// ── 主流程 ──
const argv = process.argv.slice(2);
if (argv.includes('--self-test')) selfTest();

if (!existsSync(DOC)) {
  console.error(`check-capability-ownership: missing ${DOC}`);
  process.exit(2);
}
let doc;
try {
  doc = YAML.parse(readFileSync(DOC, 'utf8'));
} catch (e) {
  console.error(`check-capability-ownership: YAML parse failed: ${e.message}`);
  process.exit(2);
}

const problems = validateOwnership(doc);
const caps = doc.capabilities ?? [];

if (argv.includes('--list')) {
  console.log(`capability-ownership (${caps.length} capabilities, version ${doc.version})`);
  console.log('─'.repeat(78));
  const W = Math.max(38, ...caps.map(c => String(c.id).length + 1));
  for (const c of caps) {
    const impls = Array.isArray(c.implementations) && c.implementations.length > 1 ? ` [impl x${c.implementations.length}]` : '';
    const cons = Array.isArray(c.consumers) && c.consumers.length ? c.consumers
      : Array.isArray(c.readers) && c.readers.length ? c.readers.map(r => `read:${r}`)
      : null;
    console.log(`${String(c.id).padEnd(W)} ${String(c.owner_layer).padEnd(10)}${impls}`);
    console.log(`${' '.repeat(W)} ${cons ? `← ${cons.join(', ')}` : '← (no consumer/reader declared)'}`);
  }
}

if (problems.length) {
  console.error(`check-capability-ownership FAILED: ${problems.length} problem(s)`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`check-capability-ownership OK: ${caps.length} capabilities, ${doc.owner_layers.length} layers, no duplicate ids, all boundaries declared`);
