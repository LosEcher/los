import test from 'node:test';
import assert from 'node:assert/strict';

import { ensureSessionEventStore } from '@los/agent/session-events';
import { loadConfig } from '@los/infra/config';
import { closeDb, getDb, initDb } from '@los/infra/db';
import { prepareChatContextPolicy } from './chat-context-policy.js';

test.before(async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  await ensureSessionEventStore();
});

test.after(async () => {
  await closeDb().catch(() => undefined);
});

test('persists bounded context policy evidence without prompt content', async () => {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const sessionId = `session-context-policy-${suffix}`;
  const runSpecId = `run-context-policy-${suffix}`;
  const promptMarker = `private-system-prompt-${suffix}`;

  try {
    const prepared = await prepareChatContextPolicy({
      sessionId,
      runSpecId,
      tenantId: `tenant-${suffix}`,
      projectId: `project-${suffix}`,
      userId: `user-${suffix}`,
      requestId: `request-${suffix}`,
      traceId: `trace-${suffix}`,
      workspaceRoot: process.cwd(),
      toolMode: 'read-only',
      systemPrompt: promptMarker,
      identityName: 'default',
      identityLevel: 'none',
    });

    assert.ok(prepared.systemPrompt.includes(promptMarker));
    assert.equal(prepared.event.type, 'coordinator.context_policy_selected');
    assert.equal(prepared.event.visibility, 'audit');
    assert.equal(prepared.event.projectId, `project-${suffix}`);
    assert.equal(prepared.event.payload.runSpecId, runSpecId);
    assert.equal(prepared.event.payload.baseSystemPromptSource, 'request');
    assert.equal(prepared.event.payload.identityLevel, 'none');
    assert.equal(prepared.event.payload.identityInjected, false);
    assert.ok(Array.isArray(prepared.event.payload.memoryLayers));
    assert.equal(typeof prepared.event.payload.activeRuleCount, 'number');
    assert.equal(typeof prepared.event.payload.observationCount, 'number');
    assert.equal(JSON.stringify(prepared.event.payload).includes(promptMarker), false);
  } finally {
    await getDb().query('DELETE FROM session_events WHERE session_id = $1', [sessionId]).catch(() => undefined);
  }
});

test('gateway chat defaults to standard identity from the execution-path policy', async () => {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const sessionId = `session-context-identity-${suffix}`;

  try {
    const prepared = await prepareChatContextPolicy({
      sessionId,
      runSpecId: `run-context-identity-${suffix}`,
      tenantId: `tenant-${suffix}`,
      projectId: `project-${suffix}`,
      userId: `user-${suffix}`,
      requestId: `request-${suffix}`,
      traceId: `trace-${suffix}`,
      workspaceRoot: process.cwd(),
      toolMode: 'read-only',
    });

    assert.equal(prepared.policy.identity.level, 'standard');
    assert.equal(prepared.policy.identity.injected, true);
    assert.ok(prepared.systemPrompt.includes('## Identity'));
  } finally {
    await getDb().query('DELETE FROM session_events WHERE session_id = $1', [sessionId]).catch(() => undefined);
  }
});
