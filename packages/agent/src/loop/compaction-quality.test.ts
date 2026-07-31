import test from 'node:test';
import assert from 'node:assert/strict';

import { createContextMonitor } from '../context-monitor.js';
import { compressOrTrimMessages } from './compression.js';
import type { Message } from '../providers/index.js';

// ── Monitor threshold crossing behavior ──────────────────

test('context monitor fires callbacks at correct thresholds', () => {
  const calls: string[] = [];
  const monitor = createContextMonitor({
    contextWindowTokens: 100_000,
    warnThreshold: 0.50,
    checkpointThreshold: 0.70,
    criticalThreshold: 0.85,
    onWarn: () => calls.push('warn'),
    onCheckpoint: () => calls.push('checkpoint'),
    onCritical: () => calls.push('critical'),
  });

  // Normal: 20K / 100K = 20% — no callback
  let state = monitor.update({ promptTokens: 10_000, completionTokens: 10_000 }, 1);
  assert.equal(state.level, 'normal');
  assert.equal(calls.length, 0);

  // Warn: 55K / 100K = 55% — warn fires
  state = monitor.update({ promptTokens: 30_000, completionTokens: 25_000 }, 2);
  assert.equal(state.level, 'warn');
  assert.ok(calls.includes('warn'));

  // Checkpoint: 75K / 100K = 75% — checkpoint fires
  state = monitor.update({ promptTokens: 45_000, completionTokens: 30_000 }, 3);
  assert.equal(state.level, 'checkpoint');
  assert.ok(calls.includes('checkpoint'));

  // Critical: 90K / 100K = 90% — critical fires
  state = monitor.update({ promptTokens: 55_000, completionTokens: 35_000 }, 4);
  assert.equal(state.level, 'critical');
  assert.ok(calls.includes('critical'));
});

test('context monitor does not fire same level callback twice', () => {
  const calls: string[] = [];
  const monitor = createContextMonitor({
    contextWindowTokens: 100_000,
    warnThreshold: 0.50,
    checkpointThreshold: 0.70,
    criticalThreshold: 0.85,
    onWarn: () => calls.push('warn'),
    onCheckpoint: () => calls.push('checkpoint'),
    onCritical: () => calls.push('critical'),
  });

  // First crossing: fires callback
  monitor.update({ promptTokens: 55_000, completionTokens: 5_000 }, 1);
  assert.equal(calls.length, 1);
  assert.ok(calls.includes('warn'));

  // Same level, slightly higher — should NOT fire again
  monitor.update({ promptTokens: 58_000, completionTokens: 6_000 }, 2);
  assert.equal(calls.length, 1, 'should not double-fire warn');

  // Reset and re-cross — should fire again
  monitor.reset();
  monitor.update({ promptTokens: 55_000, completionTokens: 5_000 }, 3);
  assert.equal(calls.length, 2, 'should fire warn after reset');
});

test('resetLevelFlags allows re-crossing without clearing token counts', () => {
  const calls: string[] = [];
  const monitor = createContextMonitor({
    contextWindowTokens: 100_000,
    warnThreshold: 0.50,
    onWarn: () => calls.push('warn'),
  });

  // Cross the warn threshold
  monitor.update({ promptTokens: 60_000, completionTokens: 5_000 }, 1);
  assert.equal(calls.length, 1);

  // resetLevelFlags() only clears crossed flags, not token counts
  monitor.resetLevelFlags();

  // Same token count still at warn level — should fire again because flags cleared
  monitor.update({ promptTokens: 60_000, completionTokens: 5_000 }, 2);
  assert.equal(calls.length, 2, 'should fire warn again after resetLevelFlags');

  // Verify token counts weren't cleared: getState should still reflect 60K
  const state = monitor.getState();
  assert.ok(state.usedTokens >= 60_000, `token count should be preserved after resetLevelFlags, got ${state.usedTokens}`);
});

// ── Monitor-driven compaction gating ─────────────────────

test('compaction should only trigger when monitor level >= checkpoint', () => {
  function shouldCompress(ctxState: { level: string } | null): boolean {
    if (!ctxState) return false;
    return ctxState.level === 'checkpoint' || ctxState.level === 'critical';
  }

  assert.equal(shouldCompress(null), false, 'no monitor = no compaction');
  assert.equal(shouldCompress({ level: 'normal' }), false);
  assert.equal(shouldCompress({ level: 'warn' }), false);
  assert.equal(shouldCompress({ level: 'checkpoint' }), true);
  assert.equal(shouldCompress({ level: 'critical' }), true);
});

// ── Compression preserves system message and recent turns ──

test('compressOrTrimMessages preserves system message', () => {
  const messages: Message[] = [
    { role: 'system', content: 'You are a helpful agent.' },
    { role: 'user', content: 'read the file' },
    { role: 'assistant', content: 'I will read it.' },
    { role: 'tool', content: 'file contents here', tool_call_id: 'call-1' },
    { role: 'assistant', content: 'The file contains...', tool_calls: [] },
  ];

  // Small budget should trigger compression
  const compressed = compressOrTrimMessages(messages, 200, { enabled: true });

  // System message must survive
  assert.ok(compressed.some(m => m.role === 'system'), 'system message must survive compression');
  assert.ok(compressed.some(m => m.role === 'assistant'), 'recent assistant message must survive');
});

test('compressOrTrimMessages returns original when budget is sufficient', () => {
  const messages: Message[] = [
    { role: 'system', content: 'Agent' },
    { role: 'user', content: 'hello' },
  ];

  const compressed = compressOrTrimMessages(messages, 100_000, { enabled: true });
  assert.equal(compressed.length, messages.length, 'should not compress within budget');
  assert.equal(compressed[0]?.role, 'system');
});

test('compressOrTrimMessages disabled does nothing', () => {
  const messages: Message[] = [
    { role: 'system', content: 'Agent' },
    { role: 'user', content: 'a'.repeat(100_000) },
  ];

  const compressed = compressOrTrimMessages(messages, 100, { enabled: false });
  assert.equal(compressed.length, messages.length, 'disabled compression should not modify');
});

test('compressOrTrimMessages with large provider window uses absolute budgets', () => {
  const messages: Message[] = [];
  // Build a large message set
  for (let i = 0; i < 10; i++) {
    messages.push({ role: 'user', content: `message ${i}: ${'x'.repeat(500)}` });
    messages.push({ role: 'assistant', content: `response ${i}: ${'y'.repeat(200)}` });
  }
  const originalLength = messages.length;

  const compressed = compressOrTrimMessages(
    messages, 200_000,
    { enabled: true, providerContextWindow: 1_000_000 },
  );

  // With 1M window and 200K budget, should still be under budget-preserving
  assert.ok(compressed.length > 0, 'should have messages');
  // Large window should mean less aggressive compression
  assert.ok(compressed.length >= originalLength * 0.5, 'large window should preserve more messages');
});
