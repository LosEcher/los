import test from 'node:test';
import assert from 'node:assert/strict';

import { buildOpenAICompatUrl, createOpenAICompatProvider } from './providers/index.js';
import { createDeepSeekProvider, createProvider } from './providers/registry.js';
import { repairJson, repairToolCallArguments } from './providers/openai-utils.js';
import { validateProviderModelRequest } from './provider-request-validation.js';
import { mergeToolCallDeltas, mergeSplitToolCalls } from './providers/delta-repair.js';
import type { ToolCall } from './providers/types.js';
import { resolveModelProfile } from './model-profiles.js';
import { _xaiOAuthStore } from './auth/xai-oauth-store.js';
import { ConfigSchema, getConfig, setConfig } from '@los/infra/config';

test('OpenAI-compatible URLs normalize missing v1 segments', () => {
  assert.equal(
    buildOpenAICompatUrl('https://api.deepseek.com', '/chat/completions'),
    'https://api.deepseek.com/v1/chat/completions',
  );
  assert.equal(
    buildOpenAICompatUrl('https://api.deepseek.com/', '/models'),
    'https://api.deepseek.com/v1/models',
  );
});

test('OpenAI-compatible URLs do not duplicate existing v1 segments', () => {
  assert.equal(
    buildOpenAICompatUrl('https://www.packyapi.com/v1', '/chat/completions'),
    'https://www.packyapi.com/v1/chat/completions',
  );
  assert.equal(
    buildOpenAICompatUrl('http://127.0.0.1:11434/v1/', 'models'),
    'http://127.0.0.1:11434/v1/models',
  );
});

test('provider/model validation rejects historical routing aliases', () => {
  const configuredProviders = {
    deepseek: { enabled: true, model: 'deepseek-v4-flash', baseUrl: 'https://api.deepseek.com/v1' },
    xai: { enabled: true, model: 'grok-4.3', baseUrl: 'https://api.x.ai/v1' },
  };
  const unknownProvider = validateProviderModelRequest({
    provider: 'deepseek-v4-flash', model: undefined,
    defaultProvider: 'deepseek', configuredProviders,
  });
  assert.equal(unknownProvider.valid, false);
  if (!unknownProvider.valid) assert.equal(unknownProvider.code, 'provider_not_configured');

  const missingProvider = validateProviderModelRequest({
    provider: undefined, model: 'grok-4.3',
    defaultProvider: 'deepseek', configuredProviders,
  });
  assert.equal(missingProvider.valid, false);
  if (!missingProvider.valid) assert.equal(missingProvider.code, 'provider_required_for_model');

  assert.equal(validateProviderModelRequest({
    provider: 'xai', model: 'grok-composer-2.5-fast',
    defaultProvider: 'deepseek', configuredProviders,
  }).valid, true);

  const unknownModel = validateProviderModelRequest({
    provider: 'xai', model: 'missing-model',
    defaultProvider: 'deepseek', configuredProviders,
  });
  assert.equal(unknownModel.valid, false);
  if (!unknownModel.valid) assert.equal(unknownModel.code, 'model_not_configured');
});

test('malformed tool argument fixture is repaired without changing its value', () => {
  const malformed = '{path: ".", trailing: true,}';
  const repaired = repairJson(malformed);
  assert.deepEqual(repaired.steps, ['trailing-commas', 'unquoted-keys']);
  assert.deepEqual(JSON.parse(repaired.result!), { path: '.', trailing: true });

  const toolCall = repairToolCallArguments({
    id: 'fixture-malformed-arguments',
    type: 'function',
    function: { name: 'read_file', arguments: malformed },
  }, 'fixture');
  assert.deepEqual(JSON.parse(toolCall.function.arguments), { path: '.', trailing: true });
  assert.equal(toolCall._repair?.repaired, true);
});

test('OpenAI-compatible transport resolves an OAuth credential before each request', async (t) => {
  let credentialCalls = 0;
  let fetchCalls = 0;
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    fetchCalls += 1;
    assert.equal(String(input), 'https://resolved.x.ai/v1/chat/completions');
    assert.equal(new Headers(init?.headers).get('Authorization'), `Bearer fixture-token-${fetchCalls}`);
    return new Response(JSON.stringify({
      choices: [{ message: { content: 'ok', tool_calls: [] }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      model: 'grok-4.3',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });

  const provider = createOpenAICompatProvider({
    name: 'xai',
    profile: resolveModelProfile('xai', {
      baseUrl: 'https://configured.invalid/v1',
      model: 'grok-4.3',
    }),
    credentialResolver: async () => {
      credentialCalls += 1;
      return { apiKey: `fixture-token-${credentialCalls}`, baseUrl: 'https://resolved.x.ai/v1' };
    },
  });

  await provider.chat([{ role: 'user', content: 'first' }]);
  await provider.chat([{ role: 'user', content: 'second' }]);
  assert.equal(credentialCalls, 2);
  assert.equal(fetchCalls, 2);
});

test('provider registry wires xAI OAuth into the production request path', async (t) => {
  const previousConfig = getConfig();
  t.after(() => setConfig(previousConfig));
  setConfig(ConfigSchema.parse({
    server: {}, agent: {}, memory: {}, executor: {}, auth: {},
    providers: {
      xai: {
        baseUrl: 'https://configured.invalid/v1',
        model: 'grok-4.3',
        authMode: 'oauth',
        enabled: true,
      },
    },
  }));

  let credentialLoads = 0;
  t.mock.method(_xaiOAuthStore, 'loadWithSource', () => {
    credentialLoads += 1;
    return {
      source: 'los-auth-store' as const,
      state: {
        tokens: {
          access_token: jwtIn(7200),
          refresh_token: 'fixture-refresh-token',
          id_token: 'fixture-id-token',
          token_type: 'Bearer',
        },
        discovery: {
          authorization_endpoint: 'https://auth.x.ai/authorize',
          token_endpoint: 'https://auth.x.ai/token',
        },
        redirect_uri: 'http://127.0.0.1:56121/callback',
        auth_mode: 'oauth_pkce' as const,
      },
    };
  });
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(input), 'https://api.x.ai/v1/chat/completions');
    assert.match(new Headers(init?.headers).get('Authorization') ?? '', /^Bearer fixture\./);
    return new Response(JSON.stringify({
      choices: [{ message: { content: 'ok', tool_calls: [] }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      model: 'grok-4.3',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });

  await createProvider('xai').chat([{ role: 'user', content: 'fixture request' }]);
  assert.equal(credentialLoads, 1);
});

test('provider registry rejects OAuth providers without a dedicated resolver', (t) => {
  const previousConfig = getConfig();
  t.after(() => setConfig(previousConfig));
  setConfig(ConfigSchema.parse({
    server: {}, agent: {}, memory: {}, executor: {}, auth: {},
    providers: {
      fixture: {
        baseUrl: 'https://provider.example/v1',
        model: 'fixture-model',
        authMode: 'oauth',
        enabled: true,
      },
      deepseek: {
        baseUrl: 'https://api.deepseek.com/v1',
        model: 'deepseek-chat',
        authMode: 'oauth',
        enabled: true,
      },
    },
  }));

  assert.throws(
    () => createProvider('fixture'),
    /Provider 'fixture' has no supported OAuth credential resolver/,
  );
  assert.throws(
    () => createDeepSeekProvider(),
    /Provider 'deepseek' has no supported OAuth credential resolver/,
  );
});

// ── mergeToolCallDeltas — Chat Completions streaming delta aggregation ──

test('mergeToolCallDeltas aggregates standard OpenAI deltas with index', () => {
  const map = new Map<number, ToolCall>();

  // First delta — new tool call at index 0
  mergeToolCallDeltas(map, [
    { index: 0, id: 'call_abc', function: { name: 'read_file', arguments: '{"path":' } },
  ]);
  assert.equal(map.size, 1);
  assert.equal(map.get(0)!.id, 'call_abc');
  assert.equal(map.get(0)!.function.name, 'read_file');

  // Second delta — continuation at index 0
  mergeToolCallDeltas(map, [
    { index: 0, function: { arguments: '"/etc/hosts"}' } },
  ]);
  assert.equal(map.size, 1);
  assert.equal(map.get(0)!.function.arguments, '{"path":"/etc/hosts"}');
  assert.deepEqual(JSON.parse(map.get(0)!.function.arguments), { path: '/etc/hosts' });
});

test('mergeToolCallDeltas handles PackyCode-style deltas without index', () => {
  const map = new Map<number, ToolCall>();

  // First delta includes index
  mergeToolCallDeltas(map, [
    { index: 0, id: 'call_V6MjbGRirkhIfWB4xkYszko7', function: { name: 'directory_tree', arguments: '' } },
  ]);
  assert.equal(map.size, 1);
  assert.equal(map.get(0)!.function.name, 'directory_tree');

  // Second delta: NO index, NO id — PackyCode-style follow-up delta
  mergeToolCallDeltas(map, [
    { function: { arguments: '{"maxDepth":2,"path":"."}' } },
  ]);
  assert.equal(map.size, 1, 'should not create a phantom tool call');
  assert.equal(map.get(0)!.function.arguments, '{"maxDepth":2,"path":"."}');
  assert.deepEqual(JSON.parse(map.get(0)!.function.arguments), { maxDepth: 2, path: '.' });
});

test('mergeToolCallDeltas matches continuation delta by id when index is missing', () => {
  const map = new Map<number, ToolCall>();

  // Two parallel tool calls
  mergeToolCallDeltas(map, [
    { index: 0, id: 'call_A', function: { name: 'tool_a', arguments: '{"x":' } },
    { index: 1, id: 'call_B', function: { name: 'tool_b', arguments: '{"y":' } },
  ]);
  assert.equal(map.size, 2);

  // Continuation for call_B by id (no index)
  mergeToolCallDeltas(map, [
    { id: 'call_B', function: { arguments: '1}' } },
  ]);
  assert.equal(map.size, 2, 'should not create a third entry');
  assert.equal(map.get(1)!.function.arguments, '{"y":1}');

  // Continuation for call_A by id (no index)
  mergeToolCallDeltas(map, [
    { id: 'call_A', function: { arguments: '1}' } },
  ]);
  assert.equal(map.get(0)!.function.arguments, '{"x":1}');
});

test('mergeToolCallDeltas handles PackyCode index-switch (name at 0, args at 1)', () => {
  // PackyCode sends the name+id delta at index=0, then all argument
  // fragments at index=1 (without id). The result must be a single tool call.
  const map = new Map<number, ToolCall>();

  mergeToolCallDeltas(map, [
    { index: 0, id: 'call_ABC', function: { name: 'directory_tree', arguments: '' } },
  ]);
  assert.equal(map.size, 1);

  // Arguments arrive at index=1 — PackyCode quirk
  mergeToolCallDeltas(map, [
    { index: 1, function: { arguments: '{"' } },
  ]);
  assert.equal(map.size, 1, 'should not create phantom at index 1');
  assert.equal(map.get(0)!.function.arguments, '{"');

  mergeToolCallDeltas(map, [
    { index: 1, function: { arguments: 'maxDepth":' } },
  ]);
  mergeToolCallDeltas(map, [
    { index: 1, function: { arguments: '2,"path":"."}' } },
  ]);

  assert.equal(map.size, 1, 'all fragments merged into one call');
  assert.equal(map.get(0)!.function.arguments, '{"maxDepth":2,"path":"."}');
  assert.deepEqual(JSON.parse(map.get(0)!.function.arguments), { maxDepth: 2, path: '.' });
});

test('mergeToolCallDeltas parallel tool calls with mixed index presence', () => {
  const map = new Map<number, ToolCall>();

  // call_A: index present throughout (standard behavior)
  mergeToolCallDeltas(map, [
    { index: 0, id: 'call_read', function: { name: 'read_file', arguments: '{"path":"/a"}' } },
  ]);

  // call_B: first delta has index, follow-ups don't (PackyCode behavior)
  mergeToolCallDeltas(map, [
    { index: 1, id: 'call_list', function: { name: 'list_directory', arguments: '{"path":' } },
  ]);
  mergeToolCallDeltas(map, [
    { function: { arguments: '"."}' } },  // no index, no id → last entry
  ]);

  assert.equal(map.size, 2);
  assert.equal(map.get(0)!.function.name, 'read_file');
  assert.equal(map.get(0)!.function.arguments, '{"path":"/a"}');
  assert.equal(map.get(1)!.function.name, 'list_directory');
  // The no-index/no-id delta should go to the last tool call (call_list at index 1),
  // NOT create a new phantom call_2 entry
  assert.ok(!map.has(2), 'should not create phantom tool call at index 2');
  assert.deepEqual(JSON.parse(map.get(1)!.function.arguments), { path: '.' });
});

// ── L2: Content-based orphan args detection ──────────────────

test('mergeToolCallDeltas routes orphan args with unknown id to name-only entry (L2)', () => {
  // PackyCode sends the name delta with one call id, then the arguments
  // delta with a completely different call id (e.g. "call_1").
  const map = new Map<number, ToolCall>();

  // First tool call: normal (name + args together)
  mergeToolCallDeltas(map, [
    { index: 0, id: 'call_b7WIUj', function: { name: 'glob', arguments: '{"pattern":"**/*"}' } },
  ]);

  // Second tool call: name delta arrives with proper id
  mergeToolCallDeltas(map, [
    { index: 1, id: 'call_GKdGrEo', function: { name: 'directory_tree', arguments: '' } },
  ]);

  // Third: orphan args delta — PackyCode assigns a DIFFERENT id ("call_1")
  // and omits the index entirely. L2 should find the name-only entry (index 1)
  // and merge into it, NOT create a phantom call_1.
  mergeToolCallDeltas(map, [
    { id: 'call_1', function: { arguments: '{"maxDepth":2,"path":"."}' } },
  ]);

  assert.equal(map.size, 2, 'should not create phantom call_1 entry');
  assert.equal(map.get(0)!.function.name, 'glob');
  assert.equal(map.get(1)!.function.name, 'directory_tree');
  // The id should be preserved from the name delta, not overwritten by call_1
  assert.equal(map.get(1)!.id, 'call_GKdGrEo');
  assert.equal(map.get(1)!.function.arguments, '{"maxDepth":2,"path":"."}');
  assert.deepEqual(JSON.parse(map.get(1)!.function.arguments), { maxDepth: 2, path: '.' });
});

test('mergeToolCallDeltas routes orphan args with unknown index to name-only entry (L2)', () => {
  // Variant where the orphan args delta HAS an index, but it points to a
  // non-existent entry (e.g. PackyCode uses index=2 when only 0 and 1 exist).
  const map = new Map<number, ToolCall>();

  mergeToolCallDeltas(map, [
    { index: 0, id: 'call_A', function: { name: 'tool_a', arguments: '{}' } },
    { index: 1, id: 'call_B', function: { name: 'tool_b', arguments: '' } },
  ]);

  // Orphan args at index=2 (non-existent) with a different id
  mergeToolCallDeltas(map, [
    { index: 2, id: 'call_X', function: { arguments: '{"key":"val"}' } },
  ]);

  assert.equal(map.size, 2, 'should not create phantom at index 2');
  assert.equal(map.get(1)!.function.arguments, '{"key":"val"}');
  // Id should be preserved from the name delta
  assert.equal(map.get(1)!.id, 'call_B');
});

// ── mergeSplitToolCalls — post-processing split repair (方案 B) ──

test('mergeSplitToolCalls merges adjacent name-only + args-only pairs', () => {
  // Simulates the output after mergeToolCallDeltas where PackyCode's
  // id-mismatch quirk created two adjacent entries:
  //   [0]: glob (complete)
  //   [1]: directory_tree (name only, args="")
  //   [2]: call_1 (args only, name="")
  const toolCalls: ToolCall[] = [
    { id: 'call_b7WIUj', type: 'function', function: { name: 'glob', arguments: '{"pattern":"**/*"}' } },
    { id: 'call_GKdGrEo', type: 'function', function: { name: 'directory_tree', arguments: '' } },
    { id: 'call_1', type: 'function', function: { name: '', arguments: '{"maxDepth":2,"path":"."}' } },
  ];

  const merged = mergeSplitToolCalls(toolCalls, 'test');

  assert.equal(merged.length, 2, 'should merge split pair into 2 total calls');
  assert.equal(merged[0].function.name, 'glob');
  assert.equal(merged[1].function.name, 'directory_tree');
  assert.equal(merged[1].function.arguments, '{"maxDepth":2,"path":"."}');
  assert.equal(merged[1]._repair?.repaired, true);
  assert.ok(merged[1]._repair?.repairSteps?.includes('split-tool-call-merge'));
  // Verify args parse correctly
  assert.deepEqual(JSON.parse(merged[1].function.arguments), { maxDepth: 2, path: '.' });
});

test('mergeSplitToolCalls handles unmatched name-only entry', () => {
  const toolCalls: ToolCall[] = [
    { id: 'call_A', type: 'function', function: { name: 'some_tool', arguments: '' } },
  ];

  const merged = mergeSplitToolCalls(toolCalls, 'test');

  assert.equal(merged.length, 1);
  assert.equal(merged[0].function.name, 'some_tool');
  assert.equal(merged[0].function.arguments, ''); // kept, loop will handle gracefully
  assert.equal(merged[0]._repair, undefined);
});

test('mergeSplitToolCalls drops fully phantom entries (no name, no args)', () => {
  const toolCalls: ToolCall[] = [
    { id: 'call_good', type: 'function', function: { name: 'good_tool', arguments: '{}' } },
    { id: 'call_phantom', type: 'function', function: { name: '', arguments: '' } },
  ];

  const merged = mergeSplitToolCalls(toolCalls, 'test');

  assert.equal(merged.length, 1);
  assert.equal(merged[0].function.name, 'good_tool');
});

test('mergeSplitToolCalls pairs by proximity with multiple splits', () => {
  // Two split pairs interleaved
  const toolCalls: ToolCall[] = [
    { id: 'c0', type: 'function', function: { name: 'tool_a', arguments: '' } },
    { id: 'c1', type: 'function', function: { name: '', arguments: '{"a":1}' } },
    { id: 'c2', type: 'function', function: { name: 'tool_b', arguments: '' } },
    { id: 'c3', type: 'function', function: { name: '', arguments: '{"b":2}' } },
  ];

  const merged = mergeSplitToolCalls(toolCalls, 'test');

  assert.equal(merged.length, 2);
  assert.equal(merged[0].function.name, 'tool_a');
  assert.equal(merged[0].function.arguments, '{"a":1}');
  assert.equal(merged[1].function.name, 'tool_b');
  assert.equal(merged[1].function.arguments, '{"b":2}');
});

test('mergeSplitToolCalls emits synthetic name for unmatched orphan args', () => {
  // When an orphan args entry can't be paired with a name-only entry,
  // it must be assigned a synthetic name rather than silently dropped.
  const toolCalls: ToolCall[] = [
    { id: 'call_good', type: 'function', function: { name: 'good_tool', arguments: '{}' } },
    { id: 'call_orphan', type: 'function', function: { name: '', arguments: '{"key":"val"}' } },
  ];

  const merged = mergeSplitToolCalls(toolCalls, 'test');

  assert.equal(merged.length, 2, 'both entries should be kept');
  assert.equal(merged[0].function.name, 'good_tool');
  // The orphan must get a synthetic name
  assert.ok(merged[1].function.name.startsWith('_orphan_args_'));
  assert.equal(merged[1].function.arguments, '{"key":"val"}');
  assert.equal(merged[1]._repair?.repaired, true);
  assert.ok(merged[1]._repair?.repairSteps?.includes('orphan-args-synthetic'));
  // Verify the orphan's original id is preserved
  assert.equal(merged[1].id, 'call_orphan');
});

function jwtIn(seconds: number): string {
  const payload = Buffer.from(JSON.stringify({
    exp: Math.floor(Date.now() / 1000) + seconds,
  })).toString('base64url');
  return `fixture.${payload}.signature`;
}
