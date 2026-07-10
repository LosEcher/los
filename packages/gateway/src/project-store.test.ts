import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  bindProject,
  resolveProjectIdFromWorkspace,
  unbindProject,
} from './project-store.js';

/** Reverse-lookup must map a bound workspace path back to its projectId. */
test('resolveProjectIdFromWorkspace returns the bound projectId', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'los-projects-'));
  const prev = process.env.LOS_PROJECTS_DIR;
  process.env.LOS_PROJECTS_DIR = tmp;
  try {
    bindProject({
      projectId: 'pi-test',
      displayName: 'pi-test',
      workspacePath: join(tmp, 'pi'),
    });
    assert.equal(
      resolveProjectIdFromWorkspace(join(tmp, 'pi')),
      'pi-test',
    );
    // Unbound path returns null.
    assert.equal(resolveProjectIdFromWorkspace(join(tmp, 'other')), null);
  } finally {
    unbindProject('pi-test');
    process.env.LOS_PROJECTS_DIR = prev;
    rmSync(tmp, { recursive: true, force: true });
  }
});

/** Path normalization: trailing slash and `.` segments must still match. */
test('resolveProjectIdFromWorkspace normalizes paths before matching', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'los-projects-'));
  const prev = process.env.LOS_PROJECTS_DIR;
  process.env.LOS_PROJECTS_DIR = tmp;
  try {
    bindProject({
      projectId: 'norm-test',
      displayName: 'norm-test',
      workspacePath: join(tmp, 'proj'),
    });
    // Trailing slash + /. segment should still resolve to the same project.
    assert.equal(
      resolveProjectIdFromWorkspace(`${join(tmp, 'proj')}/./`),
      'norm-test',
    );
  } finally {
    unbindProject('norm-test');
    process.env.LOS_PROJECTS_DIR = prev;
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('resolveProjectIdFromWorkspace maps nested paths to the deepest binding', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'los-projects-'));
  const prev = process.env.LOS_PROJECTS_DIR;
  process.env.LOS_PROJECTS_DIR = tmp;
  try {
    bindProject({
      projectId: 'root-project',
      displayName: 'root-project',
      workspacePath: join(tmp, 'project'),
    });
    bindProject({
      projectId: 'nested-project',
      displayName: 'nested-project',
      workspacePath: join(tmp, 'project', 'docs'),
    });
    assert.equal(
      resolveProjectIdFromWorkspace(join(tmp, 'project', 'docs', 'adr')),
      'nested-project',
    );
  } finally {
    unbindProject('nested-project');
    unbindProject('root-project');
    process.env.LOS_PROJECTS_DIR = prev;
    rmSync(tmp, { recursive: true, force: true });
  }
});
