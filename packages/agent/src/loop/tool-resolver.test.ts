import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveAllowedTools } from './tool-resolver.js';
import { READ_ONLY_BUILTIN_TOOLS } from '../tools/core/registry.js';

const PLANNING_TOOL = 'submit_run_contract';

test('empty allowedTools array behaves like undefined (not a zero-tool allowlist)', () => {
  const readOnly = resolveAllowedTools([], 'read-only', 'typed_tool');
  assert.ok(readOnly, 'read-only mode must yield a non-empty default tool set');
  assert.ok(readOnly.includes('list_directory'), 'default read-only set includes read tools');
  assert.ok(readOnly.includes('spawn_agent'), 'subagent tools are visible in read-only mode');
  assert.ok(readOnly.includes(PLANNING_TOOL), 'typed_tool planning adds the planning tool');
});

test('undefined allowedTools yields the same default read-only set', () => {
  const viaUndefined = resolveAllowedTools(undefined, 'read-only', 'typed_tool');
  const viaEmpty = resolveAllowedTools([], 'read-only', 'typed_tool');
  assert.deepEqual(viaEmpty, viaUndefined);
});

test('read-only mode restricts an explicit allowlist to read-only tools', () => {
  const filtered = resolveAllowedTools(['list_directory', 'patch'], 'read-only');
  assert.deepEqual(filtered, ['list_directory']);
});

test('non-read-only modes pass an empty array through as unrestricted', () => {
  assert.equal(resolveAllowedTools([], 'all'), undefined);
  assert.equal(resolveAllowedTools([], 'project-write'), undefined);
});

test('non-read-only modes keep a non-empty allowlist and dedupe it', () => {
  const result = resolveAllowedTools(['read_file', 'read_file', 'patch'], 'project-write');
  assert.deepEqual(result, ['read_file', 'patch']);
});

test('default read-only set matches READ_ONLY_BUILTIN_TOOLS', () => {
  const result = resolveAllowedTools(undefined, 'read-only');
  assert.deepEqual(result, [...READ_ONLY_BUILTIN_TOOLS]);
});
