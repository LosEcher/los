import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig } from '@los/infra/config';
import { closeDb, getDb, initDb } from '@los/infra/db';
import {
  _projectKernelEvent,
  _createKernelEventProjector,
} from './kernel-event-projection.js';
import type { KernelEvent } from './execution-kernel.js';
import type { SessionEventWrite } from './session-events.js';
import { listSessionEvents } from './session-events.js';

const kernel = { kind: 'los', version: '0.1.0', protocolVersion: '0.1.0' };
const context = {
  sessionId: 'session-1',
  taskRunId: 'task-1',
  runSpecId: 'run-1',
  traceId: 'trace-1',
  tenantId: 'tenant-1',
  projectId: 'project-1',
  nodeId: 'gateway-local',
};

test('kernel event projection persists lineage and bounded delta evidence', () => {
  const event: KernelEvent = {
    sequence: 2,
    type: 'message.delta',
    occurredAt: '2026-07-22T00:00:00.000Z',
    kernel,
    turn: 1,
    payload: {
      delta: {
        provider: 'fixture',
        model: 'fixture-model',
        textDelta: 'secret transcript text',
        reasoningDelta: 'private reasoning',
      },
    },
  };

  const projected = _projectKernelEvent(event, context);

  assert.equal(projected.type, 'message.delta');
  assert.equal(projected.source, 'los.kernel.los');
  assert.equal(projected.visibility, 'audit');
  assert.equal(projected.model, 'fixture-model');
  assert.deepEqual(projected.payload, {
    sequence: 2,
    occurredAt: event.occurredAt,
    kernel,
    runSpecId: 'run-1',
    taskRunId: 'task-1',
    messageId: null,
    toolCallId: null,
    evidence: {
      provider: 'fixture',
      model: 'fixture-model',
      textDeltaLength: 22,
      reasoningDeltaLength: 17,
    },
  });
  assert.equal(JSON.stringify(projected).includes('secret transcript text'), false);
  assert.equal(JSON.stringify(projected).includes('private reasoning'), false);
});

test('kernel event projector appends ordered usage evidence through LOS storage owner', async () => {
  const writes: SessionEventWrite[] = [];
  const project = _createKernelEventProjector(context, async write => {
    writes.push(write);
  });

  await project({
    sequence: 7,
    type: 'usage.recorded',
    occurredAt: '2026-07-22T00:00:01.000Z',
    kernel,
    payload: { totalTokens: { prompt: 10, completion: 4 } },
  });

  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].usage, {
    promptTokens: 10,
    completionTokens: 4,
    totalTokens: 14,
  });
  assert.equal(writes[0].payload?.sequence, 7);
});

test('kernel event projection summarizes tool and checkpoint payloads without raw values', () => {
  const tool = _projectKernelEvent({
    sequence: 3,
    type: 'tool.requested',
    occurredAt: '2026-07-22T00:00:00.000Z',
    kernel,
    turn: 1,
    toolCallId: 'call-1',
    payload: { tool: 'write_file', args: { path: 'secret.txt', content: 'sensitive' } },
  }, context);
  const checkpoint = _projectKernelEvent({
    sequence: 4,
    type: 'checkpoint.created',
    occurredAt: '2026-07-22T00:00:00.000Z',
    kernel,
    payload: {
      checkpoint: {
        kernel,
        codec: 'fixture-v1',
        value: { messages: [{ content: 'raw' }], turns: [{ text: 'raw' }] },
      },
    },
  }, context);

  assert.deepEqual(tool.payload?.evidence, {
    toolName: 'write_file',
    argumentKeys: ['content', 'path'],
  });
  assert.equal(tool.toolName, 'write_file');
  assert.deepEqual(checkpoint.payload?.evidence, {
    codec: 'fixture-v1',
    kernel,
    messageCount: 1,
    turnCount: 1,
  });
  assert.equal(JSON.stringify([tool, checkpoint]).includes('sensitive'), false);
  assert.equal(JSON.stringify([tool, checkpoint]).includes('secret.txt'), false);
});

test('kernel event projector durably appends canonical evidence to session_events', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const sessionId = `session-kernel-projection-${suffix}`;

  try {
    const project = _createKernelEventProjector({
      ...context,
      sessionId,
    });
    await project({
      sequence: 0,
      type: 'kernel.started',
      occurredAt: '2026-07-22T00:00:00.000Z',
      kernel,
      payload: { sessionId, taskRunId: context.taskRunId, runSpecId: context.runSpecId },
    });
    await project({
      sequence: 1,
      type: 'kernel.finished',
      occurredAt: '2026-07-22T00:00:01.000Z',
      kernel,
      payload: {
        result: {
          text: 'raw final response',
          loopCount: 1,
          turns: [{ text: 'raw final response' }],
          messages: [{ role: 'assistant', content: 'raw final response' }],
          totalTokens: { prompt: 3, completion: 2 },
        },
      },
    });

    const events = await listSessionEvents(sessionId);
    assert.deepEqual(events.map(event => event.type), ['kernel.started', 'kernel.finished']);
    assert.deepEqual(events.map(event => event.payload.sequence), [0, 1]);
    assert.ok(events.every(event => event.visibility === 'audit'));
    assert.ok(events.every(event => event.source === 'los.kernel.los'));
    assert.equal(JSON.stringify(events).includes('raw final response'), false);
  } finally {
    await getDb().query('DELETE FROM session_events WHERE session_id = $1', [sessionId]).catch(() => undefined);
    await closeDb().catch(() => undefined);
  }
});
