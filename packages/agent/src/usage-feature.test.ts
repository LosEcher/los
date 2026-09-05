import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { normalizeUsageFeature, USAGE_FEATURES } from './usage-feature.js';

/**
 * per-purpose 成本归因 guard（R-LOS-01）。
 *
 * 验收 1：新增调用点未登记 purpose 时构建/CI 失败。
 * 三层机械防线：
 *  1. 编译期 — ChatOptions/AgentConfig.feature 为 UsageFeature 联合类型
 *     （未登记字面量直接 tsc 失败）。
 *  2. 运行时 — normalizeUsageFeature 未知 purpose 默认 warn、fail 模式抛错
 *     （本测试覆盖）。
 *  3. 扫描 — 源码 `feature: '<lit>'` 字面量必须都在 USAGE_FEATURES 内
 *     （防 `as UsageFeature` / 宽松 string 传值绕过编译期检查，本测试覆盖）。
 */

const PACKAGES = fileURLToPath(new URL('../../', import.meta.url));

describe('usage-feature purpose guard', () => {
  it('normalizes registered purposes to themselves', () => {
    for (const f of USAGE_FEATURES) {
      assert.equal(normalizeUsageFeature(f), f, `${f} should pass through`);
    }
  });

  it('normalizes null/undefined/unknown to unspecified (warn path)', () => {
    assert.equal(normalizeUsageFeature(undefined), 'unspecified');
    assert.equal(normalizeUsageFeature(null), 'unspecified');
    assert.equal(normalizeUsageFeature('brand_new_surface'), 'unspecified');
    assert.equal(normalizeUsageFeature(42), 'unspecified');
  });

  it('throws in fail mode for an unregistered purpose', () => {
    assert.throws(
      () => normalizeUsageFeature('brand_new_surface', { fail: true }),
      /Unknown usage purpose "brand_new_surface".*register it in @los\/agent\/usage-feature/,
    );
    // Registered purposes never throw.
    assert.doesNotThrow(() => normalizeUsageFeature('chat', { fail: true }));
  });

  it('every `feature: \'<lit>\'` literal in agent/gateway source is a registered purpose', () => {
    const srcDirs = [
      path.join(PACKAGES, 'agent/src'),
      path.join(PACKAGES, 'gateway/src'),
    ];
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'generated') continue;
          walk(p);
        } else if (
          entry.name.endsWith('.ts') &&
          !entry.name.endsWith('.test.ts') &&
          !entry.name.endsWith('.d.ts')
        ) {
          files.push(p);
        }
      }
    };
    for (const d of srcDirs) walk(d);

    // 1) feature: 'lit'  2) feature: <expr> ?? 'lit'（默认值兜底）
    const patterns: Array<[RegExp, string]> = [
      [/feature:\s*'([^']+)'/g, 'feature: literal'],
      [/feature:\s*[^'\n]*\?\?\s*'([^']+)'/g, 'feature ?? default'],
    ];
    const offenders: Array<{ literal: string; kind: string; file: string }> = [];
    for (const file of files) {
      const content = readFileSync(file, 'utf8');
      for (const [re, kind] of patterns) {
        let m: RegExpExecArray | null;
        while ((m = re.exec(content)) !== null) {
          const lit = m[1];
          if (!(USAGE_FEATURES as readonly string[]).includes(lit)) {
            offenders.push({ literal: lit, kind, file: path.relative(PACKAGES, file) });
          }
        }
      }
    }
    const detail = offenders
      .map(o => `  ${o.literal} (${o.kind}) ← ${o.file}`)
      .join('\n');
    assert.equal(
      offenders.length,
      0,
      `Unregistered usage purpose literals — use a value from USAGE_FEATURES ` +
        `(${USAGE_FEATURES.join('/')}) or extend the registry with a review:\n${detail}`,
    );
  });
});
