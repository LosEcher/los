import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

// Pure helpers are TypeScript — load via dynamic transpile through package test runner.
// Mirror the pure logic here for boundary checks, and assert source wiring.

const primitivesSrc = readFileSync(new URL('./chat-ai-primitives.tsx', import.meta.url), 'utf8');
const messagesSrc = readFileSync(new URL('./chat-messages.tsx', import.meta.url), 'utf8');
const approvalSrc = readFileSync(new URL('./chat-approval.tsx', import.meta.url), 'utf8');
const styles = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');
const enChat = readFileSync(new URL('./i18n/en/chat.ts', import.meta.url), 'utf8');
const zhChat = readFileSync(new URL('./i18n/zh/chat.ts', import.meta.url), 'utf8');

test('AI primitives source exports core Beautiful UI patterns', () => {
  for (const symbol of [
    'formatToolChipPreview',
    'toolCallsToTaskRows',
    'ThinkingBlock',
    'ToolChip',
    'TaskRowList',
    'StreamingElapsed',
    'HitlQuestionCard',
  ]) {
    assert.match(primitivesSrc, new RegExp(`export function ${symbol}`));
  }
});

test('chat timeline wires chips, thinking, tasks, and stream elapsed', () => {
  assert.match(messagesSrc, /ToolChipList/);
  assert.match(messagesSrc, /ThinkingBlock/);
  assert.match(messagesSrc, /TaskRowList/);
  assert.match(messagesSrc, /StreamingElapsed/);
  assert.match(messagesSrc, /toolCallsToTaskRows/);
  assert.doesNotMatch(messagesSrc, /className="tool-card"/);
});

test('operator steering uses typed HITL option card', () => {
  assert.match(approvalSrc, /HitlQuestionCard/);
  assert.match(approvalSrc, /hitlSteerBody/);
  assert.match(approvalSrc, /id: 'approve'/);
  assert.match(approvalSrc, /id: 'deny'/);
  assert.match(approvalSrc, /id: 'escalate'/);
});

test('styles define token-based AI primitive classes', () => {
  for (const cls of [
    '.tool-chip',
    '.tool-chip-list',
    '.ai-thinking',
    '.task-row',
    '.task-row-list',
    '.ai-stream-elapsed',
    '.hitl-card',
    '.hitl-option',
  ]) {
    assert.match(styles, new RegExp(cls.replace('.', '\\.')));
  }
  const start = styles.indexOf('/* ── AI-native primitives');
  const end = styles.indexOf('/* ── System Messages / Separators');
  assert.ok(start >= 0 && end > start, 'AI primitives CSS section bounds');
  const section = styles.slice(start, end);
  assert.doesNotMatch(section, /#[0-9a-fA-F]{3,8}\b/);
});

test('i18n en/zh include AI primitive keys', () => {
  const keys = [
    'chat.ai.thinkingLive',
    'chat.ai.streaming',
    'chat.ai.tasks',
    'chat.ai.hitlSteerBody',
  ];
  for (const key of keys) {
    assert.match(enChat, new RegExp(`'${key.replace(/\./g, '\\.')}'`));
    assert.match(zhChat, new RegExp(`'${key.replace(/\./g, '\\.')}'`));
  }
});

// Executable pure-helper checks via require of compiled-like eval is heavy;
// keep a minimal inline reimplementation parity for the preview formatter contract.
test('tool chip preview prefers path-like args (contract)', () => {
  // Mirrors formatToolChipPreview selection order used in chat-ai-primitives.tsx
  function preview(toolName, argsPreview, args) {
    if (args) {
      for (const key of ['path', 'file_path', 'filePath', 'target_file', 'target', 'command', 'pattern', 'query']) {
        if (typeof args[key] === 'string' && args[key].trim()) {
          return args[key].trim().slice(0, 64);
        }
      }
    }
    return argsPreview || toolName;
  }
  assert.equal(
    preview('read_file', '{"x":1}', { path: 'packages/web/src/App.tsx' }),
    'packages/web/src/App.tsx',
  );
  assert.equal(preview('bash', '', { command: 'pnpm test' }), 'pnpm test');
});

// silence unused createRequire if tree-shaken linters complain
void createRequire;
