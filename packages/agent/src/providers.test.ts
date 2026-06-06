import test from 'node:test';
import assert from 'node:assert/strict';

import { buildOpenAICompatUrl } from './providers/index.js';

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
