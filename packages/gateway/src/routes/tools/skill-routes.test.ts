import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import test from 'node:test';
import { deleteSkill, loadSkill } from '@los/agent/skills';
import { registerSkillRoutes } from './skill-routes.js';

test('skill routes expose preview-only import before exact-version apply', async () => {
  const root = mkdtempSync(join(tmpdir(), 'los-skill-routes-'));
  const dir = join(root, '.los', 'skills');
  mkdirSync(dir, { recursive: true });
  const name = `route-skill-${Date.now()}`;
  writeFileSync(join(dir, `${name}.md`), `---\nname: ${name}\nenabled: true\n---\n\nroute content`, 'utf8');
  const app = Fastify({ logger: false });
  registerSkillRoutes(app, root);
  try {
    const legacy = await app.inject({
      method: 'POST',
      url: '/skills/load-from-dir',
      payload: { scope: 'project', skillLayer: 'project', workspaceRoot: root },
    });
    assert.equal(legacy.statusCode, 200);
    assert.equal(legacy.json().previewOnly, true);
    assert.equal(await loadSkill(name, 'project'), null);

    const inspect = await app.inject({
      method: 'POST',
      url: '/skills/import/inspect',
      payload: { scope: 'project', skillLayer: 'project', workspaceRoot: root },
    });
    const preview = inspect.json().skills.find((item: { name: string }) => item.name === name);
    assert.equal(preview.action, 'create');

    const stale = await app.inject({
      method: 'POST',
      url: '/skills/import/apply',
      payload: { scope: 'project', skillLayer: 'project', workspaceRoot: root, expected: [{ name, versionHash: 'stale' }] },
    });
    assert.equal(stale.statusCode, 409);
    assert.equal(await loadSkill(name, 'project'), null);

    const apply = await app.inject({
      method: 'POST',
      url: '/skills/import/apply',
      payload: { scope: 'project', skillLayer: 'project', workspaceRoot: root, expected: [{ name, versionHash: preview.versionHash }] },
    });
    assert.equal(apply.statusCode, 201);
    assert.equal(apply.json().count, 1);
    assert.equal((await loadSkill(name, 'project'))?.versionHash, preview.versionHash);
  } finally {
    await deleteSkill(name, 'project');
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
