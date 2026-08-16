import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_PAYLOAD_DEPTH,
  MAX_PAYLOAD_JSON_BYTES,
  MAX_PAYLOAD_STRING_CHARS,
  REDACTED_LITERAL,
  payloadRedactorCount,
  redactPayload,
  redactText,
  registerPayloadRedactor,
} from './event-redaction.js';

test('redactPayload: secret-key patterns redact at any nesting depth', () => {
  const out = redactPayload({
    ok: true,
    nested: {
      apiKey: 'sk-abc123',
      headers: { authorization: 'Bearer abc' },
      keep: 'visible',
      list: [{ password: 'p@ss' }, { note: 'fine' }],
    },
  }, 'tool.result');
  const nested = out.nested as Record<string, unknown>;
  assert.equal(nested.apiKey, REDACTED_LITERAL);
  assert.equal((nested.headers as Record<string, unknown>).authorization, REDACTED_LITERAL);
  assert.equal(nested.keep, 'visible');
  assert.equal((nested.list as Array<Record<string, unknown>>)[0].password, REDACTED_LITERAL);
  assert.equal((nested.list as Array<Record<string, unknown>>)[1].note, 'fine');
});

test('redactPayload: Bearer / embedded secret / JWT value shapes redacted', () => {
  const out = redactPayload({
    endpoint: 'https://api.example.com/v1/chat?api_key=sk-live-1&model=x',
    message: 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature',
    plain: 'nothing sensitive here',
  }, 'telemetry.provider_call');
  assert.equal(out.endpoint, 'https://api.example.com/v1/chat?api_key=[redacted]&model=x');
  assert.ok(String(out.message).includes('Authorization: [redacted]'));
  assert.ok(!String(out.message).includes('eyJhbGci'));
  assert.ok(!String(out.message).includes('signature'));
  assert.equal(out.plain, 'nothing sensitive here');
});

test('redactText: standalone helper covers the same value shapes', () => {
  assert.equal(redactText('token=deadbeef&rest=1'), 'token=[redacted]&rest=1');
  assert.equal(redactText('x-api-key: abc123'), 'x-api-key: [redacted]');
  assert.equal(redactText('eyJh.eyJh.c2ln'), REDACTED_LITERAL);
});

test('redactPayload: string length cap promoted to all events (runtime.* precedent)', () => {
  const long = 'y'.repeat(MAX_PAYLOAD_STRING_CHARS + 100);
  const out = redactPayload({ text: long, short: 'ok' }, 'tool.result');
  assert.equal(String(out.text).length, MAX_PAYLOAD_STRING_CHARS + '…[truncated]'.length);
  assert.ok(String(out.text).endsWith('…[truncated]'));
  assert.equal(out.short, 'ok');
});

test('redactPayload: nesting depth cap replaces deep nodes', () => {
  // 构建 depth 远超上限的嵌套对象：root → a → b → … → z → 'too deep'
  let node: Record<string, unknown> = { leaf: 'too deep' };
  for (const key of ['z', 'y', 'x', 'w', 'v', 'u', 't', 's', 'r', 'q', 'p', 'o', 'n', 'm', 'l', 'k', 'j', 'i', 'h', 'g', 'f', 'e', 'd', 'c', 'b', 'a']) {
    node = { [key]: node };
  }
  const deep = { root: node };
  const out = redactPayload(deep, 'model.response');

  // root 对象在 depth 1 进入；MAX_PAYLOAD_DEPTH=12 意味着 depth>12 的节点被替换。
  let cursor: unknown = out;
  for (let i = 0; i < MAX_PAYLOAD_DEPTH + 6 && cursor && typeof cursor === 'object'; i++) {
    const keys = Object.keys(cursor as Record<string, unknown>);
    if (keys.length !== 1) break;
    cursor = (cursor as Record<string, unknown>)[keys[0]];
  }
  assert.equal(cursor, '[depth-exceeded]');
});

test('redactPayload: serialized size cap swaps oversized payload for marker (JSONB-safe)', () => {
  // 每个字符串叶值先被 2000 字符上限截断，故需多个长字段才能超过 64KB 序列化上限。
  const big: Record<string, unknown> = {};
  for (let i = 0; i < 48; i++) big[`field${i}`] = 'x'.repeat(MAX_PAYLOAD_STRING_CHARS);
  const out = redactPayload(big, 'tool.result');
  assert.deepEqual(Object.keys(out), ['redaction']);
  assert.equal((out.redaction as Record<string, unknown>).status, 'truncated');
  const serialized = JSON.stringify(out);
  assert.ok(serialized.length <= MAX_PAYLOAD_JSON_BYTES);
});

test('redactPayload: registered waterfall transform runs after defaults', () => {
  const unregister = registerPayloadRedactor((value) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const out = { ...(value as Record<string, unknown>) };
      if ('custom' in out) out.custom = 'custom-redacted';
      return out;
    }
    return value;
  });
  try {
    const out = redactPayload({ custom: 'raw', apiKey: 'sk-x' }, 'tool.call');
    assert.equal(out.custom, 'custom-redacted');
    assert.equal(out.apiKey, REDACTED_LITERAL);
  } finally {
    unregister();
  }
  assert.equal(payloadRedactorCount(), 0);
});

test('redactPayload: throwing redactor withholds single payload, never throws', () => {
  const unregister = registerPayloadRedactor(() => {
    throw new Error('boom');
  });
  try {
    const out = redactPayload({ secret: 'x' }, 'tool.result');
    assert.equal((out.redaction as Record<string, unknown>).status, 'withheld');
    assert.ok(!('secret' in out));
  } finally {
    unregister();
  }
});

test('redactPayload: input object is never mutated (canonical log not rewritten)', () => {
  const input = { apiKey: 'sk-abc', nested: { token: 't-1' } };
  const snapshot = JSON.stringify(input);
  redactPayload(input, 'tool.call');
  assert.equal(JSON.stringify(input), snapshot);
});
