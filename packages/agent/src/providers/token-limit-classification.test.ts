/**
 * @los/agent token-limit error classification 单元测试：
 * 锁住跨 provider 错误指纹（input/output token limit）与 fallback 分类器接线。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyTokenLimitErrorFromMessage,
} from './token-limit-classification.js';
import { _classifyProviderFallbackFailure } from './provider-fallback.js';
import { AgentError } from '../error-base.js';

test('input token limit 指纹：各 provider 措辞归一化', () => {
  const inputPhrases = [
    'context_length_exceeded: you can get help by reducing the length of your prompt',
    'This model\'s maximum context length is 131072 tokens. However, you requested 200000 tokens',
    'input tokens exceed the configured limit',
    'The prompt is too long. Please shorten it',
    'request size cannot exceed 200000 bytes. Please shorten the request',
    'input token count (40000) exceeds the maximum number of tokens allowed (32768)',
    'your messages resulted in 50000 tokens, exceeding the configured limit of 32768 tokens',
    'input is too long for requested model',
    'request size exceeds model context window',
    'payload too large',
  ];
  for (const phrase of inputPhrases) {
    assert.equal(classifyTokenLimitErrorFromMessage(phrase), 'input_token_limit', phrase.slice(0, 60));
  }
});

test('output token limit 指纹', () => {
  assert.equal(classifyTokenLimitErrorFromMessage('exceeded max output tokens of 8192'), 'output_token_limit');
  assert.equal(classifyTokenLimitErrorFromMessage('exceeded max output tokens'), 'output_token_limit');
});

test('非超限消息不误分类', () => {
  for (const phrase of ['connection reset by peer', 'Invalid API key', 'rate limit exceeded', 'The server had an error']) {
    assert.equal(classifyTokenLimitErrorFromMessage(phrase), undefined, phrase);
  }
});

test('fallback 分类器接线：AgentError 带 token 超限消息 → token_limit', () => {
  const error = new AgentError(
    'PROVIDER_REQUEST',
    'input token count (40000) exceeds the maximum number of tokens allowed (32768)',
    { httpStatus: 400 },
  );
  assert.equal(_classifyProviderFallbackFailure(error), 'token_limit');
});

test('fallback 分类器接线：非超限 400 保持 undefined（不 fallback 也不误分类）', () => {
  const error = new AgentError('PROVIDER_REQUEST', 'invalid request body', { httpStatus: 400 });
  assert.equal(_classifyProviderFallbackFailure(error), undefined);
});
