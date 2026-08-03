import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig } from '@los/infra/config';
import { closeDb, getDb, initDb } from '@los/infra/db';
import { ensureMemoryStore } from '@los/memory';

import { createChatTaskHooks } from './chat-service-hooks.js';

/**
 * Event-storm convergence harness (advisory 2026-08-04 candidate A).
 *
 * Legacy behavior: every tool transition (`tool_call_state.updated` →
 * succeeded/failed) and every 20th session event triggered one compactSession,
 * which emitted one `compaction.pre_compact` / `compaction.post_compact`
 * operator pair and inserted one `memory_compactions` row each time — measured
 * 221 pairs in the K4 run. The throttled cadence (CHECKPOINT_MIN_INTERVAL_MS
 * = 60s) must cap compactions at ~run duration / 60s while keeping the
 * event-count cadence and the 10-minute backstop intact.
 */
test('checkpoint compaction is throttled: 200 tool transitions in a 5-minute run yield ≤6 compaction pairs', async (t) => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  t.after(async () => {
    await closeDb().catch(() => undefined);
  });

  mock.timers.enable({ apis: ['Date'] });
  t.after(() => { mock.timers.reset(); });

  const sid = `storm-convergence-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const operatorPayloadTypes: string[] = [];
  const send = (event: string, payload: unknown) => {
    if (event === 'operator' && payload && typeof payload === 'object' && 'type' in payload) {
      operatorPayloadTypes.push(String((payload as { type?: unknown }).type));
    }
  };
  const hooks = createChatTaskHooks({
    sid,
    runSpecId: `run-${sid}`,
    requestId: `req-${sid}`,
    tenantId: 'tenant-storm',
    projectId: 'project-storm',
    userId: 'user-storm',
    traceId: `trace-${sid}`,
    provider: undefined,
    model: undefined,
    workspaceRoot: process.cwd(),
    toolMode: 'auto',
    config,
    resumedSession: undefined,
    ctx: { activeTaskRunId: undefined, lastCheckpoint: undefined },
    send,
  });

  // Seed one observation so compactSession runs the full path (INSERT + post hook)
  // instead of the empty-session early return.
  await ensureMemoryStore();
  await getDb().query(
    `INSERT INTO observations (title, summary, content, source, session_id)
     VALUES ('storm-harness', 'harness seed', 'seed content for compaction path', 'user', $1)`,
    [sid],
  );

  const preCountAt = () => operatorPayloadTypes.filter(type => type === 'compaction.pre_compact').length;
  const postCountAt = () => operatorPayloadTypes.filter(type => type === 'compaction.post_compact').length;

  // 5-minute run: 250 session events, 200 of them tool transitions
  // (4 transitions per ordinary event), spaced 1.2s apart.
  const totalMs = 300_000;
  const eventCount = 250;
  const stepMs = totalMs / eventCount;
  for (let i = 0; i < eventCount; i += 1) {
    const isTransition = i % 5 !== 4;
    const id = i + 1;
    await hooks.onSessionEvent(isTransition
      ? { id, turn: 1, type: 'tool_call_state.updated', payload: { entityId: `call-${i}`, to: 'succeeded', reason: 'ok' } }
      : { id, turn: 1, type: 'tool.result', payload: { callId: `call-${i}` } });
    mock.timers.tick(stepMs);
  }

  // Let the fire-and-forget compactSession chains settle (real timers). The
  // compactions serialize on the pg_advisory_xact_lock in compactSession, so
  // wait until the pre/post pair is stable for 3s (or 15s timeout).
  const startedAt = performance.now();
  let previousPair = '-1,-1';
  let stableMs = 0;
  while (performance.now() - startedAt < 15_000) {
    await new Promise(resolve => setTimeout(resolve, 250));
    const pair = `${preCountAt()},${postCountAt()}`;
    if (pair === previousPair) stableMs += 250; else stableMs = 0;
    if (stableMs >= 3_000 && preCountAt() > 0) break;
    previousPair = pair;
  }

  const preCount = preCountAt();
  const postCount = operatorPayloadTypes.filter(type => type === 'compaction.post_compact').length;
  const compactionRows = await getDb().query<{ count: string }>(
    'SELECT COUNT(*)::text AS count FROM memory_compactions WHERE session_id = $1',
    [sid],
  );

  // Legacy baseline: every one of the 200 tool transitions fired once, plus
  // ~12 event-count triggers (250/20) — ~212 compactSession calls.
  const legacyTriggerCount = Math.floor((eventCount * 4) / 5) + Math.floor(eventCount / 20);

  assert.ok(preCount >= 1, 'expected at least one compaction to still fire');
  assert.ok(preCount <= 6, `expected ≤6 compaction.pre_compact (throttled), got ${preCount}`);
  assert.equal(preCount, postCount, 'pre/post compaction events must stay paired');
  assert.equal(Number(compactionRows.rows[0]?.count ?? 0), preCount,
    'one memory_compactions row per completed compaction');

  const reduction = (100 * (1 - preCount / legacyTriggerCount)).toFixed(1);
  // Quantified evidence for the advisory: legacy ~212 compactions/run → N.
  console.log(
    `[storm-harness] session=${sid} events=${eventCount} toolTransitions=200 duration=300s ` +
    `legacy≈${legacyTriggerCount} compactions → throttled=${preCount} ` +
    `(reduction ${reduction}%, memory_compactions rows=${preCount})`,
  );
});

/**
 * The 10-minute max-interval backstop must still fire: an idle session (no
 * events for 10+ minutes) gets a `time_interval` checkpoint even inside the
 * throttle window logic.
 */
test('max-interval backstop still forces a checkpoint after 10 idle minutes', async (t) => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  t.after(async () => {
    await closeDb().catch(() => undefined);
  });

  mock.timers.enable({ apis: ['Date'] });
  t.after(() => { mock.timers.reset(); });

  const sid = `storm-backstop-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const compactionTriggers: string[] = [];
  const send = (event: string, payload: any) => {
    if (event === 'operator' && payload?.type === 'compaction.pre_compact') {
      compactionTriggers.push(payload.reason);
    }
  };
  const hooks = createChatTaskHooks({
    sid,
    runSpecId: `run-${sid}`,
    requestId: `req-${sid}`,
    tenantId: 'tenant-storm',
    projectId: 'project-storm',
    userId: 'user-storm',
    traceId: `trace-${sid}`,
    provider: undefined,
    model: undefined,
    workspaceRoot: process.cwd(),
    toolMode: 'auto',
    config,
    resumedSession: undefined,
    ctx: { activeTaskRunId: undefined, lastCheckpoint: undefined },
    send,
  });

  // Event 1 at t=0 (throttled, no checkpoint), then 11 minutes of silence.
  await hooks.onSessionEvent({ id: 1, turn: 1, type: 'tool.result', payload: { callId: 'call-1' } });
  mock.timers.tick(11 * 60_000);
  await hooks.onSessionEvent({ id: 2, turn: 1, type: 'tool.result', payload: { callId: 'call-2' } });

  for (let attempt = 0; attempt < 30; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 100));
    if (compactionTriggers.length > 0) break;
  }

  assert.ok(compactionTriggers.length >= 1,
    `expected time_interval backstop checkpoint after 10 idle minutes, got ${compactionTriggers.length}`);
});
