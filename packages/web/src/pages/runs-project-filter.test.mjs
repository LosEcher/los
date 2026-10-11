import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function read(rel) {
  return readFileSync(join(root, rel), 'utf8');
}

describe('run list project filter wiring', () => {
  it('run specs page filters on the server and offers registered projects', () => {
    const page = read('pages/run-specs-page.tsx');
    // 选项来自已登记项目（GET /projects 是公开只读路由）
    assert.match(page, /getJson<\{ projects: Array<\{ projectId\?: string; id\?: string \}> \}>\('\/projects'\)/);
    // 过滤走服务端参数，不是取回来再筛
    assert.match(page, /params\.set\('projectId', projectFilter\)/);
    assert.match(page, /getJson<RunSpec\[\]>\(`\/runs\?\$\{params\.toString\(\)\}`\)/);
    // 缓存键必须带过滤条件，否则切换项目会命中旧缓存
    assert.match(page, /queryKey: \['runs', projectFilter\]/);
    assert.match(page, /ops\.runSpecs\.filterAllProjects/);
  });

  it('tasks page sends status and project to the gateway and keys the cache on both', () => {
    const page = read('pages/tasks-page.tsx');
    assert.match(page, /params\.set\('status', statusFilter\)/);
    assert.match(page, /params\.set\('projectId', projectFilter\)/);
    assert.match(page, /\/tasks\?\$\{params\.toString\(\)\}/);
    assert.match(page, /queryKey: \['tasks', statusFilter, projectFilter\]/);
    // 没有客户端兜底过滤 ⇒ 服务端不读该参数时下拉框就是静默失效（2026-10-11 现场）
    assert.match(page, /rows=\{tasks\.data \?\? \[\]\}/);
  });

  it('both locales carry the project filter labels', () => {
    for (const locale of ['zh', 'en']) {
      const ops = read(`i18n/${locale}/ops.ts`);
      assert.match(ops, /'ops\.runSpecs\.filterAllProjects'/);
      assert.match(ops, /'ops\.runSpecs\.filterProject'/);
      assert.match(ops, /'ops\.tasks\.filterAllProjects'/);
      assert.match(ops, /'ops\.tasks\.filterProject'/);
    }
  });
});
