/**
 * @los/agent/session — unit tests for JSON normalization helpers.
 *
 * DB-dependent functions (saveSession/loadSession/listSessions/deleteSession)
 * require a running PostgreSQL instance. Those go in session.integration.test.ts.
 */
import assert from 'node:assert';
import { describe, it } from 'node:test';

// ── normalizeJsonArray ──────────────────────────────────

function normalizeJsonArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

describe('normalizeJsonArray', () => {
  it('returns the array itself when already an array', () => {
    const arr = [1, 2, 3];
    assert.strictEqual(normalizeJsonArray(arr), arr);
  });

  it('returns empty array for non-array, non-string', () => {
    assert.deepStrictEqual(normalizeJsonArray(42), []);
    assert.deepStrictEqual(normalizeJsonArray(null), []);
    assert.deepStrictEqual(normalizeJsonArray(undefined), []);
    assert.deepStrictEqual(normalizeJsonArray({}), []);
  });

  it('parses JSON string array', () => {
    const result = normalizeJsonArray('[1,2,3]');
    assert.deepStrictEqual(result, [1, 2, 3]);
  });

  it('returns empty array for JSON string that is not an array', () => {
    assert.deepStrictEqual(normalizeJsonArray('{"a":1}'), []);
    assert.deepStrictEqual(normalizeJsonArray('"hello"'), []);
    assert.deepStrictEqual(normalizeJsonArray('42'), []);
  });

  it('returns empty array for invalid JSON string', () => {
    assert.deepStrictEqual(normalizeJsonArray('not json'), []);
  });

  it('returns empty array for empty string', () => {
    assert.deepStrictEqual(normalizeJsonArray(''), []);
  });

  it('parses complex nested JSON arrays', () => {
    const result = normalizeJsonArray('[{"role":"user","content":"hi"}]');
    assert.strictEqual(result.length, 1);
    assert.deepStrictEqual(result[0], { role: 'user', content: 'hi' });
  });
});

// ── normalizeJsonObject ─────────────────────────────────

function normalizeJsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    } catch {
      return {};
    }
  }
  return {};
}

describe('normalizeJsonObject', () => {
  it('returns the object itself when already a plain object', () => {
    const obj = { key: 'value' };
    assert.strictEqual(normalizeJsonObject(obj), obj);
  });

  it('returns empty object for arrays', () => {
    assert.deepStrictEqual(normalizeJsonObject([1, 2, 3]), {});
  });

  it('returns empty object for null', () => {
    assert.deepStrictEqual(normalizeJsonObject(null), {});
  });

  it('returns empty object for undefined', () => {
    assert.deepStrictEqual(normalizeJsonObject(undefined), {});
  });

  it('returns empty object for numbers', () => {
    assert.deepStrictEqual(normalizeJsonObject(42), {});
  });

  it('parses JSON string object', () => {
    const result = normalizeJsonObject('{"a":1,"b":"c"}');
    assert.deepStrictEqual(result, { a: 1, b: 'c' });
  });

  it('returns empty object for JSON string that is not an object', () => {
    assert.deepStrictEqual(normalizeJsonObject('"hello"'), {});
    assert.deepStrictEqual(normalizeJsonObject('42'), {});
    assert.deepStrictEqual(normalizeJsonObject('[1,2]'), {});
  });

  it('returns empty object for invalid JSON string', () => {
    assert.deepStrictEqual(normalizeJsonObject('{broken'), {});
  });

  it('parses complex nested JSON objects', () => {
    const result = normalizeJsonObject('{"meta":{"count":5,"tags":["a","b"]}}');
    assert.deepStrictEqual(result.meta, { count: 5, tags: ['a', 'b'] });
  });
});

// ── toIsoString ─────────────────────────────────────────

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

describe('toIsoString', () => {
  it('converts Date to ISO string', () => {
    const d = new Date('2026-06-04T12:00:00Z');
    const result = toIsoString(d);
    assert.strictEqual(result, '2026-06-04T12:00:00.000Z');
  });

  it('converts ISO string to ISO string (round-trip)', () => {
    const result = toIsoString('2026-06-04T12:00:00.000Z');
    assert.strictEqual(result, '2026-06-04T12:00:00.000Z');
  });

  it('converts date-only string', () => {
    const result = toIsoString('2026-06-04');
    assert.ok(result.startsWith('2026-06-04T'));
  });
});
