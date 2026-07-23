import assert from 'node:assert/strict';
import test from 'node:test';
import { ConfigSchema, getConfig, setConfig } from '@los/infra/config';
import { closeDb, getDb, initDb } from '@los/infra/db';
import { listSessionEvents } from './session-events.js';
import { runScheduledAgentTask } from './scheduler.js';

test('scheduler keeps LOS output authoritative while Pi runs under shadow lineage', async t => {
  const previous = getConfig();
  t.after(() => setConfig(previous));
  await initDb(previous.databaseUrl);
  setConfig(ConfigSchema.parse({
    server: {}, agent: { defaultProvider: 'fixture', defaultModel: 'fixture-model' },
    memory: {}, executor: {}, auth: {},
    providers: { fixture: {
      apiKey: 'fixture-key', baseUrl: 'https://fixture.invalid/v1',
      model: 'fixture-model', enabled: true,
    } },
  }));
  const requests: Array<{ stream?: boolean; piTransport: boolean }> = [];
  t.mock.method(globalThis, 'fetch', async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { stream?: boolean };
    const piTransport = new Headers(init?.headers).has('x-stainless-lang');
    requests.push({ stream: body.stream, piTransport });
    return piStreamResponse(piTransport ? 'candidate answer' : 'production answer');
  });

  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const sessionId = `session-kernel-shadow-${suffix}`;
  const taskRunId = `task-kernel-shadow-${suffix}`;
  const traceId = `trace-kernel-shadow-${suffix}`;
  const shadowSessionId = `${sessionId}:shadow:pi`;

  try {
    const result = await runScheduledAgentTask({
      prompt: 'compare two kernels without writes',
      sessionId, taskRunId, traceId,
      provider: 'fixture', model: 'fixture-model',
      workspaceRoot: process.cwd(),
      toolMode: 'read-only', sandboxMode: 'readonly',
      allowedTools: [], maxLoops: 1,
      executionKernelShadow: { kind: 'pi', maxTurns: 1 },
    });

    assert.equal(result.status, 'completed');
    assert.equal(result.result.text, 'production answer');
    assert.equal(requests.filter(request => request.piTransport).length, 1);
    assert.equal(requests.filter(request => !request.piTransport).length, 1);

    const productionEvents = await listSessionEvents(sessionId, 100);
    const comparison = productionEvents.filter(event => event.type === 'kernel.shadow.compared');
    assert.equal(comparison.length, 1);
    assert.equal(comparison[0]?.payload.status, 'completed');
    assert.equal(comparison[0]?.payload.candidateSessionId, shadowSessionId);
    assert.notEqual(comparison[0]?.payload.productionOutputHash, comparison[0]?.payload.outputHash);
    assert.equal(JSON.stringify(comparison[0]?.payload).includes('candidate answer'), false);
    assert.equal(JSON.stringify(comparison[0]?.payload).includes('production answer'), false);

    const shadowEvents = await listSessionEvents(shadowSessionId, 100);
    assert.ok(shadowEvents.some(event => event.source === 'los.kernel.pi' && event.type === 'kernel.finished'));
    assert.ok(!shadowEvents.some(event => event.type.startsWith('task.')));
  } finally {
    await getDb().query('DELETE FROM provider_call_telemetry WHERE trace_id IN ($1, $2)', [traceId, `${traceId}:shadow:pi`]).catch(() => undefined);
    await getDb().query('DELETE FROM session_events WHERE session_id IN ($1, $2)', [sessionId, shadowSessionId]).catch(() => undefined);
    await getDb().query('DELETE FROM task_runs WHERE id = $1', [taskRunId]).catch(() => undefined);
    await closeDb().catch(() => undefined);
  }
});

function piStreamResponse(text: string): Response {
  const chunks = [
    { id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture-model', choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] },
    { id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture-model', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 } },
  ];
  const body = `${chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`;
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}
