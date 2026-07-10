import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { resolveProjectOwner, type ProjectOwnerBinding } from './task-intake.js';

const root = join(process.cwd(), 'fixtures');
const bindings: ProjectOwnerBinding[] = [
  { projectId: 'los', workspacePath: join(root, 'los') },
  { projectId: 'los-docs', workspacePath: join(root, 'los', 'docs') },
  { projectId: 'cantool', workspacePath: join(root, 'cantool') },
];

test('explicit project resolves when its workspace agrees', () => {
  const result = resolveProjectOwner({
    bindings,
    requestedProjectId: 'los',
    workspaceRoot: join(root, 'los', 'packages', 'agent'),
    defaultProjectId: 'cantool',
  });

  assert.equal(result.status, 'resolved');
  assert.equal(result.ownerRepo, 'los');
  assert.equal(result.reason, 'explicit_project');
});

test('unknown explicit project blocks without falling back', () => {
  assert.deepEqual(resolveProjectOwner({
    bindings,
    requestedProjectId: 'missing',
    defaultProjectId: 'los',
  }), {
    status: 'blocked',
    reason: 'unknown_explicit_project',
    blocker: 'Project is not bound: missing',
  });
});

test('explicit project blocks a conflicting workspace', () => {
  const result = resolveProjectOwner({
    bindings,
    requestedProjectId: 'los',
    workspaceRoot: join(root, 'cantool'),
  });

  assert.equal(result.status, 'blocked');
  assert.equal(result.reason, 'project_workspace_conflict');
});

test('workspace resolution selects the deepest matching binding', () => {
  const result = resolveProjectOwner({
    bindings,
    workspaceRoot: join(root, 'los', 'docs', 'adr'),
  });

  assert.equal(result.status, 'resolved');
  assert.equal(result.ownerRepo, 'los-docs');
  assert.equal(result.reason, 'workspace_binding');
});

test('workspace resolution accepts child names that begin with two dots', () => {
  const result = resolveProjectOwner({
    bindings,
    workspaceRoot: join(root, 'los', '..cache'),
  });

  assert.equal(result.status, 'resolved');
  assert.equal(result.ownerRepo, 'los');
});

test('workspace resolution blocks duplicate deepest bindings', () => {
  const duplicatePath = join(root, 'duplicate');
  const result = resolveProjectOwner({
    bindings: [
      ...bindings,
      { projectId: 'duplicate-a', workspacePath: duplicatePath },
      { projectId: 'duplicate-b', workspacePath: duplicatePath },
    ],
    workspaceRoot: join(duplicatePath, 'src'),
  });

  assert.equal(result.status, 'blocked');
  assert.equal(result.reason, 'ambiguous_workspace');
});

test('unbound explicit workspace blocks instead of using the default', () => {
  const result = resolveProjectOwner({
    bindings,
    workspaceRoot: join(root, 'unknown'),
    defaultProjectId: 'los',
  });

  assert.equal(result.status, 'blocked');
  assert.equal(result.reason, 'unbound_workspace');
});

test('configured default resolves only without an explicit workspace', () => {
  const result = resolveProjectOwner({ bindings, defaultProjectId: 'cantool' });

  assert.equal(result.status, 'resolved');
  assert.equal(result.ownerRepo, 'cantool');
  assert.equal(result.reason, 'configured_default');
});

test('unknown configured default blocks', () => {
  const result = resolveProjectOwner({ bindings, defaultProjectId: 'missing' });

  assert.equal(result.status, 'blocked');
  assert.equal(result.reason, 'unknown_default_project');
});

test('missing ownership evidence blocks', () => {
  const result = resolveProjectOwner({ bindings });

  assert.equal(result.status, 'blocked');
  assert.equal(result.reason, 'owner_unresolved');
});
