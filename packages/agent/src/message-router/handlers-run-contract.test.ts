/**
 * Focused tests for RunContract IM handlers.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '@los/infra/config';
import { closeDb, getDb, initDb } from '@los/infra/db';
import { createRunSpec, ensureRunSpecStore, loadRunSpec } from '../run-specs.js';
import { ensureSessionEventStore, listSessionEvents } from '../session-events.js';
import { createRunContractHandler } from './handlers-run-contract.js';
import type { HandlerContext, InboundMessage, ResolvedIntent } from './types.js';

function makeInbound(): InboundMessage {
  return {
    sourceKind: 'wx-weclaw',
    channelId: 'wechat-test',
    channelKind: 'weixin',
    rawText: '',
    rawPayload: {},
    metadata: { timestamp: new Date().toISOString() },
  };
}

async function runHandler(intent: ResolvedIntent): Promise<{ replies: string[]; result: Awaited<ReturnType<ReturnType<typeof createRunContractHandler>['handle']>> }> {
  const replies: string[] = [];
  const handler = createRunContractHandler();
  const ctx: HandlerContext = {
    inbound: makeInbound(),
    intent,
    reply: async (text) => { replies.push(text); },
  };
  const result = await handler.handle(ctx);
  return { replies, result };
}

test('run_contract handler: #approve-phase transitions planning → plan_approved', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const runId = `run-im-approve-${suffix}`;
  const sessionId = `session-im-approve-${suffix}`;

  try {
    await ensureRunSpecStore();
    await ensureSessionEventStore();
    await createRunSpec({
      id: runId,
      sessionId,
      prompt: 'im approve phase test',
      workspaceRoot: process.cwd(),
      toolMode: 'project-write',
      runContract: {
        mode: 'execution',
        goal: 'im approve',
        editableSurfaces: ['src/'],
        phase: 'planning',
      },
    });

    const { replies, result } = await runHandler({
      type: 'run_contract',
      action: 'approve_phase',
      runId,
      reason: 'approved from IM test',
    });

    assert.equal(result.handled, true);
    assert.match(replies.join('\n'), /计划已批准/);
    assert.match(replies.join('\n'), /plan_approved/);

    const loaded = await loadRunSpec(runId);
    assert.equal(loaded?.runContract?.phase, 'plan_approved');

    const events = await listSessionEvents(sessionId);
    const approval = events.find((e) => e.type === 'run.plan_approved');
    assert.ok(approval);
    assert.equal(approval?.payload?.actor, 'wechat-test');
    assert.equal(approval?.payload?.reason, 'approved from IM test');
  } finally {
    await getDb().query('DELETE FROM session_events WHERE session_id = $1', [sessionId]).catch(() => undefined);
    await getDb().query('DELETE FROM run_specs WHERE id = $1', [runId]).catch(() => undefined);
    await closeDb().catch(() => undefined);
  }
});

test('run_contract handler: #verify-run missing run reports not found', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  try {
    await ensureRunSpecStore();
    const { replies, result } = await runHandler({
      type: 'run_contract',
      action: 'verify_run',
      runId: 'run-does-not-exist-zzzz',
    });
    assert.equal(result.handled, true);
    assert.match(replies.join('\n'), /未找到 Run/);
    assert.equal(result.error, 'run_not_found');
  } finally {
    await closeDb().catch(() => undefined);
  }
});
