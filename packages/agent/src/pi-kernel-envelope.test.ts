import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { ConfigSchema, getConfig, setConfig } from '@los/infra/config';
import { _consumeExecutionKernel } from './execution-kernel.js';
import type { AgentResult } from './loop.js';
import { runAgent } from './loop.js';
import { _createPiExecutionKernel } from './pi-execution-kernel.js';
import { _preparePiKernelRun } from './pi-kernel-input.js';

type Envelope = Record<string, unknown>;
type KernelLabel = 'los' | 'pi';

const MODEL = 'deepseek-v4-flash';
const PROMPT = 'Read package.json once and return only {"packageName":"<name>"}.';
const SYSTEM_PROMPT = 'Use the read_file tool once, then answer with the requested JSON object.';
const TOOL_CALL_ID = 'call-read-package';
const FINAL_TEXT = '{"packageName":"@los/agent"}';

test('LOS and Pi second-turn provider envelopes expose only preregistered mapping differences', async t => {
  const captured: Record<KernelLabel, Envelope[]> = { los: [], pi: [] };
  let activeKernel: KernelLabel = 'los';
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input.clone() : new Request(input, init);
    const envelope = JSON.parse(await request.text()) as Envelope;
    captured[activeKernel].push(envelope);
    return providerResponse(envelope.stream === true, captured[activeKernel].length);
  });

  configureDeepSeek(t);
  const commonConfig = {
    provider: 'deepseek',
    model: MODEL,
    systemPrompt: SYSTEM_PROMPT,
    workspaceRoot: process.cwd(),
    toolMode: 'read-only' as const,
    sandboxMode: 'readonly' as const,
    allowedTools: ['read_file'],
    maxLoops: 3,
    modelSettings: { temperature: 0 },
    skipPreExecutionPhases: true,
    identity: { level: 'none' as const },
  };

  const losResult = await runAgent(PROMPT, commonConfig);

  activeKernel = 'pi';
  const prepared = await _preparePiKernelRun(PROMPT, {
    ...commonConfig,
    taskRunId: 'task-pi-envelope',
    sessionId: 'session-pi-envelope',
    traceId: 'trace-pi-envelope',
  }, {
    resolveCredential: async () => ({ apiKey: 'fixture-key' }),
    recordProviderCall: async () => {},
  });
  t.after(prepared.cleanup);
  const piResult = await _consumeExecutionKernel<typeof prepared.input, AgentResult>(
    _createPiExecutionKernel(),
    prepared.input,
  );

  assert.equal(losResult.text, FINAL_TEXT);
  assert.equal(piResult.result.text, FINAL_TEXT);
  assert.equal(captured.los.length, 2);
  assert.equal(captured.pi.length, 2);

  const los = captured.los[1]!;
  const pi = captured.pi[1]!;
  const losMessages = messages(los);
  const piMessages = messages(pi);

  assert.deepEqual(losMessages.map(message => message.role), ['system', 'user', 'assistant', 'tool']);
  assert.deepEqual(piMessages.map(message => message.role), ['system', 'user', 'assistant', 'tool']);
  assert.equal(losMessages[0]!.content, piMessages[0]!.content);
  assert.equal(losMessages[1]!.content, piMessages[1]!.content);
  assert.deepEqual(losMessages[2]!.tool_calls, piMessages[2]!.tool_calls);
  assert.deepEqual(losMessages[3], piMessages[3]);
  assert.deepEqual(stripToolStrictness(los.tools), stripToolStrictness(pi.tools));

  assert.deepEqual(topLevelKeysOnlyIn(los, pi), ['tool_choice']);
  assert.deepEqual(topLevelKeysOnlyIn(pi, los), ['max_completion_tokens', 'stream_options', 'thinking']);
  assert.equal(los.tool_choice, 'auto');
  assert.equal(pi.tool_choice, undefined);
  assert.equal(los.parallel_tool_calls, false);
  assert.equal(pi.parallel_tool_calls, false);
  assert.equal(los.thinking, undefined);
  assert.deepEqual(pi.thinking, { type: 'disabled' });
  assert.equal(los.max_completion_tokens, undefined);
  assert.equal(pi.max_completion_tokens, 32_000);
  assert.equal(los.stream, false);
  assert.equal(pi.stream, true);
  assert.equal(los.stream_options, undefined);
  assert.deepEqual(pi.stream_options, { include_usage: true });
  assert.equal(losMessages[2]!.content, '');
  assert.equal(piMessages[2]!.content, null);
  assert.equal(losMessages[2]!.reasoning_content, undefined);
  assert.equal(piMessages[2]!.reasoning_content, '');
  assert.equal(toolStrictness(los.tools), undefined);
  assert.equal(toolStrictness(pi.tools), false);
});

function configureDeepSeek(t: TestContext): void {
  const previous = getConfig();
  t.after(() => setConfig(previous));
  setConfig(ConfigSchema.parse({
    server: {},
    agent: { defaultProvider: 'deepseek', defaultModel: MODEL },
    memory: {},
    executor: {},
    auth: {},
    providers: {
      deepseek: {
        apiKey: 'fixture-key',
        baseUrl: 'https://api.deepseek.com/v1',
        model: MODEL,
        enabled: true,
      },
    },
  }));
}

function providerResponse(stream: boolean, turn: number): Response {
  const body = turn === 1 ? toolCallResponse() : finalResponse();
  if (!stream) {
    const toolCalls = toolCallResponse().choices[0]!.delta.tool_calls
      .map(({ index: _index, ...call }) => call);
    return new Response(JSON.stringify({
      ...body,
      choices: [{
        index: 0,
        message: turn === 1
          ? {
              role: 'assistant',
              content: '',
              tool_calls: toolCalls,
            }
          : { role: 'assistant', content: FINAL_TEXT },
        finish_reason: body.choices[0]!.finish_reason,
      }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }

  const terminal = {
    id: body.id,
    object: 'chat.completion.chunk',
    created: 1,
    model: MODEL,
    choices: [{ index: 0, delta: {}, finish_reason: turn === 1 ? 'tool_calls' : 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
  };
  return new Response(
    `data: ${JSON.stringify(body)}\n\ndata: ${JSON.stringify(terminal)}\n\ndata: [DONE]\n\n`,
    {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    },
  );
}

function toolCallResponse() {
  return {
    id: 'chatcmpl-tool',
    object: 'chat.completion.chunk',
    created: 1,
    model: MODEL,
    choices: [{
      index: 0,
      delta: {
        role: 'assistant',
        tool_calls: [{
          index: 0,
          id: TOOL_CALL_ID,
          type: 'function',
          function: { name: 'read_file', arguments: '{"path":"package.json"}' },
        }],
      },
      finish_reason: null as string | null,
    }],
    usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
  };
}

function finalResponse() {
  return {
    id: 'chatcmpl-final',
    object: 'chat.completion.chunk',
    created: 1,
    model: MODEL,
    choices: [{
      index: 0,
      delta: { role: 'assistant', content: FINAL_TEXT },
      finish_reason: null as string | null,
    }],
    usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
  };
}

function messages(envelope: Envelope): Envelope[] {
  assert.ok(Array.isArray(envelope.messages));
  return envelope.messages as Envelope[];
}

function topLevelKeysOnlyIn(left: Envelope, right: Envelope): string[] {
  return Object.keys(left).filter(key => !(key in right)).sort();
}

function stripToolStrictness(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.map(item => {
    const tool = item as Envelope;
    const fn = tool.function as Envelope;
    const { strict: _strict, ...rest } = fn;
    return { ...tool, function: rest };
  });
}

function toolStrictness(value: unknown): unknown {
  if (!Array.isArray(value)) return undefined;
  return ((value[0] as Envelope | undefined)?.function as Envelope | undefined)?.strict;
}
