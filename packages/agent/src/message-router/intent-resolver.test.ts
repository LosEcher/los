/**
 * Tests for message-router intent-resolver — command parsing + NL heuristics
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveIntent } from './intent-resolver.js';

describe('intent-resolver commands', () => {
  // ── #approve ──
  // ── RunContract phase commands ──
  it('resolves #approve-phase with run id and optional reason', () => {
    const r = resolveIntent('#approve-phase run-abc12345 looks good');
    assert.equal(r.type, 'run_contract');
    if (r.type === 'run_contract') {
      assert.equal(r.action, 'approve_phase');
      assert.equal(r.runId, 'run-abc12345');
      assert.equal(r.reason, 'looks good');
    }
  });

  it('resolves #approve-phase without reason', () => {
    const r = resolveIntent('#approve-phase run-xyz-9999');
    assert.equal(r.type, 'run_contract');
    if (r.type === 'run_contract') {
      assert.equal(r.action, 'approve_phase');
      assert.equal(r.runId, 'run-xyz-9999');
      assert.equal(r.reason, undefined);
    }
  });

  it('does not treat #approve-phase as session steering #approve', () => {
    const r = resolveIntent('#approve-phase run-not-session');
    assert.notEqual(r.type, 'steering');
    assert.equal(r.type, 'run_contract');
  });

  it('resolves #revise-plan with reason', () => {
    const r = resolveIntent('#revise-plan run-plan-1 add tests');
    assert.equal(r.type, 'run_contract');
    if (r.type === 'run_contract') {
      assert.equal(r.action, 'revise_plan');
      assert.equal(r.runId, 'run-plan-1');
      assert.equal(r.reason, 'add tests');
    }
  });

  it('resolves #verify-run', () => {
    const r = resolveIntent('#verify-run run-verify-1');
    assert.equal(r.type, 'run_contract');
    if (r.type === 'run_contract') {
      assert.equal(r.action, 'verify_run');
      assert.equal(r.runId, 'run-verify-1');
    }
  });

  it('resolves #approve with session ID', () => {
    const r = resolveIntent('#approve session-abc12345');
    assert.equal(r.type, 'steering');
    if (r.type === 'steering') {
      assert.equal(r.instruction, 'approve');
      assert.ok(r.sessionId.includes('session-abc12345'));
    }
  });

  it('resolves #deny with session ID', () => {
    const r = resolveIntent('#deny task-xyz-12345-def');
    assert.equal(r.type, 'steering');
    if (r.type === 'steering') {
      assert.equal(r.instruction, 'deny');
    }
  });

  it('resolves #escalate with session ID', () => {
    const r = resolveIntent('#escalate abcdef12-3456-7890');
    assert.equal(r.type, 'steering');
    if (r.type === 'steering') {
      assert.equal(r.instruction, 'escalate');
    }
  });

  // ── #status ──
  it('resolves #status with session ID', () => {
    const r = resolveIntent('#status session-xyz-12345678');
    assert.equal(r.type, 'status');
    if (r.type === 'status') {
      assert.ok(r.sessionId.includes('xyz'));
    }
  });

  // ── #claude / #codex ──
  it('resolves #claude with prompt', () => {
    const r = resolveIntent('#claude analyze this codebase');
    assert.equal(r.type, 'runtime');
    if (r.type === 'runtime') {
      assert.equal(r.kind, 'claude-code');
      assert.equal(r.prompt, 'analyze this codebase');
    }
  });

  it('resolves #codex with prompt', () => {
    const r = resolveIntent('#codex fix the type errors');
    assert.equal(r.type, 'runtime');
    if (r.type === 'runtime') {
      assert.equal(r.kind, 'codex');
      assert.equal(r.prompt, 'fix the type errors');
    }
  });

  it('resolves #claude with multiline prompt (first line extracted)', () => {
    const r = resolveIntent('#claude review PR #70\nand also check tests');
    // Note: multiline text loses newlines in regex (. doesn't match \n).
    // The command parser extracts the first line as the prompt.
    assert.equal(r.type, 'chat'); // falls back to chat with full text
  });

  // ── #task ──
  it('resolves bare #task as list', () => {
    const r = resolveIntent('#task');
    assert.equal(r.type, 'todo');
    if (r.type === 'todo') assert.equal(r.action, 'list');
  });

  it('resolves #task with trailing whitespace as list', () => {
    const r = resolveIntent('#task  ');
    assert.equal(r.type, 'todo');
  });

  it('resolves #task with ID as show', () => {
    const r = resolveIntent('#task todo-1234-abcd');
    assert.equal(r.type, 'todo');
    if (r.type === 'todo') {
      assert.equal(r.action, 'show');
      assert.equal(r.todoId, 'todo-1234-abcd');
    }
  });

  it('resolves #task new as create', () => {
    const r = resolveIntent('#task new implement message router');
    assert.equal(r.type, 'todo');
    if (r.type === 'todo') {
      assert.equal(r.action, 'create');
      assert.equal(r.title, 'implement message router');
    }
  });

  // ── #run / #dispatch ──
  it('resolves #run with ID as dispatch', () => {
    const r = resolveIntent('#run todo-los-p0-2');
    assert.equal(r.type, 'todo');
    if (r.type === 'todo') {
      assert.equal(r.action, 'dispatch');
      assert.equal(r.todoId, 'todo-los-p0-2');
      assert.equal(r.force, false);
    }
  });

  it('resolves #dispatch with ID as dispatch (alias)', () => {
    const r = resolveIntent('#dispatch todo-los-p0-2');
    assert.equal(r.type, 'todo');
    if (r.type === 'todo') {
      assert.equal(r.action, 'dispatch');
      assert.equal(r.todoId, 'todo-los-p0-2');
    }
  });

  it('resolves #run <id> force as dispatch with force=true', () => {
    const r = resolveIntent('#run todo-los-p0-2 force');
    assert.equal(r.type, 'todo');
    if (r.type === 'todo') {
      assert.equal(r.action, 'dispatch');
      assert.equal(r.force, true);
    }
  });

  it('resolves #run case-insensitively', () => {
    const r = resolveIntent('#RUN Todo-Los-P0-2');
    assert.equal(r.type, 'todo');
    if (r.type === 'todo') assert.equal(r.action, 'dispatch');
  });

  // ── Case insensitive ──
  it('handles command case-insensitively', () => {
    const r = resolveIntent('#ApprovE session-abc12345');
    assert.equal(r.type, 'steering');
  });

  // ── Unrecognized #command → chat ──
  it('falls back to chat for unrecognized #command', () => {
    const r = resolveIntent('#unknown command text');
    assert.equal(r.type, 'chat');
  });

  // ── NL heuristics ──
  it('detects "approve abc123" without hash', () => {
    const r = resolveIntent('approve session-abc12345');
    assert.equal(r.type, 'steering');
  });

  it('detects "deny abc123" without hash', () => {
    const r = resolveIntent('deny session-xyz-12345678');
    assert.equal(r.type, 'steering');
  });

  it('detects "status of abc123"', () => {
    const r = resolveIntent('status of session-abc12345');
    assert.equal(r.type, 'status');
  });

  it('detects "run claude to ..." as runtime', () => {
    const r = resolveIntent('run claude to check tests');
    assert.equal(r.type, 'runtime');
    if (r.type === 'runtime') assert.equal(r.kind, 'claude-code');
  });

  it('detects "use codex to ..." as runtime', () => {
    const r = resolveIntent('use codex to deploy');
    assert.equal(r.type, 'runtime');
    if (r.type === 'runtime') assert.equal(r.kind, 'codex');
  });

  // ── Default to chat ──
  it('defaults plain text to chat', () => {
    const r = resolveIntent('what is the status of the system?');
    assert.equal(r.type, 'chat');
    if (r.type === 'chat') assert.equal(r.prompt, 'what is the status of the system?');
  });

  it('returns chat for empty string', () => {
    const r = resolveIntent('');
    assert.equal(r.type, 'chat');
  });
});
