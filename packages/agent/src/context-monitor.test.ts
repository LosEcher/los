import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { createContextMonitor, formatContextFill } from './context-monitor.js';
import type { ContextFillState } from './context-monitor.js';

describe('context-monitor', () => {
  const WINDOW = 200_000;

  it('starts at normal level with zero tokens', () => {
    const m = createContextMonitor({ contextWindowTokens: WINDOW });
    const s = m.update({ promptTokens: 0, completionTokens: 0 }, 1);
    assert.equal(s.level, 'normal');
    assert.equal(s.fillPercent, 0);
    assert.equal(s.levelCrossed, false);
  });

  it('stays normal below warn threshold', () => {
    const m = createContextMonitor({ contextWindowTokens: WINDOW });
    // 100K tokens = 50%, below 60% warn
    const s = m.update({ promptTokens: 100_000, completionTokens: 0 }, 1);
    assert.equal(s.level, 'normal');
    assert.equal(s.fillPercent, 0.5);
    assert.equal(s.levelCrossed, false);
  });

  it('fires warn at 60%', () => {
    let fired = false;
    const m = createContextMonitor({
      contextWindowTokens: WINDOW,
      onWarn: () => { fired = true; },
    });
    // 120K tokens = 60%
    const s = m.update({ promptTokens: 120_000, completionTokens: 0 }, 1);
    assert.equal(s.level, 'warn');
    assert.equal(s.levelCrossed, true);
    assert.equal(fired, true);
  });

  it('fires checkpoint at 75%', () => {
    let fired = false;
    const m = createContextMonitor({
      contextWindowTokens: WINDOW,
      onCheckpoint: () => { fired = true; },
    });
    // 150K tokens = 75%
    const s = m.update({ promptTokens: 150_000, completionTokens: 0 }, 3);
    assert.equal(s.level, 'checkpoint');
    assert.equal(s.levelCrossed, true);
    assert.equal(fired, true);
  });

  it('fires critical at 85%', () => {
    let fired = false;
    const m = createContextMonitor({
      contextWindowTokens: WINDOW,
      onCritical: () => { fired = true; },
    });
    // 170K tokens = 85%
    const s = m.update({ promptTokens: 170_000, completionTokens: 0 }, 5);
    assert.equal(s.level, 'critical');
    assert.equal(s.levelCrossed, true);
    assert.equal(fired, true);
  });

  it('does not re-fire warn on subsequent turns at same level', () => {
    let count = 0;
    const m = createContextMonitor({
      contextWindowTokens: WINDOW,
      onWarn: () => { count++; },
    });
    // First crossing
    m.update({ promptTokens: 120_000, completionTokens: 0 }, 1);
    assert.equal(count, 1);
    // Stay in warn zone
    m.update({ promptTokens: 125_000, completionTokens: 0 }, 2);
    assert.equal(count, 1); // not re-fired
  });

  it('tracks latest prompt and cumulative completions separately', () => {
    const m = createContextMonitor({ contextWindowTokens: WINDOW });
    m.update({ promptTokens: 50_000, completionTokens: 5_000 }, 1);
    const s = m.update({ promptTokens: 55_000, completionTokens: 5_000 }, 2);
    // Latest prompt reflects current context (API reports full prompt per turn)
    assert.equal(s.latestPromptTokens, 55_000);
    // Completions accumulate per turn (each is incremental)
    assert.equal(s.cumulativeCompletionTokens, 10_000);
    // Current context = latest prompt + completion
    assert.equal(s.estimatedTotalTokens, 60_000);
    assert.equal(s.fillPercent, 0.3);
    assert.equal(s.level, 'normal');
  });

  it('uses message overhead only when provider usage is unavailable', () => {
    const m = createContextMonitor({ contextWindowTokens: WINDOW });
    const fallback = m.update({ promptTokens: 0, completionTokens: 0 }, 1, 50);
    assert.equal(fallback.estimatedTotalTokens, 150);

    const reported = m.update({ promptTokens: 100_000, completionTokens: 10_000 }, 2, 50);
    assert.equal(reported.estimatedTotalTokens, 110_000);
  });

  it('prefers provider total tokens for current context fill', () => {
    const m = createContextMonitor({ contextWindowTokens: WINDOW });
    const s = m.update({ promptTokens: 100_000, completionTokens: 10_000, totalTokens: 115_000 }, 1);
    assert.equal(s.estimatedTotalTokens, 115_000);
  });

  it('reset clears all state', () => {
    const m = createContextMonitor({ contextWindowTokens: WINDOW });
    m.update({ promptTokens: 120_000, completionTokens: 0 }, 1);
    m.reset();
    const s = m.update({ promptTokens: 0, completionTokens: 0 }, 1);
    assert.equal(s.level, 'normal');
    assert.equal(s.latestPromptTokens, 0);
  });

  it('fires all three levels in sequence', () => {
    const events: string[] = [];
    const m = createContextMonitor({
      contextWindowTokens: WINDOW,
      onWarn: () => events.push('warn'),
      onCheckpoint: () => events.push('checkpoint'),
      onCritical: () => events.push('critical'),
    });
    m.update({ promptTokens: 120_000, completionTokens: 0 }, 1);  // 60%
    m.update({ promptTokens: 150_000, completionTokens: 0 }, 2);   // 75%
    m.update({ promptTokens: 170_000, completionTokens: 0 }, 3);   // 85%
    assert.deepEqual(events, ['warn', 'checkpoint', 'critical']);
  });

  it('skips warn if threshold jumped directly to checkpoint', () => {
    const events: string[] = [];
    const m = createContextMonitor({
      contextWindowTokens: WINDOW,
      onWarn: () => events.push('warn'),
      onCheckpoint: () => events.push('checkpoint'),
    });
    // Jump straight to 75% (e.g., large tool result)
    m.update({ promptTokens: 150_000, completionTokens: 0 }, 1);
    assert.deepEqual(events, ['checkpoint']); // warn not fired
  });

  it('formatContextFill produces readable output', () => {
    const state: ContextFillState = {
      usedTokens: 120_000,
      contextWindowTokens: WINDOW,
      fillPercent: 0.60,
      level: 'warn',
      levelCrossed: true,
      turn: 3,
      latestPromptTokens: 110_000,
      cumulativeCompletionTokens: 10_000,
      estimatedTotalTokens: 120_000,
      cacheHitRate: 0.80,
      cacheObserved: true,
      cumulativeCacheHitTokens: 88_000,
      cumulativeCacheMissTokens: 22_000,
    };
    const out = formatContextFill(state);
    assert.ok(out.includes('WARN'));
    assert.ok(out.includes('60.0%'));
    assert.ok(out.includes('120,000'));
    assert.ok(out.includes('200,000'));
  });

  it('custom thresholds are respected', () => {
    const m = createContextMonitor({
      contextWindowTokens: 100_000,
      warnThreshold: 0.50,
      checkpointThreshold: 0.70,
      criticalThreshold: 0.90,
    });
    // 50K / 100K = 50% → warn
    const s1 = m.update({ promptTokens: 50_000, completionTokens: 0 }, 1);
    assert.equal(s1.level, 'warn');
    // 70K / 100K = 70% → checkpoint
    const s2 = m.update({ promptTokens: 70_000, completionTokens: 0 }, 2);
    assert.equal(s2.level, 'checkpoint');
    // 90K / 100K = 90% → critical
    const s3 = m.update({ promptTokens: 90_000, completionTokens: 0 }, 3);
    assert.equal(s3.level, 'critical');
  });

  it('getState returns current state without modifying', () => {
    const m = createContextMonitor({ contextWindowTokens: WINDOW });
    m.update({ promptTokens: 120_000, completionTokens: 0 }, 1);
    const state = m.getState();
    assert.equal(state.level, 'warn');
    assert.ok(state.fillPercent >= 0.6);
  });

  // ── Cache hit rate tracking ──

  it('tracks cache hit rate from recordCacheActivity calls', () => {
    const m = createContextMonitor({ contextWindowTokens: WINDOW });
    m.recordCacheActivity(80_000, 20_000);
    const state = m.update({ promptTokens: 50_000, completionTokens: 0 }, 1);
    assert.equal(state.cacheHitRate, 0.80);
    assert.equal(state.cacheObserved, true);
    assert.equal(state.cumulativeCacheHitTokens, 80_000);
    assert.equal(state.cumulativeCacheMissTokens, 20_000);
  });

  it('returns undefined cacheHitRate when no cache activity', () => {
    const m = createContextMonitor({ contextWindowTokens: WINDOW });
    const state = m.update({ promptTokens: 50_000, completionTokens: 0 }, 1);
    assert.equal(state.cacheHitRate, undefined);
    assert.equal(state.cacheObserved, false);
  });

  it('fires onCacheLow when hit rate drops below threshold', () => {
    const events: string[] = [];
    const m = createContextMonitor({
      contextWindowTokens: WINDOW,
      cacheHitRateWarnThreshold: 0.70,
      onCacheLow: () => events.push('cache_low'),
    });
    // First turn: cache hit rate = 80% (above threshold)
    m.recordCacheActivity(80_000, 20_000);
    m.update({ promptTokens: 50_000, completionTokens: 0 }, 1);
    assert.deepEqual(events, []); // no callback yet
    // Second turn: add mostly miss tokens, drops hit rate to 50%
    m.recordCacheActivity(20_000, 80_000);
    m.update({ promptTokens: 60_000, completionTokens: 0 }, 2);
    assert.deepEqual(events, ['cache_low']); // fires once
  });

  it('resets cache-low crossing when hit rate recovers', () => {
    const events: string[] = [];
    const m = createContextMonitor({
      contextWindowTokens: WINDOW,
      cacheHitRateWarnThreshold: 0.70,
      onCacheLow: () => events.push('cache_low'),
    });
    // Drop below threshold: 50 / 100 = 50%
    m.recordCacheActivity(50_000, 50_000);
    m.update({ promptTokens: 50_000, completionTokens: 0 }, 1);
    assert.deepEqual(events, ['cache_low']);
    // Recover above threshold: cumulative = (50+190)/(100+200) = 240/300 = 80%
    m.recordCacheActivity(190_000, 10_000);
    m.update({ promptTokens: 60_000, completionTokens: 0 }, 2);
    // Re-drop below threshold: cumulative = (240+10)/(300+200) = 250/500 = 50%
    m.recordCacheActivity(10_000, 190_000);
    m.update({ promptTokens: 70_000, completionTokens: 0 }, 3);
    assert.deepEqual(events, ['cache_low', 'cache_low']);
    assert.equal(m.getState().cacheHitRate, 0.50);
  });

  it('formatContextFill includes cache info when observed', () => {
    const m = createContextMonitor({ contextWindowTokens: WINDOW });
    m.recordCacheActivity(80_000, 20_000);
    const state = m.update({ promptTokens: 120_000, completionTokens: 0 }, 3);
    const out = formatContextFill(state);
    assert.ok(out.includes('cache:80%'));
  });

  it('reset clears cache counters', () => {
    const m = createContextMonitor({ contextWindowTokens: WINDOW });
    m.recordCacheActivity(80_000, 20_000);
    m.update({ promptTokens: 50_000, completionTokens: 0 }, 1);
    assert.ok(m.getState().cacheObserved);
    m.reset();
    assert.equal(m.getState().cacheObserved, false);
    assert.equal(m.getState().cacheHitRate, undefined);
  });
});
