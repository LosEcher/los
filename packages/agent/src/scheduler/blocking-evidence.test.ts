import assert from 'node:assert/strict';
import test from 'node:test';

import { hasAwaitingOperatorEvidence, summarizeToolDenials } from './blocking-evidence.js';

const deniedRunShell = {
  type: 'tool.denied',
  toolName: 'run_shell',
  payload: { reason: 'Tool risk L2 exceeds max L1: run_shell', reasonCode: 'tool_risk_exceeded' },
};
const deniedReadFile = {
  type: 'tool.denied',
  toolName: 'read_file',
  payload: { reason: 'Path traversal denied: /etc/sing-box/config.json' },
};

test('hasAwaitingOperatorEvidence is false without worker events', () => {
  assert.equal(hasAwaitingOperatorEvidence([deniedRunShell, deniedReadFile]), false);
  assert.equal(hasAwaitingOperatorEvidence([]), false);
});

test('hasAwaitingOperatorEvidence is true on worker.ask or worker.escalation', () => {
  assert.equal(hasAwaitingOperatorEvidence([{ type: 'worker.ask', payload: {} }]), true);
  assert.equal(hasAwaitingOperatorEvidence([{ type: 'worker.escalation', payload: {} }]), true);
  assert.equal(hasAwaitingOperatorEvidence([
    deniedRunShell,
    { type: 'worker.ask', payload: { options: ['A', 'B'] } },
  ]), true);
});

test('summarizeToolDenials groups denials by tool with reasons', () => {
  const summary = summarizeToolDenials([
    deniedRunShell,
    deniedRunShell,
    deniedReadFile,
  ]);
  assert.match(summary, /run_shell×2 \(Tool risk L2 exceeds max L1: run_shell\)/);
  assert.match(summary, /read_file×1 \(Path traversal denied/);
  assert.match(summary, /\(3 total\)/);
});

test('summarizeToolDenials returns empty string when nothing was denied', () => {
  assert.equal(summarizeToolDenials([]), '');
  assert.equal(summarizeToolDenials([
    { type: 'tool.approved', toolName: 'run_shell', payload: {} },
    { type: 'assistant', payload: {} },
  ]), '');
});

test('summarizeToolDenials falls back to reasonCode and caps distinct tools', () => {
  const events = Array.from({ length: 6 }, (_, i) => ({
    type: 'tool.denied',
    toolName: `tool_${i}`,
    payload: { reasonCode: 'tool_risk_exceeded' },
  }));
  const summary = summarizeToolDenials(events, 2);
  assert.match(summary, /tool_0×1/);
  assert.match(summary, /tool_1×1/);
  assert.ok(!summary.includes('tool_2'), 'maxTools cap must truncate the list');
  assert.match(summary, /\(6 total\)/, 'total counts all denials beyond the cap');
});
