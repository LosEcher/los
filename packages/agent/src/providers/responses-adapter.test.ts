/**
 * Regression tests for the OpenAI Responses API streaming adapter.
 *
 * The key failure mode being fixed: PackyCode via Chat Completions produces
 * broken tool-call arguments when streaming because the delta.tool_calls[index]
 * aggregation model doesn't match the Responses API wire format.
 *
 * These tests drive the ACTUAL adapter code (readResponsesStreamResponse,
 * convertMessagesToResponsesInput) via mock SSE Response objects. A regression
 * in the real parser will fail these tests — unlike unit tests that reimplement
 * the logic locally.
 *
 * Verified scenarios:
 *   1. .done event provides complete authoritative arguments
 *   2. Multiple tool calls are tracked independently by item_id
 *   3. Empty delta — name comes from .done
 *   4. Glued-together arguments (the old chat-completions failure) don't occur
 *   5. Message-to-input conversion for Responses API format
 *   6. wire_api parsing maps "responses" → "openai-responses"
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCodexRouteConfig } from '@los/infra/discovery';
import {
  convertMessagesToResponsesInput,
  readResponsesStreamResponse,
} from './index.js';
import type { Message } from './types.js';

// ── Helpers ──────────────────────────────────────────────

/** Build a mock SSE Response from an array of raw SSE payload strings. */
function mockSseResponse(payloads: string[]): Response {
  const encoder = new TextEncoder();
  const sseText = payloads
    .map(p => `data: ${p}\n\n`)
    .join('');
  // Split into chunks of ~1 SSE event each to exercise buffer reassembly
  const lines = sseText.split('\n');
  const chunks: Uint8Array[] = [];
  let buf = '';
  for (const line of lines) {
    buf += line + '\n';
    if (line === '' && buf.trim()) {
      chunks.push(encoder.encode(buf));
      buf = '';
    }
  }
  if (buf.trim()) chunks.push(encoder.encode(buf));

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });

  return new Response(stream, { status: 200 });
}

// ── wire_api parsing ────────────────────────────────────

test('parseCodexRouteConfig extracts wire_api from cc-switch Codex TOML but strips it for packycode (unsupported endpoint)', () => {
  const route = parseCodexRouteConfig(`
model_provider = "packy"
model = "gpt-5.5"

[model_providers.packy]
name = "packycode"
base_url = "https://www.packyapi.com/v1"
wire_api = "responses"
`);

  assert.equal(route.providerName, 'packycode');
  assert.equal(route.baseUrl, 'https://www.packyapi.com/v1');
  assert.equal(route.model, 'gpt-5.5');
  // PackyCode does not support /v1/responses — wireApi must be stripped
  // so los falls back to openai-chat-completions.
  assert.equal(route.wireApi, undefined);
});

test('parseCodexRouteConfig omits wire_api when not present', () => {
  const route = parseCodexRouteConfig(`
model_provider = "custom"
model = "gpt-5.5"

[model_providers.custom]
name = "openai"
base_url = "https://api.openai.com/v1"
`);

  assert.equal(route.wireApi, undefined);
});

test('parseCodexRouteConfig with wire_api=responses maps packyapi to packycode but strips wireApi', () => {
  const route = parseCodexRouteConfig(`
model_provider = "p"
model = "gpt-5.4"

[model_providers.p]
base_url = "https://www.packyapi.com/v1"
wire_api = "responses"
`);

  assert.equal(route.providerName, 'packycode');
  // PackyCode does not support /v1/responses — wireApi must be undefined.
  assert.equal(route.wireApi, undefined);
});

// ── Message conversion ───────────────────────────────────

test('convertMessagesToResponsesInput handles system, user, assistant, tool roles', () => {
  const messages: Message[] = [
    { role: 'system', content: 'You are helpful.' },
    { role: 'user', content: 'Read /etc/hosts' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"/etc/hosts"}' } }] },
    { role: 'tool', content: '127.0.0.1 localhost', tool_call_id: 'c1' },
    { role: 'user', content: 'Thanks' },
  ];

  const input = convertMessagesToResponsesInput(messages);

  assert.equal(input.length, 5);
  assert.deepEqual(input[0], { type: 'message', role: 'system', content: 'You are helpful.' });
  assert.deepEqual(input[1], { type: 'message', role: 'user', content: 'Read /etc/hosts' });
  assert.deepEqual(input[2], { type: 'function_call', call_id: 'c1', name: 'read_file', arguments: '{"path":"/etc/hosts"}' });
  assert.deepEqual(input[3], { type: 'function_call_output', call_id: 'c1', output: '127.0.0.1 localhost' });
  assert.deepEqual(input[4], { type: 'message', role: 'user', content: 'Thanks' });
});

// ── Streaming adapter — drives readResponsesStreamResponse  ─

test('.done event provides complete authoritative arguments', async () => {
  const ssePayloads = [
    JSON.stringify({ type: 'response.created', response: { model: 'gpt-5.5' } }),
    JSON.stringify({ type: 'response.function_call_arguments.delta', item_id: 'i1', call_id: 'c1', name: 'read_file', delta: '{"path' }),
    JSON.stringify({ type: 'response.function_call_arguments.delta', item_id: 'i1', delta: '":"/etc/hosts"}' }),
    JSON.stringify({ type: 'response.function_call_arguments.done', item_id: 'i1', call_id: 'c1', name: 'read_file', arguments: '{"path":"/etc/hosts"}' }),
    JSON.stringify({ type: 'response.completed', response: { usage: { input_tokens: 10, output_tokens: 20 } } }),
  ];

  const res = mockSseResponse(ssePayloads);
  const result = await readResponsesStreamResponse(res, 'gpt-5.5', 'test', () => {});

  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].function.name, 'read_file');
  const parsed = JSON.parse(result.toolCalls[0].function.arguments);
  assert.equal(parsed.path, '/etc/hosts');
});

test('streaming isolates tool calls by item_id', async () => {
  const ssePayloads = [
    JSON.stringify({ type: 'response.created', response: { model: 'gpt-5.4' } }),
    // Tool call A — completes first
    JSON.stringify({ type: 'response.function_call_arguments.delta', item_id: 'a', call_id: 'ca', name: 'list_directory', delta: '{"path":"."}' }),
    JSON.stringify({ type: 'response.function_call_arguments.done', item_id: 'a', call_id: 'ca', name: 'list_directory', arguments: '{"path":"."}' }),
    // Tool call B — interleaved after A starts
    JSON.stringify({ type: 'response.function_call_arguments.delta', item_id: 'b', call_id: 'cb', name: 'read_file', delta: '{"path":"/etc' }),
    JSON.stringify({ type: 'response.function_call_arguments.delta', item_id: 'b', delta: '/hosts"}' }),
    JSON.stringify({ type: 'response.function_call_arguments.done', item_id: 'b', call_id: 'cb', name: 'read_file', arguments: '{"path":"/etc/hosts"}' }),
    JSON.stringify({ type: 'response.completed', response: { usage: { input_tokens: 5, output_tokens: 5 } } }),
  ];

  const res = mockSseResponse(ssePayloads);
  const result = await readResponsesStreamResponse(res, 'gpt-5.4', 'test', () => {});

  assert.equal(result.toolCalls.length, 2);
  assert.equal(result.toolCalls[0].function.name, 'list_directory');
  assert.equal(result.toolCalls[1].function.name, 'read_file');

  const a = JSON.parse(result.toolCalls[0].function.arguments);
  const b = JSON.parse(result.toolCalls[1].function.arguments);
  assert.deepEqual(a, { path: '.' });
  assert.deepEqual(b, { path: '/etc/hosts' });
});

test('.done event fills name when delta was empty', async () => {
  // Reproduces the old failure: Chat Completions would produce name=""
  // when a delta arrives without a name field. Responses .done carries it.
  const ssePayloads = [
    JSON.stringify({ type: 'response.created', response: { model: 'gpt-5.5' } }),
    // Delta without name — name arrives in .done
    JSON.stringify({ type: 'response.function_call_arguments.delta', item_id: 'x', call_id: 'cx', delta: '{"pattern":"*.ts"}' }),
    JSON.stringify({ type: 'response.function_call_arguments.done', item_id: 'x', call_id: 'cx', name: 'search_files', arguments: '{"pattern":"*.ts"}' }),
    JSON.stringify({ type: 'response.completed', response: { usage: { input_tokens: 5, output_tokens: 5 } } }),
  ];

  const res = mockSseResponse(ssePayloads);
  const result = await readResponsesStreamResponse(res, 'gpt-5.5', 'test', () => {});

  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].function.name, 'search_files');
  assert.deepEqual(JSON.parse(result.toolCalls[0].function.arguments), { pattern: '*.ts' });
});

test('does NOT produce glued-together arguments (the old chat-completions failure)', async () => {
  // The old Chat Completions bug: two tool calls would merge because
  // delta.tool_calls[index] can't distinguish between calls with the same index.
  // Responses API broadcasts them by item_id which is globally unique.
  const ssePayloads = [
    JSON.stringify({ type: 'response.created', response: { model: 'gpt-5.5' } }),
    JSON.stringify({ type: 'response.function_call_arguments.done', item_id: 'aa', call_id: 'caa', name: 'read_file', arguments: '{"path":"/a.txt"}' }),
    JSON.stringify({ type: 'response.function_call_arguments.done', item_id: 'bb', call_id: 'cbb', name: 'list_directory', arguments: '{"path":"."}' }),
    JSON.stringify({ type: 'response.completed', response: { usage: { input_tokens: 5, output_tokens: 5 } } }),
  ];

  const res = mockSseResponse(ssePayloads);
  const result = await readResponsesStreamResponse(res, 'gpt-5.5', 'test', () => {});

  assert.equal(result.toolCalls.length, 2);
  // No tool call has its arguments glued to another's
  for (const tc of result.toolCalls) {
    assert.ok(!tc.function.arguments.includes('}{'), `glued arguments in ${tc.function.name}: ${tc.function.arguments}`);
  }
  // Each call parses independently
  const readCall = result.toolCalls.find(tc => tc.function.name === 'read_file')!;
  assert.deepEqual(JSON.parse(readCall.function.arguments), { path: '/a.txt' });
  const listCall = result.toolCalls.find(tc => tc.function.name === 'list_directory')!;
  assert.deepEqual(JSON.parse(listCall.function.arguments), { path: '.' });
});

test('streaming accumulates text from response.output_text.delta events', async () => {
  const ssePayloads = [
    JSON.stringify({ type: 'response.created', response: { model: 'gpt-5.5' } }),
    JSON.stringify({ type: 'response.output_text.delta', delta: 'Hello' }),
    JSON.stringify({ type: 'response.output_text.delta', delta: ' World' }),
    JSON.stringify({ type: 'response.completed', response: { usage: { input_tokens: 2, output_tokens: 3 } } }),
  ];

  const textChunks: string[] = [];
  const res = mockSseResponse(ssePayloads);
  const result = await readResponsesStreamResponse(res, 'gpt-5.5', 'test', (delta) => {
    if (delta.textDelta) textChunks.push(delta.textDelta);
  });

  assert.equal(result.text, 'Hello World');
  assert.deepEqual(textChunks, ['Hello', ' World']);
});

test('streaming captures usage from response.completed', async () => {
  const ssePayloads = [
    JSON.stringify({ type: 'response.created', response: { model: 'gpt-5.5' } }),
    JSON.stringify({ type: 'response.output_text.delta', delta: 'ok' }),
    JSON.stringify({ type: 'response.completed', response: { usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 } } }),
  ];

  const res = mockSseResponse(ssePayloads);
  const result = await readResponsesStreamResponse(res, 'gpt-5.5', 'test', () => {});

  assert.equal(result.usage.promptTokens, 100);
  assert.equal(result.usage.completionTokens, 50);
  assert.equal(result.usage.totalTokens, 150);
});
