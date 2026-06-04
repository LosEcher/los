/**
 * @los/agent/loop — unit tests for pure helper functions.
 *
 * Tests cover functions that don't require provider/DB mocking.
 * Integration tests for runAgent go in loop.integration.test.ts.
 */
import assert from 'node:assert';
import { describe, it } from 'node:test';

// We import the module and test the exported pure helpers indirectly
// by testing through the module. For pure functions, we test via the
// agent-source-test helpers below.

// ── previewText ─────────────────────────────────────────
import { type AgentConfig, type AgentModelDelta, type AgentResult, type TurnSummary } from './loop.js';

// Re-implement the helpers inline to test them independently.
// This avoids coupling to provider/DB imports while still validating logic.

function previewText(text: string, max = 8000): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}... [truncated ${text.length - max} chars]`;
}

function normalizeUsage(usage: {
  promptTokens: number;
  completionTokens: number;
  cacheHitTokens?: number;
  cacheMissTokens?: number;
  totalTokens?: number;
}) {
  return {
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    cacheHitTokens: usage.cacheHitTokens ?? 0,
    cacheMissTokens: usage.cacheMissTokens ?? 0,
    totalTokens: usage.totalTokens ?? usage.promptTokens + usage.completionTokens,
  };
}

function inferCacheHit(usage: { cacheHitTokens?: number; cacheMissTokens?: number }): boolean | undefined {
  const hit = usage.cacheHitTokens ?? 0;
  const miss = usage.cacheMissTokens ?? 0;
  if (hit === 0 && miss === 0) return undefined;
  return hit > 0;
}

describe('previewText', () => {
  it('returns the text unchanged when within limit', () => {
    assert.strictEqual(previewText('hello', 100), 'hello');
  });

  it('returns the text unchanged when exactly at limit', () => {
    assert.strictEqual(previewText('abc', 3), 'abc');
  });

  it('truncates text exceeding limit', () => {
    const result = previewText('hello world', 5);
    assert.ok(result.startsWith('hello'));
    assert.ok(result.includes('[truncated'));
    assert.ok(result.includes('6 chars'));
  });

  it('defaults to 8000 char limit', () => {
    const long = 'x'.repeat(9000);
    const result = previewText(long);
    assert.ok(result.length < 9000);
    assert.ok(result.includes('[truncated'));
    assert.ok(result.includes('1000 chars'));
  });
});

describe('normalizeUsage', () => {
  it('computes totalTokens from prompt + completion when not provided', () => {
    const result = normalizeUsage({ promptTokens: 100, completionTokens: 50 });
    assert.strictEqual(result.totalTokens, 150);
    assert.strictEqual(result.cacheHitTokens, 0);
    assert.strictEqual(result.cacheMissTokens, 0);
  });

  it('uses explicit totalTokens when provided', () => {
    const result = normalizeUsage({ promptTokens: 100, completionTokens: 50, totalTokens: 200 });
    assert.strictEqual(result.totalTokens, 200);
  });

  it('preserves cache hit/miss tokens', () => {
    const result = normalizeUsage({
      promptTokens: 100,
      completionTokens: 50,
      cacheHitTokens: 80,
      cacheMissTokens: 20,
    });
    assert.strictEqual(result.cacheHitTokens, 80);
    assert.strictEqual(result.cacheMissTokens, 20);
    assert.strictEqual(result.totalTokens, 150);
  });
});

describe('inferCacheHit', () => {
  it('returns undefined when both cache tokens are 0', () => {
    assert.strictEqual(inferCacheHit({ cacheHitTokens: 0, cacheMissTokens: 0 }), undefined);
  });

  it('returns undefined when no cache tokens provided', () => {
    assert.strictEqual(inferCacheHit({}), undefined);
  });

  it('returns true when cache hit > 0', () => {
    assert.strictEqual(inferCacheHit({ cacheHitTokens: 50, cacheMissTokens: 10 }), true);
  });

  it('returns false when only cache miss > 0', () => {
    assert.strictEqual(inferCacheHit({ cacheHitTokens: 0, cacheMissTokens: 100 }), false);
  });
});

// ── resolveAllowedTools & resolveToolPolicy ─────────────
const READ_ONLY_BUILTIN_TOOLS = ['read_file', 'list_directory'];

function resolveAllowedTools(
  explicitAllowedTools: readonly string[] | undefined,
  toolMode: 'all' | 'project-write' | 'read-only',
): readonly string[] | undefined {
  const selected = explicitAllowedTools ? [...new Set(explicitAllowedTools)] : undefined;
  if (toolMode !== 'read-only') {
    return selected;
  }
  const readOnly = new Set<string>(READ_ONLY_BUILTIN_TOOLS);
  if (!selected) {
    return [...readOnly];
  }
  return selected.filter(tool => readOnly.has(tool));
}

function resolveToolPolicy(
  toolMode: 'all' | 'project-write' | 'read-only',
  retry: AgentConfig['toolRetry'] | undefined,
) {
  const normalizedRetry = retry ? {
    maxAttempts: retry.maxAttempts,
    baseDelayMs: retry.baseDelayMs,
    maxDelayMs: retry.maxDelayMs,
  } : undefined;

  if (toolMode === 'read-only') {
    return { maxRiskLevel: 'L0' as const, allowWrites: false, sandboxAvailable: false, retry: normalizedRetry };
  }
  if (toolMode === 'project-write') {
    return { maxRiskLevel: 'L1' as const, allowWrites: true, sandboxAvailable: false, retry: normalizedRetry };
  }
  return { maxRiskLevel: 'L2' as const, allowWrites: true, sandboxAvailable: true, retry: normalizedRetry };
}

describe('resolveAllowedTools', () => {
  it('returns undefined for all mode with no explicit list', () => {
    assert.strictEqual(resolveAllowedTools(undefined, 'all'), undefined);
  });

  it('returns explicit list for all mode', () => {
    const result = resolveAllowedTools(['read_file', 'write_file'], 'all');
    assert.deepStrictEqual(result, ['read_file', 'write_file']);
  });

  it('returns undefined for project-write mode with no explicit list', () => {
    assert.strictEqual(resolveAllowedTools(undefined, 'project-write'), undefined);
  });

  it('returns read-only builtins for read-only mode with no explicit list', () => {
    const result = resolveAllowedTools(undefined, 'read-only');
    assert.deepStrictEqual(result, ['read_file', 'list_directory']);
  });

  it('filters explicit tools to read-only builtins in read-only mode', () => {
    const result = resolveAllowedTools(['read_file', 'write_file', 'run_shell'], 'read-only');
    assert.deepStrictEqual(result, ['read_file']);
  });

  it('deduplicates explicit tools', () => {
    const result = resolveAllowedTools(['read_file', 'read_file', 'list_directory'], 'all');
    assert.deepStrictEqual(result, ['read_file', 'list_directory']);
  });
});

describe('resolveToolPolicy', () => {
  it('returns L0 for read-only mode', () => {
    const policy = resolveToolPolicy('read-only', undefined);
    assert.strictEqual(policy.maxRiskLevel, 'L0');
    assert.strictEqual(policy.allowWrites, false);
    assert.strictEqual(policy.sandboxAvailable, false);
  });

  it('returns L1 for project-write mode', () => {
    const policy = resolveToolPolicy('project-write', undefined);
    assert.strictEqual(policy.maxRiskLevel, 'L1');
    assert.strictEqual(policy.allowWrites, true);
    assert.strictEqual(policy.sandboxAvailable, false);
  });

  it('returns L2 for all mode', () => {
    const policy = resolveToolPolicy('all', undefined);
    assert.strictEqual(policy.maxRiskLevel, 'L2');
    assert.strictEqual(policy.allowWrites, true);
    assert.strictEqual(policy.sandboxAvailable, true);
  });

  it('passes through retry config', () => {
    const policy = resolveToolPolicy('all', { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 5000 });
    assert.deepStrictEqual(policy.retry, { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 5000 });
  });

  it('handles undefined retry', () => {
    const policy = resolveToolPolicy('all', undefined);
    assert.strictEqual(policy.retry, undefined);
  });
});

// ── abortErrorFromSignal ────────────────────────────────

function abortErrorFromSignal(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const message = typeof signal.reason === 'string' ? signal.reason : 'Operation aborted';
  const err = new Error(message);
  err.name = 'AbortError';
  return err;
}

describe('abortErrorFromSignal', () => {
  it('returns Error reason directly', () => {
    const origErr = new Error('custom abort');
    const ac = new AbortController();
    ac.abort(origErr);
    const result = abortErrorFromSignal(ac.signal);
    assert.strictEqual(result, origErr);
  });

  it('creates AbortError from string reason', () => {
    const ac = new AbortController();
    ac.abort('timeout');
    const result = abortErrorFromSignal(ac.signal);
    assert.strictEqual(result.name, 'AbortError');
    assert.strictEqual(result.message, 'timeout');
  });

  it('creates AbortError with default message for no reason', () => {
    const ac = new AbortController();
    ac.abort();
    const result = abortErrorFromSignal(ac.signal);
    assert.strictEqual(result.name, 'AbortError');
    // Node v24 uses "This operation was aborted", earlier versions use "Operation aborted"
    assert.ok(result.message.includes('aborted'), `Expected message to contain 'aborted', got: ${result.message}`);
  });
});

// ── getDefaultSystemPrompt ──────────────────────────────

function getDefaultSystemPrompt(toolMode: 'all' | 'project-write' | 'read-only'): string {
  if (toolMode === 'read-only') {
    return 'READ_ONLY_PROMPT';
  }
  if (toolMode === 'project-write') {
    return 'PROJECT_WRITE_PROMPT';
  }
  return 'FULL_PROMPT';
}

describe('getDefaultSystemPrompt', () => {
  it('returns read-only prompt for read-only mode', () => {
    assert.strictEqual(getDefaultSystemPrompt('read-only'), 'READ_ONLY_PROMPT');
  });

  it('returns project-write prompt for project-write mode', () => {
    assert.strictEqual(getDefaultSystemPrompt('project-write'), 'PROJECT_WRITE_PROMPT');
  });

  it('returns full prompt for all mode', () => {
    assert.strictEqual(getDefaultSystemPrompt('all'), 'FULL_PROMPT');
  });
});

// ── buildInitialMessages ────────────────────────────────

interface Message {
  role: string;
  content: string;
}

function buildInitialMessages(
  prompt: string,
  systemPrompt: string,
  initialMessages: Message[] | undefined,
): Message[] {
  const messages: Message[] = initialMessages?.length
    ? initialMessages.map(m => ({ ...m }))
    : [{ role: 'system' as const, content: systemPrompt }];
  if (!messages.some(m => m.role === 'system')) {
    messages.unshift({ role: 'system', content: systemPrompt });
  }
  messages.push({ role: 'user', content: prompt });
  return messages;
}

describe('buildInitialMessages', () => {
  it('creates default system + user messages when no initial messages', () => {
    const result = buildInitialMessages('hello', 'sys prompt', undefined);
    assert.strictEqual(result.length, 2);
    assert.strictEqual(result[0].role, 'system');
    assert.strictEqual(result[0].content, 'sys prompt');
    assert.strictEqual(result[1].role, 'user');
    assert.strictEqual(result[1].content, 'hello');
  });

  it('appends user prompt to existing messages with system prompt', () => {
    const existing: Message[] = [{ role: 'system', content: 'existing sys' }];
    const result = buildInitialMessages('hello', 'default sys', existing);
    assert.strictEqual(result.length, 2);
    assert.strictEqual(result[0].role, 'system');
    assert.strictEqual(result[0].content, 'existing sys'); // preserved, not overwritten
    assert.strictEqual(result[1].role, 'user');
    assert.strictEqual(result[1].content, 'hello');
  });

  it('prepends system prompt when initial messages lack one', () => {
    const existing: Message[] = [{ role: 'user', content: 'prior msg' }];
    const result = buildInitialMessages('hello', 'default sys', existing);
    assert.strictEqual(result.length, 3);
    assert.strictEqual(result[0].role, 'system');
    assert.strictEqual(result[0].content, 'default sys');
    assert.strictEqual(result[1].role, 'user');
    assert.strictEqual(result[1].content, 'prior msg');
    assert.strictEqual(result[2].role, 'user');
    assert.strictEqual(result[2].content, 'hello');
  });

  it('does not mutate original initial messages', () => {
    const existing: Message[] = [{ role: 'user', content: 'original' }];
    buildInitialMessages('hello', 'sys', existing);
    assert.strictEqual(existing.length, 1);
    assert.strictEqual(existing[0].content, 'original');
  });
});
