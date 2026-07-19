import assert from 'node:assert/strict';
import test from 'node:test';

import { AgentError } from '../error-base.js';
import { _applyProviderFallbackToSetup, type AgentRunSetup } from '../loop/setup.js';
import {
  _classifyProviderFallbackFailure,
  createProviderFallbackRouter,
  prepareProviderFallbackPolicy,
  type ProviderFallbackEvent,
} from './provider-fallback.js';
import type { Provider, ProviderResponse } from './types.js';

test('provider fallback requires exact passing evidence by default', () => {
  assert.throws(() => prepareProviderFallbackPolicy({
    mode: 'explicit_ordered',
    targets: [
      { provider: 'a', model: 'a-1' },
      { provider: 'b', model: 'b-1' },
    ],
  }, [{ id: 'e-a', provider: 'a', model: 'a-1', passed: true }]), /b:b-1 requires passing/);
});

test('provider fallback switches in declared order for rate limits and records evidence', async () => {
  const events: ProviderFallbackEvent[] = [];
  const prepared = prepareProviderFallbackPolicy({
    mode: 'explicit_ordered',
    targets: [
      { provider: 'a', model: 'a-1' },
      { provider: 'b', model: 'b-1' },
    ],
    onFailure: ['rate_limit'],
  }, [
    { id: 'e-a', provider: 'a', model: 'a-1', passed: true },
    { id: 'e-b', provider: 'b', model: 'b-1', passed: true },
  ])!;
  const first = fakeProvider('a', 'a-1', async () => {
    throw AgentError.fromProviderResponse('PROVIDER_HTTP_ERROR', 'a', 'a-1', 429, 'rate limited');
  });
  const second = fakeProvider('b', 'b-1', async () => response('b-1'));
  const router = createProviderFallbackRouter({
    prepared,
    initialProvider: first,
    createProvider: () => second,
    onEvent: event => { events.push(event); },
  });

  const result = await router.chat([]);
  assert.equal(result.model, 'b-1');
  assert.equal(router.name, 'b');
  assert.equal(events[0]?.type, 'selected');
  assert.equal(events[0]?.compatibilityEvidenceId, 'e-b');
  assert.equal(events[0]?.failureClass, 'rate_limit');
});

test('agent setup emits the contracted fallback event and exposes the selected provider', async () => {
  const writes: Array<{ type: string; payload?: Record<string, unknown> }> = [];
  const setup = {
    provider: fakeProvider('a', 'a-1', async () => {
      throw AgentError.fromProviderResponse('PROVIDER_HTTP_ERROR', 'a', 'a-1', 429, 'rate limited');
    }),
    emitEvent: async (event: { type: string; payload?: Record<string, unknown> }) => {
      writes.push(event);
      return null;
    },
  } as AgentRunSetup;
  await _applyProviderFallbackToSetup({
    provider: 'a',
    model: 'a-1',
    providerFallback: {
      mode: 'explicit_ordered',
      targets: [{ provider: 'a', model: 'a-1' }, { provider: 'b', model: 'b-1' }],
      onFailure: ['rate_limit'],
      requireCompatibilityEvidence: true,
      maxSwitches: 1,
    },
  }, setup, {
    loadEvidence: async () => [
      { id: 'e-a', provider: 'a', model: 'a-1', passed: true },
      { id: 'e-b', provider: 'b', model: 'b-1', passed: true },
    ] as any,
    createProvider: () => fakeProvider('b', 'b-1', async () => response('b-1')),
  });

  const result = await setup.provider.chat([]);

  assert.equal(result.model, 'b-1');
  assert.equal(setup.provider.name, 'b');
  assert.equal(writes[0]?.type, 'provider.fallback.selected');
  assert.deepEqual(writes[0]?.payload, {
    policyMode: 'explicit_ordered',
    callIndex: 1,
    switchIndex: 1,
    failureClass: 'rate_limit',
    errorCode: 'PROVIDER_HTTP_ERROR',
    errorMessage: 'a API error 429: rate limited',
    fromProvider: 'a',
    fromModel: 'a-1',
    toProvider: 'b',
    toModel: 'b-1',
    compatibilityEvidenceId: 'e-b',
  });
});

test('provider fallback never switches on credential errors', async () => {
  const prepared = prepareProviderFallbackPolicy({
    mode: 'explicit_ordered',
    targets: [{ provider: 'a', model: 'a-1' }, { provider: 'b', model: 'b-1' }],
    requireCompatibilityEvidence: false,
  }, [])!;
  let secondCalls = 0;
  const router = createProviderFallbackRouter({
    prepared,
    initialProvider: fakeProvider('a', 'a-1', async () => {
      throw AgentError.fromProviderResponse('PROVIDER_HTTP_ERROR', 'a', 'a-1', 401, 'unauthorized');
    }),
    createProvider: () => fakeProvider('b', 'b-1', async () => {
      secondCalls++;
      return response('b-1');
    }),
    onEvent: () => {},
  });

  await assert.rejects(() => router.chat([]), /401/);
  assert.equal(secondCalls, 0);
});

test('provider fallback emits exhausted after the last eligible target fails', async () => {
  const events: ProviderFallbackEvent[] = [];
  const prepared = prepareProviderFallbackPolicy({
    mode: 'explicit_ordered',
    targets: [{ provider: 'a', model: 'a-1' }, { provider: 'b', model: 'b-1' }],
    requireCompatibilityEvidence: false,
  }, [])!;
  const unavailable = (name: string, model: string) => fakeProvider(name, model, async () => {
    throw AgentError.fromProviderResponse('PROVIDER_HTTP_ERROR', name, model, 503, 'unavailable');
  });
  const router = createProviderFallbackRouter({
    prepared,
    initialProvider: unavailable('a', 'a-1'),
    createProvider: () => unavailable('b', 'b-1'),
    onEvent: event => { events.push(event); },
  });

  await assert.rejects(() => router.chat([]), /503/);
  assert.deepEqual(events.map(event => event.type), ['selected', 'exhausted']);
});

test('provider fallback failure classification excludes parse and auth failures', () => {
  assert.equal(_classifyProviderFallbackFailure(new TypeError('fetch failed')), 'transport');
  assert.equal(_classifyProviderFallbackFailure(new AgentError('PROVIDER_PARSE', 'bad response')), undefined);
  assert.equal(_classifyProviderFallbackFailure(
    AgentError.fromProviderResponse('PROVIDER_HTTP_ERROR', 'a', 'a-1', 403, 'forbidden'),
  ), undefined);
});

function fakeProvider(
  name: string,
  model: string,
  chat: Provider['chat'],
): Provider {
  return {
    name,
    profile: { provider: name, model } as Provider['profile'],
    chat,
  };
}

function response(model: string): ProviderResponse {
  return {
    text: 'ok',
    toolCalls: [],
    usage: { promptTokens: 1, completionTokens: 1 },
    model,
  };
}
