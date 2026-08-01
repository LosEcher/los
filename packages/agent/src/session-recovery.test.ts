import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  _buildHandoffMessage,
  buildMessagesFromEvents,
  classifyRecoveryMode,
  countLostToolResults,
  detectStaleFiles,
} from './session-recovery-context.js';
import type { CheckpointSnapshot } from './session-recovery.js';
import type { SessionEventRecord } from './session-events.js';

function checkpoint(overrides: Partial<CheckpointSnapshot> = {}): CheckpointSnapshot {
  return {
    checkpointId: 'chkpt-1',
    sessionId: 'session-1',
    runSpecId: 'run-1',
    takenAt: '2026-07-28T01:00:00.000Z',
    trigger: 'manual',
    mode: 'checkpoint',
    toolState: { pendingCalls: [], lastResult: [] },
    fileReferences: [],
    messageCursor: { lastEventId: '1', lastEventIndex: 1, turnCount: 1 },
    ...overrides,
  };
}

function event(
  id: number,
  type: string,
  payload: Record<string, unknown>,
  toolName?: string,
): SessionEventRecord {
  return {
    id,
    sessionId: 'session-1',
    turn: 1,
    type,
    source: 'loop',
    toolName,
    payload,
    visibility: 'public',
    createdAt: `2026-07-28T01:00:0${id}.000Z`,
  };
}

test('handoff message includes checkpoint work and referenced files', () => {
  const message = _buildHandoffMessage('session-1', checkpoint({
    toolState: {
      pendingCalls: [{ callId: 'call-2', toolName: 'write_file', args: {}, status: 'running' }],
      lastResult: [{ callId: 'call-1', toolName: 'read_file', outcome: 'success', resultSummary: 'read src/a.ts' }],
    },
    fileReferences: [{ path: 'src/a.ts', contentHash: 'abc', lastOperation: 'read' }],
  }));

  assert.equal(message.role, 'system');
  assert.match(String(message.content), /checkpoint chkpt-1/);
  assert.match(String(message.content), /read_file: read src\/a\.ts/);
  assert.match(String(message.content), /write_file \(running\)/);
  assert.match(String(message.content), /src\/a\.ts \(read\)/);
});

test('message reconstruction preserves event order and completed tool results', () => {
  const messages = buildMessagesFromEvents('session-1', checkpoint(), [
    event(2, 'session.resumed', { content: 'resume marker' }),
    event(3, 'user.message', { content: 'inspect the file' }),
    event(4, 'model.turn.completed', { textPreview: 'I will inspect it' }),
    event(5, 'tool.call', { callId: 'call-1', args: { path: 'src/a.ts' } }, 'read_file'),
    event(6, 'tool.result', { callId: 'call-1', contentPreview: 'file contents' }, 'read_file'),
  ], true);

  assert.deepEqual(messages.map(message => message.role), [
    'system', 'system', 'user', 'assistant', 'assistant', 'tool',
  ]);
  assert.equal(messages.at(-1)?.content, 'file contents');
  assert.equal(countLostToolResults(messages, checkpoint()), 0);
});

test('missing tool result is stubbed and counted once with matching pending state', () => {
  const activeCheckpoint = checkpoint({
    toolState: {
      pendingCalls: [{ callId: 'call-1', toolName: 'read_file', args: {}, status: 'running' }],
      lastResult: [],
    },
  });
  const messages = buildMessagesFromEvents('session-1', activeCheckpoint, [
    event(2, 'tool.call', { callId: 'call-1', args: {} }, 'read_file'),
  ], true);

  assert.match(String(messages.at(-1)?.content), /Tool result lost/);
  assert.equal(countLostToolResults(messages, activeCheckpoint), 1);
  assert.equal(classifyRecoveryMode(1, 0, activeCheckpoint), 'partial');
});

test('recovery mode distinguishes intact, partial, and degraded recovery', () => {
  const intact = checkpoint();
  assert.equal(classifyRecoveryMode(0, 0, intact), 'full');
  assert.equal(classifyRecoveryMode(1, 0, intact), 'partial');
  assert.equal(classifyRecoveryMode(0, 3, intact), 'degraded');
});

test('stale file detection covers unchanged, modified, and deleted files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'los-recovery-files-'));
  const unchangedPath = join(root, 'unchanged.ts');
  const modifiedPath = join(root, 'modified.ts');
  const deletedPath = join(root, 'deleted.ts');
  const original = 'export const value = 1;\n';
  const originalHash = createHash('sha256').update(original).digest('hex');

  try {
    await Promise.all([
      writeFile(unchangedPath, original),
      writeFile(modifiedPath, 'export const value = 2;\n'),
      writeFile(deletedPath, original),
    ]);
    await unlink(deletedPath);
    const results = await detectStaleFiles([
      { path: unchangedPath, contentHash: originalHash, lastOperation: 'read' },
      { path: modifiedPath, contentHash: originalHash, lastOperation: 'edit' },
      { path: deletedPath, contentHash: originalHash, lastOperation: 'read' },
    ]);

    assert.deepEqual(results.map(result => result.stale), [false, true, true]);
    assert.equal(results[0]?.currentHash, originalHash);
    assert.equal(results[2]?.currentHash, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ── End-to-end recovery integration test ─────────────────

test('end-to-end recovery rebuilds context from persisted session events', async () => {
  const { loadConfig } = await import('@los/infra/config');
  const { closeDb, getDb, initDb } = await import('@los/infra/db');
  const config = await loadConfig();
  await initDb(config.databaseUrl);

  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const sessionId = `session-e2e-${suffix}`;
  const runSpecId = `run-e2e-${suffix}`;

  try {
    const { ensureSessionEventStore, appendSessionEvent, listSessionEvents } = await import('./session-events.js');
    const { ensureRunSpecStore, createRunSpec } = await import('./run-specs.js');
    const { ensureTaskRunStore, createTaskRun } = await import('./task-runs.js');

    await Promise.all([ensureSessionEventStore(), ensureRunSpecStore(), ensureTaskRunStore()]);

    // 1. Create run spec and task run (simulating a real execution start)
    await createRunSpec({
      id: runSpecId, sessionId, prompt: 'fix the bug in auth.ts',
      workspaceRoot: process.cwd(), toolMode: 'project-write', maxLoops: 4,
    });
    await createTaskRun({
      id: `task-e2e-${suffix}`, sessionId, runSpecId,
      provider: 'deepseek', model: 'deepseek-v4-flash',
      workspaceRoot: process.cwd(), toolMode: 'project-write', promptPreview: 'fix the bug',
    });

    // 2. Simulate 3 agent turns, then crash before the last tool result
    await appendSessionEvent({
      sessionId, type: 'session.started', source: 'los.execution',
      payload: { runSpecId }, visibility: 'public',
    });
    await appendSessionEvent({
      sessionId, type: 'user.message', source: 'chat',
      payload: { content: 'fix the bug in auth.ts' }, visibility: 'public',
    });
    await appendSessionEvent({
      sessionId, type: 'model.turn.completed', source: 'loop', turn: 1,
      payload: { textPreview: 'I will read the file first' }, visibility: 'public',
    });
    // Tool call persisted, result persisted
    await appendSessionEvent({
      sessionId, type: 'tool.call', source: 'loop', turn: 1, toolName: 'read_file',
      payload: { callId: 'call-1', args: { path: 'src/auth.ts' } }, visibility: 'public',
    });
    await appendSessionEvent({
      sessionId, type: 'tool.result', source: 'loop', turn: 1, toolName: 'read_file',
      payload: { callId: 'call-1', contentPreview: 'export function auth()' }, visibility: 'public',
    });
    // Turn 2 completes normally
    await appendSessionEvent({
      sessionId, type: 'model.turn.completed', source: 'loop', turn: 2,
      payload: { textPreview: 'Bug is on line 42' }, visibility: 'public',
    });
    // Turn 3: tool.call persisted, but CRASH before tool.result
    await appendSessionEvent({
      sessionId, type: 'tool.call', source: 'loop', turn: 3, toolName: 'edit_file',
      payload: { callId: 'call-2', args: { path: 'src/auth.ts' } }, visibility: 'public',
    });
    // NO tool.result for call-2 — simulated crash

    // 3. Load events and rebuild context
    const events = await listSessionEvents(sessionId, 100);
    assert.ok(events.length >= 5, `expected >=5 events, got ${events.length}`);

    const { buildMessagesFromEvents, classifyRecoveryMode, countLostToolResults } = await import('./session-recovery-context.js');
    const messages = buildMessagesFromEvents(sessionId, checkpoint(), events, true);
    const lostCount = countLostToolResults(messages, checkpoint());
    const mode = classifyRecoveryMode(lostCount, 0, checkpoint());

    // 4. Assert recovery correctness
    assert.ok(messages.length >= 4, `expected >=4 messages, got ${messages.length}`);
    assert.equal(mode, 'partial', 'missing tool result should yield partial recovery');

    // Verify user prompt is preserved
    const userMsg = messages.find(m => m.role === 'user');
    assert.ok(userMsg, 'recovery must preserve user message');

    // Verify tool messages are present
    const toolMsgs = messages.filter(m => m.role === 'tool');
    assert.ok(toolMsgs.length >= 1, 'at least 1 tool message expected');
  } finally {
    await getDb().query('DELETE FROM session_events WHERE session_id = $1', [sessionId]).catch(() => undefined);
    await getDb().query('DELETE FROM task_runs WHERE session_id = $1', [sessionId]).catch(() => undefined);
    await getDb().query('DELETE FROM run_specs WHERE id = $1', [runSpecId]).catch(() => undefined);
    await closeDb().catch(() => undefined);
  }
});

test('checkpoint version support accepts legacy and current formats', async () => {
  const { isCheckpointVersionSupported, CHECKPOINT_VERSION } = await import('./session-recovery.js');
  assert.equal(isCheckpointVersionSupported(undefined), true, 'legacy checkpoint without version is v1');
  assert.equal(isCheckpointVersionSupported(1), true);
  assert.equal(isCheckpointVersionSupported(CHECKPOINT_VERSION), true);
  assert.equal(isCheckpointVersionSupported(999), false, 'newer format must degrade');
});

test('end-to-end recovery degrades on an incompatible checkpoint version', async () => {
  const { loadConfig } = await import('@los/infra/config');
  const { closeDb, getDb, initDb } = await import('@los/infra/db');
  const { reconstructSessionContext } = await import('./session-recovery.js');
  const config = await loadConfig();
  await initDb(config.databaseUrl);

  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const sessionId = `session-ver-${suffix}`;
  try {
    // The table is created lazily by reconstructSessionContext; build the
    // minimal shape here so the INSERT below has a target.
    await getDb().exec(`
      CREATE TABLE IF NOT EXISTS memory_compactions (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        run_spec_id TEXT,
        summary_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        auto_trigger TEXT
      );
    `);
    await getDb().query(
      `INSERT INTO memory_compactions (id, session_id, run_spec_id, summary_json, auto_trigger)
       VALUES ($1, $2, $3, $4::jsonb, 'manual')`,
      [
        `chkpt-ver-${suffix}`,
        sessionId,
        `run-ver-${suffix}`,
        JSON.stringify({
          version: 999,
          toolState: { pendingCalls: [], lastResult: [] },
          fileReferences: [],
          messageCursor: { lastEventId: '1', lastEventIndex: 1, turnCount: 1 },
        }),
      ],
    );

    const output = await reconstructSessionContext({ sessionId });
    assert.equal(output.recoverySummary.recoveryMode, 'degraded');
    const incompat = output.recoverySummary.errorEvents.find(e => e.type === 'checkpoint_version_incompatible');
    assert.ok(incompat, 'degraded recovery must record a checkpoint_version_incompatible error event');
    assert.match(incompat!.message, /version 999/);
  } finally {
    await getDb().query('DELETE FROM memory_compactions WHERE session_id = $1', [sessionId]).catch(() => undefined);
    await closeDb().catch(() => undefined);
  }
});

test('recovered context can continue the agent loop via initialMessages', async () => {
  const { loadConfig } = await import('@los/infra/config');
  const { closeDb, getDb, initDb } = await import('@los/infra/db');
  const { reconstructSessionContext } = await import('./session-recovery.js');
  const { ConfigSchema, setConfig } = await import('@los/infra/config');
  const { runAgent } = await import('./loop.js');
  const config = await loadConfig();
  await initDb(config.databaseUrl);

  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const sessionId = `session-cont-${suffix}`;
  const runSpecId = `run-cont-${suffix}`;
  try {
    await getDb().exec(`
      CREATE TABLE IF NOT EXISTS memory_compactions (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, run_spec_id TEXT,
        summary_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(), auto_trigger TEXT
      );
    `);
    await getDb().query(
      `INSERT INTO memory_compactions (id, session_id, run_spec_id, summary_json, auto_trigger)
       VALUES ($1, $2, $3, $4::jsonb, 'manual')`,
      [ `chkpt-cont-${suffix}`, sessionId, runSpecId, JSON.stringify({
          version: 1,
          toolState: { pendingCalls: [], lastResult: [] },
          fileReferences: [],
          messageCursor: { lastEventId: '1', lastEventIndex: 1, turnCount: 1 },
        }) ],
    );
    const { ensureSessionEventStore, appendSessionEvent } = await import('./session-events.js');
    await ensureSessionEventStore();
    await appendSessionEvent({
      sessionId, type: 'session.started', source: 'los.execution',
      payload: { runSpecId }, visibility: 'public',
    });
    await appendSessionEvent({
      sessionId, type: 'user.message', source: 'chat',
      payload: { content: 'fix the bug in auth.ts' }, visibility: 'public',
    });
    await appendSessionEvent({
      sessionId, type: 'model.turn.completed', source: 'loop', turn: 1,
      payload: { textPreview: 'I will read the file first' }, visibility: 'public',
    });

    const recovered = await reconstructSessionContext({ sessionId });
    assert.ok(recovered.messages.length >= 3, 'recovered context should carry the prior conversation');

    // Feed the recovered messages into a fresh loop and verify it continues.
    const previous = await loadConfig();
    setConfig(ConfigSchema.parse({
      server: {}, agent: { defaultProvider: 'fixture' }, memory: {}, executor: {}, auth: {},
      providers: { fixture: { enabled: true, apiKey: 'fixture-key', baseUrl: 'https://fixture.invalid/v1' } },
    }));
    (globalThis as { fetch?: unknown }).fetch = async () => new Response(JSON.stringify({
      choices: [{
        message: {
          content: 'Continuing from the recovered context.',
          tool_calls: [{ id: 'call-cont', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: '/tmp/cont.txt' }) } }],
        },
        finish_reason: 'tool_calls',
      }],
      usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      model: 'fixture-model',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    try {
      const continued = await runAgent('Continue the work.', {
        provider: 'fixture',
        toolMode: 'read-only',
        sandboxMode: 'readonly',
        skipPreExecutionPhases: true,
        maxLoops: 2,
        initialMessages: recovered.messages,
      });
      assert.ok(continued.loopCount >= 1, 'loop must continue from the recovered context');
      assert.ok(continued.messages.length > recovered.messages.length,
        'continuation must extend the recovered message array');
    } finally {
      setConfig(previous);
    }
  } finally {
    await getDb().query('DELETE FROM memory_compactions WHERE session_id = $1', [sessionId]).catch(() => undefined);
    await getDb().query('DELETE FROM session_events WHERE session_id = $1', [sessionId]).catch(() => undefined);
    await closeDb().catch(() => undefined);
  }
});
