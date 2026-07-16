import assert from 'node:assert/strict';
import test from 'node:test';
import { applySemanticEviction, evictMessages } from './semantic-eviction.js';

const largeResult = `export const marker = true;\n${'x'.repeat(5000)}`;

test('semantic eviction requires retrieval evidence', () => {
  const result = applySemanticEviction([{
    toolCallId: 'read-1',
    toolName: 'read_file',
    content: largeResult,
  }]);

  assert.equal(result.maskedCount, 0);
  assert.equal(result.bytesFreed, 0);
});

test('evictMessages replaces a large persisted read with a bounded stub', () => {
  const messages = [
    { role: 'user', content: 'read src/a.ts' },
    { role: 'tool', tool_call_id: 'read-1', content: largeResult },
  ];
  const evidence = new Map([
    ['read-1', {
      toolName: 'read_file',
      locations: [{
        kind: 'workspace_path' as const,
        id: '/workspace/src/a.ts',
        label: 'read_file source /workspace/src/a.ts',
      }],
    }],
  ]);

  const evicted = evictMessages(messages, evidence, { minResultBytes: 4096, maxStubChars: 160 });

  assert.notStrictEqual(evicted, messages);
  assert.equal(evicted[0]?.content, messages[0]?.content);
  assert.match(evicted[1]?.content ?? '', /^\[evicted: read_file/);
  assert.match(evicted[1]?.content ?? '', /workspace_path \/workspace\/src\/a\.ts/);
  assert.ok((evicted[1]?.content?.length ?? 0) <= 160);
});

test('evictMessages leaves unpersisted and ineligible results unchanged', () => {
  const messages = [
    { role: 'tool', tool_call_id: 'read-1', content: largeResult },
    { role: 'tool', tool_call_id: 'write-1', content: largeResult },
  ];
  const evidence = new Map([
    ['write-1', {
      toolName: 'write_file',
      locations: [{
        kind: 'workspace_path' as const,
        id: '/workspace/src/a.ts',
        label: 'write_file target /workspace/src/a.ts',
      }],
    }],
  ]);

  assert.strictEqual(evictMessages(messages, evidence), messages);
});
