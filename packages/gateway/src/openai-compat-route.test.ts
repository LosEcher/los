import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('./openai-compat-route.ts', import.meta.url), 'utf8');

test('OpenAI-compatible route never logs raw request headers', () => {
  assert.doesNotMatch(source, /JSON\.stringify\(req\.headers\)/);
  assert.doesNotMatch(source, /console\.(?:log|info|debug|warn|error)/);
});
