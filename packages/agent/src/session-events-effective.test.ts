import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '@los/infra/config';
import { closeDb, getDb, initDb } from '@los/infra/db';
import { ensureSessionEventStore, latestEffectiveModels } from './session-events.js';

test('latestEffectiveModels projects the newest model.response model per session', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  await ensureSessionEventStore();

  const stamp = `${Date.now()}`;
  const sessionA = `eff-a-${stamp}`;
  const sessionB = `eff-b-${stamp}`;
  const sessionC = `eff-c-${stamp}`;

  try {
    const db = getDb();
    const insert = (sessionId: string, type: string, model: string | null) => db.query(
      `INSERT INTO session_events (session_id, turn, type, source, model, usage_json, payload_json)
       VALUES ($1, 1, $2, 'los', $3, '{}'::jsonb, '{}'::jsonb)`,
      [sessionId, type, model],
    );

    // Session A: model evolved over time — latest wins.
    await insert(sessionA, 'model.response', 'deepseek-v4');
    await insert(sessionA, 'model.response', 'deepseek-v4-flash');
    // Session B: only tool events, no model — absent from projection.
    await insert(sessionB, 'tool.result', null);
    // Session C: response without model field, then one with — only non-empty models count.
    await insert(sessionC, 'model.response', null);
    await insert(sessionC, 'model.response', 'kimi-k3');

    const map = await latestEffectiveModels([sessionA, sessionB, sessionC, 'missing-session']);
    assert.equal(map.get(sessionA), 'deepseek-v4-flash');
    assert.equal(map.get(sessionB), undefined);
    assert.equal(map.get(sessionC), 'kimi-k3');
    assert.equal(map.get('missing-session'), undefined);
    assert.equal(map.size, 2);
  } finally {
    await getDb().query(
      `DELETE FROM session_events WHERE session_id IN ($1, $2, $3)`,
      [sessionA, sessionB, sessionC],
    ).catch(() => undefined);
    await closeDb().catch(() => undefined);
  }
});

test('latestEffectiveModels returns empty map for empty input', async () => {
  const map = await latestEffectiveModels([]);
  assert.equal(map.size, 0);
});
