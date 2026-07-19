import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';

import { ConfigSchema, getConfig, setConfig } from '@los/infra/config';
import { getDb } from '@los/infra/db';
import { runAgent } from './loop.js';
import {
  consumeOperatorControlEvents,
  type OperatorControlCursors,
} from './operator-control-consumer.js';
import { recordOperatorFollowup, recordOperatorSteering } from './operator-control.js';
import { listSessionEvents } from './session-events.js';

test('active loop consumes steering once at the next model boundary', async (t) => {
  configureFixtureProvider(t);
  const sessionId = uniqueId('steering');
  const requests: Array<Record<string, unknown>> = [];
  let call = 0;

  t.mock.method(globalThis, 'fetch', async (_input: string | URL | Request, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    call += 1;
    if (call === 1) {
      await recordOperatorSteering({
        sessionId,
        runSpecId: 'run-steering',
        taskRunId: 'task-steering',
        instruction: 'Inspect the verification evidence before finishing.',
        turnBoundary: 'immediate',
        drainMode: 'finish_current_turn',
      });
      return providerResponse('Still working.', 'length');
    }
    return providerResponse('Verified and complete.', 'stop');
  });

  try {
    const result = await runAgent('Start the task.', {
      sessionId,
      runSpecId: 'run-steering',
      taskRunId: 'task-steering',
      provider: 'fixture',
      maxLoops: 3,
      allowedTools: [],
    });

    assert.equal(result.loopCount, 2);
    assert.equal(requests.length, 2);
    assert.match(JSON.stringify(requests[1]), /Operator steering/);
    assert.match(JSON.stringify(requests[1]), /Inspect the verification evidence/);

    const events = await listSessionEvents(sessionId, 100);
    assert.equal(events.filter(event => event.type === 'operator.control.consumed').length, 1);

    const replay = await consumeOperatorControlEvents({
      sessionId,
      runSpecId: 'run-steering',
      taskRunId: 'task-steering',
      turn: 3,
      boundary: 'before_turn',
      cursors: emptyCursors(),
      includeFollowups: false,
    });
    assert.equal(replay.consumed.length, 0);
  } finally {
    await deleteSessionEvents(sessionId);
  }
});

test('follow-up waits until the current response would complete', async (t) => {
  configureFixtureProvider(t);
  const sessionId = uniqueId('followup');
  const requests: Array<Record<string, unknown>> = [];
  let call = 0;

  t.mock.method(globalThis, 'fetch', async (_input: string | URL | Request, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    call += 1;
    if (call === 1) {
      await recordOperatorFollowup({
        sessionId,
        runSpecId: 'run-followup',
        taskRunId: 'task-followup',
        prompt: 'Now summarize the residual risk.',
      });
      return providerResponse('The primary work is complete.', 'stop');
    }
    return providerResponse('Residual risk summarized.', 'stop');
  });

  try {
    const result = await runAgent('Complete the primary work.', {
      sessionId,
      runSpecId: 'run-followup',
      taskRunId: 'task-followup',
      provider: 'fixture',
      maxLoops: 3,
      allowedTools: [],
    });

    assert.equal(result.loopCount, 2);
    assert.doesNotMatch(JSON.stringify(requests[0]), /Operator follow-up/);
    assert.match(JSON.stringify(requests[1]), /Operator follow-up/);
    assert.match(JSON.stringify(requests[1]), /summarize the residual risk/);
  } finally {
    await deleteSessionEvents(sessionId);
  }
});

test('concurrent consumers cannot claim the same operator event twice', async () => {
  const sessionId = uniqueId('concurrent');
  try {
    await recordOperatorSteering({
      sessionId,
      instruction: 'Use the persisted result.',
    });
    const input = {
      sessionId,
      turn: 1,
      boundary: 'before_turn' as const,
      cursors: emptyCursors(),
      includeFollowups: false,
    };
    const results = await Promise.all([
      consumeOperatorControlEvents(input),
      consumeOperatorControlEvents(input),
    ]);

    assert.equal(results.reduce((sum, result) => sum + result.consumed.length, 0), 1);
    const events = await listSessionEvents(sessionId, 100);
    assert.equal(events.filter(event => event.type === 'operator.control.consumed').length, 1);
  } finally {
    await deleteSessionEvents(sessionId);
  }
});

test('consumer scans past a full page of unrelated session events', async () => {
  const sessionId = uniqueId('pagination');
  try {
    const params: unknown[] = [];
    const values: string[] = [];
    for (let index = 0; index < 205; index += 1) {
      const base = params.length;
      values.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}::jsonb)`);
      params.push(sessionId, index + 1, 'model.response', '{}');
    }
    await getDb().query(
      `INSERT INTO session_events (session_id, turn, type, payload_json) VALUES ${values.join(', ')}`,
      params,
    );
    const source = await recordOperatorSteering({ sessionId, instruction: 'Read beyond the first page.' });

    const result = await consumeOperatorControlEvents({
      sessionId,
      turn: 1,
      boundary: 'before_turn',
      cursors: emptyCursors(),
      includeFollowups: false,
    });

    assert.equal(result.consumed.length, 1);
    assert.equal(result.consumed[0]?.source.id, source.id);
    assert.ok(result.cursors.steering >= source.id);
    assert.equal(result.cursors.followup, 0);
  } finally {
    await deleteSessionEvents(sessionId);
  }
});

function configureFixtureProvider(t: TestContext): void {
  const previous = getConfig();
  t.after(() => setConfig(previous));
  setConfig(ConfigSchema.parse({
    server: {}, agent: { defaultProvider: 'fixture' }, memory: {}, executor: {}, auth: {},
    providers: {
      fixture: {
        apiKey: 'fixture-key',
        baseUrl: 'https://fixture.invalid/v1',
        model: 'fixture-model',
        enabled: true,
      },
    },
  }));
}

function providerResponse(content: string, finishReason: 'stop' | 'length'): Response {
  return new Response(JSON.stringify({
    choices: [{ message: { content, tool_calls: [] }, finish_reason: finishReason }],
    usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
    model: 'fixture-model',
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function emptyCursors(): OperatorControlCursors {
  return { steering: 0, followup: 0 };
}

function uniqueId(prefix: string): string {
  return `operator-control-${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function deleteSessionEvents(sessionId: string): Promise<void> {
  await getDb().query('DELETE FROM session_events WHERE session_id = $1', [sessionId]);
}
