import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSkillFrontmatter } from './skill-frontmatter.js';

describe('skill-frontmatter', () => {
  test('parses kebab-case Claude-style keys', () => {
    const raw = `---
name: my-skill
description: Do the thing carefully
disable-model-invocation: true
allowed-tools: ["read_file", "write_file"]
user-invocable: false
run-mode: auto
paths: src/**/*.ts, packages/**
---
Body content here.
`;
    const parsed = parseSkillFrontmatter(raw, 'my-skill.md');
    assert.ok(parsed);
    assert.equal(parsed!.name, 'my-skill');
    assert.equal(parsed!.description, 'Do the thing carefully');
    assert.equal(parsed!.runMode, 'auto');
    assert.equal(parsed!.metadata.disableModelInvocation, true);
    assert.equal(parsed!.metadata.userInvocable, false);
    assert.deepEqual(parsed!.metadata.allowedTools, ['read_file', 'write_file']);
    assert.deepEqual(parsed!.metadata.paths, ['src/**/*.ts', 'packages/**']);
    assert.equal(parsed!.content, 'Body content here.');
  });

  test('parses camelCase aliases and CSV tools', () => {
    const raw = `---
name: camel
allowedTools: read_file, run_shell
disableModelInvocation: false
---
x
`;
    const parsed = parseSkillFrontmatter(raw, 'camel.md');
    assert.deepEqual(parsed!.metadata.allowedTools, ['read_file', 'run_shell']);
    assert.equal(parsed!.metadata.disableModelInvocation, false);
  });

  test('files without frontmatter use filename as name', () => {
    const parsed = parseSkillFrontmatter('# just markdown', 'hello-world.md');
    assert.equal(parsed!.name, 'hello-world');
    assert.equal(parsed!.content, '# just markdown');
  });

  test('CSV allowed-tools and path lists are normalized via frontmatter', () => {
    const raw = `---
name: lists
allowed-tools: a, b, a
paths: ["src/**", "pkg/**"]
---
body
`;
    const parsed = parseSkillFrontmatter(raw, 'lists.md');
    assert.deepEqual(parsed!.metadata.allowedTools, ['a', 'b']);
    assert.deepEqual(parsed!.metadata.paths, ['src/**', 'pkg/**']);
  });
});
