import assert from 'node:assert/strict';
import test from 'node:test';

import { sessionTraceCommand } from './session-trace.js';

type CapturedRequest = { url: string; method: string; headers: Headers };

function assistantMessage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    role: 'assistant',
    content: 'first line\nsecond line',
    turnIndex: 1,
    totalTurns: 2,
    provider: 'openai',
    model: 'gpt-4o',
    reasoning: 'think step 1',
    toolCalls: [
      {
        callId: 'call-1',
        toolName: 'read_file',
        status: 'completed',
        argsPreview: '{"path":"a.ts"}',
        durationMs: 42,
        resultPreview: 'ok',
      },
    ],
    ...overrides,
  };
}

function userMessage(content = 'inspect this'): Record<string, unknown> {
  return { role: 'user', content, toolCalls: [] };
}

async function runCommand(
  argv: string[],
  fetchMock: (request: CapturedRequest, callIndex: number) => Response,
): Promise<{ requests: CapturedRequest[]; output: string[] }> {
  const requests: CapturedRequest[] = [];
  const output: string[] = [];
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  globalThis.fetch = async (input, init) => {
    const request = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
    };
    requests.push(request);
    return fetchMock(request, requests.length - 1);
  };
  console.log = (line: unknown) => output.push(String(line));
  try {
    await sessionTraceCommand([], argv);
    return { requests, output };
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

test('sessions trace renders a user message with counts header', async () => {
  const { output } = await runCommand(['trace', 's1'], () => jsonResponse({
    sessionId: 's1',
    since: 0,
    nextSince: 0,
    messages: [userMessage()],
    messageCount: 1,
    turnCount: 1,
  }));
  assert.deepEqual(output, ['session=s1 messages=1 turns=1', 'user: inspect this']);
});

test('sessions trace renders assistant identity, reasoning, content, and tools', async () => {
  const { output } = await runCommand(['trace', 's1'], () => jsonResponse({
    sessionId: 's1',
    since: 0,
    nextSince: 0,
    messages: [assistantMessage()],
    messageCount: 1,
    turnCount: 2,
  }));
  assert.deepEqual(output, [
    'session=s1 messages=1 turns=2',
    'assistant [turn 1/2] gpt-4o · openai',
    '  reasoning: think step 1',
    '  first line',
    '  second line',
    '  tool:read_file completed (42ms)',
    '    args: {"path":"a.ts"}',
    '    result: ok',
  ]);
});

test('sessions trace renders system messages with level and meta', async () => {
  const { output } = await runCommand(['trace', 's1'], () => jsonResponse({
    sessionId: 's1',
    since: 0,
    nextSince: 0,
    messages: [{ role: 'system', content: 'run completed', level: 'ok', meta: 'session s-1', toolCalls: [] }],
  }));
  assert.ok(output.includes('[system] (ok) run completed session s-1'));
});

test('sessions trace --json emits the raw typed projection', async () => {
  const { output } = await runCommand(['trace', 's1', '--json'], () => jsonResponse({
    sessionId: 's1',
    since: 0,
    nextSince: 0,
    messages: [userMessage()],
  }));
  assert.ok(output.length === 1 && output[0]!.includes('"sessionId":"s1"'));
});

test('sessions trace requests /trace/since with since=0 and sends the configured token', async () => {
  const originalToken = process.env.LOS_AUTH_TOKEN;
  process.env.LOS_AUTH_TOKEN = 'env-access';
  try {
    const { requests } = await runCommand(['trace', 'session-auth'], () => jsonResponse({
      sessionId: 'session-auth',
      since: 0,
      nextSince: 0,
      messages: [],
    }));
    assert.equal(requests.length, 1);
    assert.ok(requests[0]!.url.endsWith('/sessions/session-auth/trace/since?since=0'));
    assert.equal(requests[0]!.headers.get('x-los-auth-token'), 'env-access');
  } finally {
    if (originalToken === undefined) delete process.env.LOS_AUTH_TOKEN;
    else process.env.LOS_AUTH_TOKEN = originalToken;
  }
});

test('sessions follow prints each message once, surfaces tool updates, and idle-exits', async () => {
  const { output, requests } = await runCommand(
    ['follow', 's1', '--interval-ms', '1', '--max-idle-ms', '2'],
    (_request, callIndex) => {
      if (callIndex === 0) {
        return jsonResponse({
          sessionId: 's1',
          since: 0,
          nextSince: 3,
          messages: [assistantMessage({ toolCalls: [{ callId: 'call-1', toolName: 'read_file', status: 'running', argsPreview: '' }] })],
        });
      }
      if (callIndex === 1) {
        return jsonResponse({
          sessionId: 's1',
          since: 3,
          nextSince: 4,
          messages: [assistantMessage(), userMessage('continue')],
        });
      }
      return jsonResponse({ sessionId: 's1', since: 4, nextSince: 4, messages: [], unchanged: true });
    },
  );

  assert.equal(output.filter(line => line.startsWith('assistant')).length, 1, 'assistant rendered once');
  assert.ok(output.includes('  tool:read_file -> completed (42ms)'), 'tool status update printed');
  assert.ok(output.includes('user: continue'), 'new message printed');
  assert.ok(requests[1]!.url.includes('since=3'), 'second poll uses high-water cursor');
});

test('sessions follow exits by idle timeout and keeps polling the last cursor', async () => {
  const { requests } = await runCommand(
    ['follow', 's2', '--interval-ms', '1', '--max-idle-ms', '2'],
    (_request, callIndex) => {
      if (callIndex === 0) {
        return jsonResponse({
          sessionId: 's2',
          since: 0,
          nextSince: 9,
          messages: [userMessage('go')],
        });
      }
      return jsonResponse({ sessionId: 's2', since: 9, nextSince: 9, messages: [], unchanged: true });
    },
  );

  assert.ok(requests[0]!.url.includes('since=0'));
  assert.ok(requests[1]!.url.includes('since=9'));
  assert.ok(requests.length >= 3, `expected several polls before idle exit, got ${requests.length}`);
});
