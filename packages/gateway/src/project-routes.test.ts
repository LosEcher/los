import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { registerProjectRoutes } from './routes/infrastructure/project-routes.js';

test('/projects/browse lists local directories by absolute path', async () => {
  const root = mkdtempSync(join(tmpdir(), 'los-project-browse-'));
  mkdirSync(join(root, 'alpha'));
  mkdirSync(join(root, '.hidden'));
  const app = Fastify({ logger: false });
  registerProjectRoutes(app);

  try {
    const response = await app.inject({
      method: 'GET',
      url: `/projects/browse?path=${encodeURIComponent(root)}`,
    });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.path, root);
    assert.ok(body.parent);
    assert.ok(Array.isArray(body.roots));
    assert.ok(body.entries.some((entry: { name: string; path: string }) => (
      entry.name === 'alpha' && entry.path === join(root, 'alpha')
    )));
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
