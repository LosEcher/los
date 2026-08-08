import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mergeSkillAllowedTools,
  selectSkillsForRun,
} from './skill-runtime.js';
import type { SkillRecord } from './skills.js';

function skill(partial: Partial<SkillRecord> & { name: string }): SkillRecord {
  const now = new Date().toISOString();
  return {
    id: partial.id ?? `project:${partial.name}`,
    name: partial.name,
    category: partial.category ?? 'general',
    description: partial.description ?? '',
    runMode: partial.runMode ?? 'manual',
    sourcePath: '',
    versionHash: partial.versionHash ?? 'v1',
    usageCount: partial.usageCount ?? 0,
    enabled: partial.enabled ?? true,
    content: partial.content ?? `content for ${partial.name}`,
    tags: partial.tags ?? [],
    metadata: partial.metadata ?? { scope: 'project', skillLayer: 'project' },
    createdAt: now,
    updatedAt: now,
  };
}

describe('skill-runtime', () => {
  test('manual skill attaches as user attachment not bare system', async () => {
    const catalog = [
      skill({ name: 'foo', content: 'foo body' }),
      skill({ name: 'bar', content: 'bar body' }),
      skill({ name: 'deploy', content: 'Always use blue-green.' }),
    ];
    const multi = await selectSkillsForRun({
      prompt: '/skill foo bar\nhello world',
      catalog,
      runtimeEnabled: true,
      autoEnabled: false,
    });
    assert.deepEqual(multi.selected.map(s => s.name).sort(), ['bar', 'foo']);
    assert.equal(multi.cleanedPrompt, 'hello world');

    const result = await selectSkillsForRun({
      prompt: '/skill deploy\nship it',
      catalog,
      runtimeEnabled: true,
      autoEnabled: false,
    });
    assert.equal(result.selected.length, 1);
    assert.equal(result.selected[0]!.mode, 'manual');
    assert.match(result.userAttachment, /Active Skills/);
    assert.match(result.userAttachment, /Always use blue-green/);
    assert.match(result.effectivePrompt, /ship it$/);
    assert.equal(result.cleanedPrompt, 'ship it');
  });

  test('auto is off by default even when runMode=auto', async () => {
    const catalog = [skill({
      name: 'typescript',
      runMode: 'auto',
      description: 'typescript refactoring patterns',
      content: 'Prefer type-safe edits.',
    })];
    const result = await selectSkillsForRun({
      prompt: 'please help with typescript refactoring',
      catalog,
      // autoEnabled omitted → false
    });
    assert.equal(result.selected.length, 0);
  });

  test('auto selects by description overlap when enabled', async () => {
    const catalog = [
      skill({
        name: 'typescript',
        runMode: 'auto',
        description: 'typescript refactoring patterns',
        content: 'Prefer type-safe edits.',
      }),
      skill({
        name: 'unrelated',
        runMode: 'auto',
        description: 'gardening tips for roses',
        content: 'Water daily.',
      }),
    ];
    const result = await selectSkillsForRun({
      prompt: 'please help with typescript refactoring',
      catalog,
      autoEnabled: true,
    });
    assert.equal(result.selected.length, 1);
    assert.equal(result.selected[0]!.name, 'typescript');
    assert.equal(result.selected[0]!.mode, 'auto');
  });

  test('budget truncates subsequent manual skills', async () => {
    const big = 'x'.repeat(400);
    const catalog = [
      skill({ name: 'a', content: big }),
      skill({ name: 'b', content: big }),
    ];
    // estimate ≈ ceil(400/4)=100; budget of 110 admits one full skill only
    const result = await selectSkillsForRun({
      prompt: 'go',
      manualSkillIds: ['a', 'b'],
      catalog,
      maxSkillTokens: 110,
    });
    assert.equal(result.selected.length, 1);
    assert.equal(result.selected[0]!.name, 'a');
    assert.ok(result.skipped.some(s => s.name === 'b' && s.reason === 'budget'));
  });

  test('single oversized manual is truncated not dropped', async () => {
    const big = 'y'.repeat(2000);
    const catalog = [skill({ name: 'huge', content: big })];
    const result = await selectSkillsForRun({
      prompt: 'go',
      manualSkillIds: ['huge'],
      catalog,
      maxSkillTokens: 50,
    });
    assert.equal(result.selected.length, 1);
    assert.ok(result.selected[0]!.content.includes('truncated'));
    assert.ok(result.skipped.some(s => s.reason === 'truncated'));
  });

  test('disableModelInvocation blocks auto', async () => {
    const catalog = [skill({
      name: 'secret',
      runMode: 'auto',
      description: 'secret handling',
      content: 'never log secrets',
      metadata: { scope: 'project', skillLayer: 'project', disableModelInvocation: true },
    })];
    const result = await selectSkillsForRun({
      prompt: 'secret handling please',
      catalog,
      autoEnabled: true,
    });
    assert.equal(result.selected.length, 0);
  });

  test('mergeSkillAllowedTools intersects skill lists with session', () => {
    const merged = mergeSkillAllowedTools(
      ['read_file', 'write_file', 'run_shell'],
      [['read_file', 'write_file'], ['read_file', 'run_shell']],
    );
    assert.deepEqual(merged, ['read_file']);
  });

  test('runtimeEnabled false skips selection', async () => {
    const catalog = [skill({ name: 'x' })];
    const result = await selectSkillsForRun({
      prompt: '/skill x\nhi',
      catalog,
      runtimeEnabled: false,
    });
    assert.equal(result.selected.length, 0);
    assert.ok(result.skipped.some(s => s.reason === 'runtime_disabled'));
  });

});
