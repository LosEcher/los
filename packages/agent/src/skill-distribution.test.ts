import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  applyInspectedSkills,
  inspectSkillDirectory,
  listSkillVersions,
  pinSkillVersion,
  rollbackSkillVersion,
  unpinSkillVersion,
} from './skill-distribution.js';
import { deleteSkill, loadSkill, upsertSkill } from './skills.js';

test('skill import requires inspect, retains history, and enforces pins', async () => {
  const root = mkdtempSync(join(tmpdir(), 'los-skill-distribution-'));
  const skillDir = join(root, '.los', 'skills');
  const name = `distribution-${Date.now()}`;
  try {
    await import('node:fs').then(({ mkdirSync }) => mkdirSync(skillDir, { recursive: true }));
    const file = join(skillDir, `${name}.md`);
    writeFileSync(file, `---\nname: ${name}\nenabled: true\n---\n\nfirst`, 'utf8');

    const preview = await inspectSkillDirectory('project', root, 'project');
    const first = preview.find(item => item.name === name)!;
    assert.equal(first.action, 'create');
    assert.equal(await loadSkill(name, 'project'), null, 'inspect must not write');

    await applyInspectedSkills({ scope: 'project', workspaceRoot: root, layer: 'project', expected: [{ name, versionHash: first.versionHash }] });
    const created = await loadSkill(name, 'project');
    assert.equal(created?.sourcePath, file);
    assert.equal(created?.versionHash, first.versionHash);

    writeFileSync(file, `---\nname: ${name}\nenabled: true\n---\n\nsecond`, 'utf8');
    const second = (await inspectSkillDirectory('project', root, 'project')).find(item => item.name === name)!;
    assert.equal(second.action, 'update');
    await applyInspectedSkills({ scope: 'project', workspaceRoot: root, layer: 'project', expected: [{ name, versionHash: second.versionHash }] });
    assert.equal((await listSkillVersions(name, 'project')).length, 2);

    await pinSkillVersion(name, 'project', second.versionHash);
    await assert.rejects(
      () => upsertSkill({ name, content: 'third', metadata: { scope: 'project', skillLayer: 'project' } }),
      /pinned to version/,
    );
    await assert.rejects(() => rollbackSkillVersion(name, 'project', first.versionHash), /pinned to version/);
    await unpinSkillVersion(name, 'project');
    const rolledBack = await rollbackSkillVersion(name, 'project', first.versionHash);
    assert.equal(rolledBack.content, 'first');
  } finally {
    await deleteSkill(name, 'project');
    rmSync(root, { recursive: true, force: true });
  }
});
