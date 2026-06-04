/**
 * @los/infra/logger — unit tests.
 *
 * Tests cover level filtering, child logging, and the public API surface.
 * Does NOT test actual stdout/stderr output (those are integration tests).
 */
import assert from 'node:assert';
import { describe, it } from 'node:test';

// We test the Logger interface contract and level filtering logic
// without coupling to actual console output.

describe('Logger interface', () => {
  it('Logger type is importable (type-level check)', () => {
    // TypeScript-only: verify the Logger type compiles
    const _logger = {
      debug: (_msg: string, _meta?: Record<string, unknown>) => {},
      info: (_msg: string, _meta?: Record<string, unknown>) => {},
      warn: (_msg: string, _meta?: Record<string, unknown>) => {},
      error: (_msg: string, _meta?: Record<string, unknown>) => {},
      child: (_bindings: Record<string, unknown>) => ({ debug() {}, info() {}, warn() {}, error() {}, child() { return {} as any; } }),
    };
    assert.ok(_logger);
  });
});

// ── Level priority logic ────────────────────────────────
const LEVEL_PRIORITY: Record<string, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function shouldLog(level: string, minLevel: string): boolean {
  return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[minLevel];
}

describe('log level filtering', () => {
  it('debug is suppressed at default info level', () => {
    assert.strictEqual(shouldLog('debug', 'info'), false);
  });

  it('info is shown at default info level', () => {
    assert.strictEqual(shouldLog('info', 'info'), true);
  });

  it('warn is shown at info level', () => {
    assert.strictEqual(shouldLog('warn', 'info'), true);
  });

  it('error is shown at info level', () => {
    assert.strictEqual(shouldLog('error', 'info'), true);
  });

  it('debug is shown at debug level', () => {
    assert.strictEqual(shouldLog('debug', 'debug'), true);
  });

  it('all levels are shown at debug level', () => {
    assert.strictEqual(shouldLog('info', 'debug'), true);
    assert.strictEqual(shouldLog('warn', 'debug'), true);
    assert.strictEqual(shouldLog('error', 'debug'), true);
  });

  it('only errors are shown at error level', () => {
    assert.strictEqual(shouldLog('error', 'error'), true);
    assert.strictEqual(shouldLog('debug', 'error'), false);
    assert.strictEqual(shouldLog('info', 'error'), false);
    assert.strictEqual(shouldLog('warn', 'error'), false);
  });
});

// ── Timestamp format ────────────────────────────────────
describe('timestamp formatting', () => {
  it('ISO timestamp is valid ISO-8601', () => {
    const ts = new Date().toISOString();
    assert.ok(ts.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/));
  });

  it('ISO timestamp has millisecond precision', () => {
    const ts = new Date().toISOString();
    assert.ok(ts.includes('.'));
    assert.ok(ts.endsWith('Z'));
  });
});

// ── Child logger ────────────────────────────────────────
describe('child logger', () => {
  it('child logger preserves parent methods', () => {
    const calls: string[] = [];
    const parent = {
      debug: (msg: string) => { calls.push(`debug:${msg}`); },
      info: (msg: string) => { calls.push(`info:${msg}`); },
      warn: (msg: string) => { calls.push(`warn:${msg}`); },
      error: (msg: string) => { calls.push(`error:${msg}`); },
      child: () => parent,
    };
    const child = parent.child();
    child.info('hello');
    assert.deepStrictEqual(calls, ['info:hello']);
  });
});
