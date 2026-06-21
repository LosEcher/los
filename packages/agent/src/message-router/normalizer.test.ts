/**
 * Tests for message-router normalizer — 7 NormalizerInput formats → InboundMessage
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeInboundMessage } from './normalizer.js';
import type { NormalizerInput } from './types.js';

describe('normalizer', () => {
  it('normalizes http-chat input', () => {
    const input: NormalizerInput = {
      sourceKind: 'http-chat',
      prompt: 'hello world',
      sessionId: 'session-abc123',
    };
    const result = normalizeInboundMessage(input);
    assert.equal(result.sourceKind, 'http-chat');
    assert.equal(result.rawText, 'hello world');
    assert.equal(result.metadata.sessionId, 'session-abc123');
    assert.ok(result.metadata.timestamp);
  });

  it('normalizes http-chat with empty prompt', () => {
    const input: NormalizerInput = {
      sourceKind: 'http-chat',
      prompt: '',
    };
    const result = normalizeInboundMessage(input);
    assert.equal(result.rawText, '');
  });

  it('normalizes http-openai-compat from user messages', () => {
    const input: NormalizerInput = {
      sourceKind: 'http-openai-compat',
      messages: [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: 'What is los?' },
      ],
    };
    const result = normalizeInboundMessage(input);
    assert.equal(result.sourceKind, 'http-openai-compat');
    assert.equal(result.rawText, 'What is los?');
  });

  it('normalizes http-runtime for claude-code', () => {
    const input: NormalizerInput = {
      sourceKind: 'http-runtime',
      prompt: '#claude analyze this file',
      kind: 'claude-code',
      sessionId: 'ext-123',
    };
    const result = normalizeInboundMessage(input);
    assert.equal(result.sourceKind, 'http-runtime');
    assert.equal(result.rawText, '#claude analyze this file');
    assert.equal(result.metadata.sessionId, 'ext-123');
  });

  it('normalizes wx-weixin from WxPusher callback', () => {
    const input: NormalizerInput = {
      sourceKind: 'wx-weixin',
      text: '#status abc12345-def',
      uid: 'UID_abc',
    };
    const result = normalizeInboundMessage(input);
    assert.equal(result.sourceKind, 'wx-weixin');
    assert.equal(result.rawText, '#status abc12345-def');
    assert.equal(result.channelKind, 'weixin');
    assert.equal(result.metadata.userId, 'UID_abc');
  });

  it('normalizes wx-web mobile action', () => {
    const input: NormalizerInput = {
      sourceKind: 'wx-web',
      action: 'approve',
      sessionId: 'session-xyz',
      callId: 'call-1',
    };
    const result = normalizeInboundMessage(input);
    assert.equal(result.sourceKind, 'wx-web');
    assert.equal(result.channelKind, 'web');
    assert.ok(result.rawText.includes('approve'));
    assert.equal(result.metadata.sessionId, 'session-xyz');
  });

  it('normalizes wx-weclaw from WeChat via OpenAI compat', () => {
    const input: NormalizerInput = {
      sourceKind: 'wx-weclaw',
      messages: [{ role: 'user', content: '#task' }],
    };
    const result = normalizeInboundMessage(input);
    assert.equal(result.sourceKind, 'wx-weclaw');
    assert.equal(result.rawText, '#task');
  });

  it('normalizes telegram callback data', () => {
    const input: NormalizerInput = {
      sourceKind: 'telegram',
      data: 'approve:session-xyz:call-1',
      chatId: 123456,
    };
    const result = normalizeInboundMessage(input);
    assert.equal(result.sourceKind, 'telegram');
    assert.equal(result.channelKind, 'telegram');
    assert.equal(result.rawText, 'approve:session-xyz:call-1');
  });

  it('handles Unicode text', () => {
    const input: NormalizerInput = {
      sourceKind: 'http-chat',
      prompt: '你好世界 #claude 分析',
    };
    const result = normalizeInboundMessage(input);
    assert.equal(result.rawText, '你好世界 #claude 分析');
  });

  it('preserves extra metadata on http-chat', () => {
    const input: NormalizerInput = {
      sourceKind: 'http-chat',
      prompt: 'test',
      extra: { userId: 'u1', projectId: 'p1' },
    };
    const result = normalizeInboundMessage(input);
    assert.equal((result.rawPayload as any).extra.userId, 'u1');
  });
});
