import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '@los/infra/config';
import { closeDb, getDb, initDb } from '@los/infra/db';
import { ensureSessionEventStore } from './session-events.js';
import { ensureRunSpecStore } from './run-specs.js';
import { getSessionSubagents } from './session-subagents.js';

test('getSessionSubagents builds recursive lineage with usage and lifecycle', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  await ensureSessionEventStore();
  await ensureRunSpecStore();

  const stamp = `${Date.now()}`;
  const parentSession = `subagent-parent-${stamp}`;
  const childSession = `subagent-child-${stamp}`;
  const grandSession = `subagent-grand-${stamp}`;
  const parentRun = `run-parent-${stamp}`;
  const childRun = `run-child-${stamp}`;
  const grandRun = `run-grand-${stamp}`;

  try {
    const db = getDb();
    const insertRun = (
      id: string,
      sessionId: string,
      parentRunSpecId: string | null,
      status: string,
      model: string,
    ) => db.query(
      `INSERT INTO run_specs
         (id, session_id, parent_run_spec_id, status, prompt, model_settings_json,
          workspace_root, tool_mode, allowed_tools_json, tool_retry_json, max_loops,
          mcp_servers_json, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, '{}'::jsonb, '/tmp', 'all', '[]'::jsonb, '{}'::jsonb,
               10, '[]'::jsonb, now(), now())`,
      [id, sessionId, parentRunSpecId, status, model],
    );
    const insertEvent = (
      sessionId: string,
      type: string,
      payload: Record<string, unknown>,
    ) => db.query(
      `INSERT INTO session_events (session_id, turn, type, source, usage_json, payload_json)
       VALUES ($1, 0, $2, 'los', '{}'::jsonb, $3::jsonb)`,
      [sessionId, type, JSON.stringify(payload)],
    );

    await insertRun(parentRun, parentSession, null, 'succeeded', 'deepseek-chat');
    await insertRun(childRun, childSession, parentRun, 'succeeded', 'deepseek-chat');
    await insertRun(grandRun, grandSession, childRun, 'failed', 'deepseek-chat');

    // Parent session carries child lifecycle events for both descendants.
    await insertEvent(parentSession, 'child.agent.started', {
      childRunSpecId: childRun,
      childSessionId: childSession,
      status: 'running',
    });
    await insertEvent(parentSession, 'child.agent.completed', {
      childRunSpecId: childRun,
      childSessionId: childSession,
      status: 'completed',
    });
    await insertEvent(parentSession, 'child.agent.started', {
      childRunSpecId: grandRun,
      childSessionId: grandSession,
      status: 'running',
    });
    await insertEvent(parentSession, 'child.agent.failed', {
      childRunSpecId: grandRun,
      childSessionId: grandSession,
      status: 'failed',
    });

    // Child session usage/cost evidence.
    await db.query(
      `INSERT INTO session_events (session_id, turn, type, source, usage_json, payload_json)
       VALUES ($1, 1, 'model.response', 'los', $2::jsonb, $3::jsonb)`,
      [childSession, JSON.stringify({ promptTokens: 100, completionTokens: 20 }), JSON.stringify({ cost: { totalCostUsd: 0.01 } })],
    );

    const result = await getSessionSubagents(parentSession);
    assert.equal(result.sessionId, parentSession);
    assert.equal(result.roots.length, 1);
    assert.equal(result.roots[0]!.runSpecId, parentRun);
    assert.equal(result.tree.length, 1);

    const child = result.tree[0]!.children[0]!;
    assert.equal(child.runSpecId, childRun);
    assert.equal(child.eventStatus, 'completed');
    assert.equal(child.usage.promptTokens, 100);
    assert.equal(child.usage.completionTokens, 20);
    assert.equal(child.usage.totalTokens, 120);
    assert.ok(Math.abs(child.estimatedCostUsd - 0.01) < 1e-9);
    assert.ok(child.durationMs !== null && child.durationMs >= 0);

    const grand = child.children[0]!;
    assert.equal(grand.runSpecId, grandRun);
    assert.equal(grand.eventStatus, 'failed');
    assert.equal(grand.status, 'failed');

    // Depth cap: maxDepth=1 hides all children below the root.
    const shallow = await getSessionSubagents(parentSession, 1);
    assert.equal(shallow.tree[0]!.children.length, 0);
  } finally {
    const db = getDb();
    await db.query(
      `DELETE FROM run_specs WHERE id IN ($1, $2, $3)`,
      [parentRun, childRun, grandRun],
    ).catch(() => undefined);
    await db.query(
      `DELETE FROM session_events WHERE session_id IN ($1, $2, $3)`,
      [parentSession, childSession, grandSession],
    ).catch(() => undefined);
    await closeDb().catch(() => undefined);
  }
});
