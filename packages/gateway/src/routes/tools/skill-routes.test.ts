import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import test from 'node:test';
import { registerSkillRoutes } from './skill-routes.js';
import type { SkillRouteDependencies } from './skill-routes.js';

// ── Stub deps: in-memory skill store, no DB ──

const stubStore = new Map<string, Record<string, unknown>>();
const inspectFixtures: Array<{name: string; versionHash: string; action: string; path: string}> = [];
let nextVersion = 1;

const stubDeps: SkillRouteDependencies = {
  ensureSkillStore: async () => ({} as any),
  listSkills: async (opts?: any) => {
    const all = Array.from(stubStore.values());
    return all.filter((s: any) => {
      if (opts?.archived !== undefined && (s.metadata?.archived ?? false) !== opts.archived) return false;
      return true;
    }) as any;
  },
  loadSkill: async (name: string, _scope?: string) => (stubStore.get(name) ?? null) as any,
  upsertSkill: async (input: any) => {
    const existing = stubStore.get(input.name);
    const merged = { ...existing, ...input };
    stubStore.set(input.name, merged);
    return merged as any;
  },
  deleteSkill: async (name: string, _scope?: string) => { stubStore.delete(name); return true; },
  listSkillVersions: async (_name: string, _scope: string) => [] as any,
  pinSkillVersion: async (name: string, _scope: string, versionHash?: string) => {
    const s = stubStore.get(name)!;
    s.pinnedVersionHash = versionHash;
    return s as any;
  },
  rollbackSkillVersion: async (name: string, _scope: string, _versionHash: string) => stubStore.get(name) as any,
  unpinSkillVersion: async (name: string, _scope: string) => { delete (stubStore.get(name) as any)?.pinnedVersionHash; return stubStore.get(name) as any; },
  inspectSkillDirectory: async (_scope: any, _workspaceRoot?: string, _skillLayer?: any) =>
    [...inspectFixtures] as any,

  applyInspectedSkills: async (input: any) => {
    const results: any[] = [];
    for (const exp of input.expected ?? []) {
      // Check the expected versionHash matches the inspect fixture
      const fixture = inspectFixtures.find(f => f.name === exp.name);
      if (!fixture || fixture.versionHash !== exp.versionHash) {
        const err: any = new Error('inspection changed or version mismatch');
        err.code = 'version_mismatch';
        throw err;
      }
      const s = makeSkill(exp.name, { versionHash: exp.versionHash });
      stubStore.set(exp.name, s);
      results.push(s);
    }
    return results as any;
  },
  syncSkillsToDir: async (..._args: any[]) => {},
};

function makeSkill(name: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name, category: null, description: null, runMode: 'manual',
    sourcePath: null, versionHash: 'v0', enabled: true, content: '',
    tags: [], metadata: { archived: false, scope: 'project', skillLayer: 'project' },
    ...overrides,
  };
}

test('skill pin route delegates pinned=false to the unpin dependency', async () => {
  const name = `pinned-skill-${Date.now()}`;
  stubStore.set(name, makeSkill(name, { pinnedVersionHash: 'v0' }));
  let pinCalls = 0;
  let unpinCalls = 0;
  const deps: SkillRouteDependencies = {
    ...stubDeps,
    pinSkillVersion: async (...args) => {
      pinCalls += 1;
      return await stubDeps.pinSkillVersion(...args);
    },
    unpinSkillVersion: async (...args) => {
      unpinCalls += 1;
      return await stubDeps.unpinSkillVersion(...args);
    },
  };
  const app = Fastify({ logger: false });
  registerSkillRoutes(app, undefined, deps);

  try {
    const response = await app.inject({
      method: 'POST',
      url: `/skills/${name}/pin`,
      payload: { scope: 'project', pinned: false },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(unpinCalls, 1);
    assert.equal(pinCalls, 0);
    assert.equal(Object.hasOwn(stubStore.get(name)!, 'pinnedVersionHash'), false);
  } finally {
    stubStore.delete(name);
    await app.close();
  }
});

test('skill routes expose preview-only import before exact-version apply', async () => {
  const root = mkdtempSync(join(tmpdir(), 'los-skill-routes-'));
  const dir = join(root, '.los', 'skills');
  mkdirSync(dir, { recursive: true });
  const name = `route-skill-${Date.now()}`;
  writeFileSync(join(dir, `${name}.md`), `---\nname: ${name}\nenabled: true\n---\n\nroute content`, 'utf8');
  const app = Fastify({ logger: false });
  registerSkillRoutes(app, root, stubDeps);
  try {
    const legacy = await app.inject({
      method: 'POST',
      url: '/skills/load-from-dir',
      payload: { scope: 'project', skillLayer: 'project', workspaceRoot: root },
    });
    assert.equal(legacy.statusCode, 200);
    assert.equal(legacy.json().previewOnly, true);
    assert.equal(await stubDeps.loadSkill(name, 'project'), null);

    // Seed inspect fixtures to match the skill file on disk
    inspectFixtures.push({ name, versionHash: 'vh-scanned', action: 'create', path: join(dir, `${name}.md`) });

    const inspect = await app.inject({
      method: 'POST',
      url: '/skills/import/inspect',
      payload: { scope: 'project', skillLayer: 'project', workspaceRoot: root },
    });
    const preview = inspect.json().skills.find((item: { name: string }) => item.name === name);
    assert.ok(preview, 'preview skill not found');
    assert.equal(preview.action, 'create');

    const stale = await app.inject({
      method: 'POST',
      url: '/skills/import/apply',
      payload: { scope: 'project', skillLayer: 'project', workspaceRoot: root, expected: [{ name, versionHash: 'stale' }] },
    });
    assert.equal(stale.statusCode, 409);
    assert.equal(await stubDeps.loadSkill(name, 'project'), null);

    const apply = await app.inject({
      method: 'POST',
      url: '/skills/import/apply',
      payload: { scope: 'project', skillLayer: 'project', workspaceRoot: root, expected: [{ name, versionHash: 'vh-scanned' }] },
    });
    assert.equal(apply.statusCode, 201);
    assert.equal(apply.json().count, 1);
    assert.equal((await stubDeps.loadSkill(name, 'project'))?.versionHash, preview.versionHash);
  } finally {
    await stubDeps.deleteSkill(name, 'project');
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
