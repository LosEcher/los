/**
 * Tests for MessageRouter — registration, routing, channel dispatch
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MessageRouter } from './router.js';
import { createNoopChannelContext } from './channel-adapter.js';
import type {
  HandlerDescriptor,
  HandlerContext,
  ChannelContext,
  NormalizerInput,
} from './types.js';

function stubSteeringHandler(): HandlerDescriptor {
  return {
    name: 'test-steering',
    priority: 30,
    match: (intent) => intent.type === 'steering',
    handle: async (ctx) => {
      await ctx.reply(`ok: ${ctx.intent.type}`);
      return { handled: true, text: 'steered', sessionId: 'test-sid' };
    },
  };
}

function stubChatHandler(): HandlerDescriptor {
  return {
    name: 'test-chat',
    priority: 100,
    match: (intent) => intent.type === 'chat' || intent.type === 'unknown',
    handle: async (ctx) => {
      await ctx.reply(`chat: ${ctx.inbound.rawText}`);
      return { handled: true, text: 'chatted' };
    },
  };
}

describe('MessageRouter', () => {
  it('routes http-chat #approve command through steering handler', async () => {
    const router = new MessageRouter({
      handlers: [stubSteeringHandler(), stubChatHandler()],
    });
    const input: NormalizerInput = {
      sourceKind: 'http-chat',
      prompt: '#approve session-abc12345',
    };
    const result = await router.route(input);
    assert.equal(result.handled, true);
    assert.equal(result.text, 'steered');
    assert.equal(result.intent.type, 'steering');
  });

  it('routes plain text through chat handler', async () => {
    const router = new MessageRouter({
      handlers: [stubSteeringHandler(), stubChatHandler()],
    });
    const result = await router.route({ sourceKind: 'http-chat', prompt: 'hello' });
    assert.equal(result.handled, true);
    assert.equal(result.text, 'chatted');
    assert.equal(result.intent.type, 'chat');
  });

  it('returns handled:false when no handler matches', async () => {
    const router = new MessageRouter({
      handlers: [
        {
          name: 'only-steering',
          priority: 10,
          match: (i) => i.type === 'steering',
          handle: async () => ({ handled: true }),
        },
      ],
    });
    const result = await router.route({ sourceKind: 'http-chat', prompt: 'hello' });
    assert.equal(result.handled, false);
    assert.ok(result.error);
  });

  it('sorts handlers by priority (lower = first match)', async () => {
    const calls: string[] = [];
    const router = new MessageRouter({
      handlers: [
        {
          name: 'high', priority: 100,
          match: () => true,
          handle: async () => { calls.push('high'); return { handled: true }; },
        },
        {
          name: 'low', priority: 10,
          match: () => true,
          handle: async () => { calls.push('low'); return { handled: true }; },
        },
      ],
    });
    await router.route({ sourceKind: 'http-chat', prompt: 'test' });
    assert.deepEqual(calls, ['low']); // lower priority runs first
  });

  it('registers custom handler at runtime', async () => {
    const router = new MessageRouter();
    router.register({
      name: 'custom',
      priority: 5,
      match: () => true,
      handle: async () => ({ handled: true, text: 'custom' }),
    });
    const result = await router.route({ sourceKind: 'http-chat', prompt: 'anything' });
    assert.equal(result.handled, true);
    assert.equal(result.text, 'custom');
  });

  it('delivers response through channel', async () => {
    const delivered: string[] = [];
    const ch: ChannelContext = {
      kind: 'direct',
      id: 'test-chan',
      send: async (text) => { delivered.push(text); return { ok: true }; },
    };
    const router = new MessageRouter({
      handlers: [stubChatHandler()],
      channels: [ch],
      defaultChannelId: 'test-chan',
    });
    await router.route({ sourceKind: 'http-chat', prompt: 'test delivery' });
    assert.ok(delivered.length >= 1);
    assert.ok(delivered.some(t => t.includes('chat:')));
  });

  it('resolveIntent returns correct intent without dispatching', () => {
    const router = new MessageRouter();
    const intent = router.resolveIntent('#status session-123');
    assert.equal(intent.type, 'status');
  });

  it('findHandler returns null when no match', () => {
    const router = new MessageRouter({ handlers: [stubSteeringHandler()] });
    const found = router.findHandler({ type: 'chat', prompt: 'x' });
    assert.equal(found, null);
  });

  it('findHandler returns handler when matching', () => {
    const router = new MessageRouter({ handlers: [stubSteeringHandler()] });
    const found = router.findHandler({ type: 'steering', instruction: 'approve', sessionId: 'x' });
    assert.ok(found);
    assert.equal(found?.name, 'test-steering');
  });
});
