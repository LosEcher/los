import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { loadConfig } from '@los/infra/config';
import { closeDb, initDb } from '@los/infra/db';
import { createRunSpec, ensureRunSpecStore, updateRunSpecResult } from '../../run-specs.js';
import { createToolRegistry } from './registry.js';
import { registerAgentQueryKillTools } from './agent-tools.js';

// Registered in test-runner.mjs isolatedGroupB — must stay in the same group
// as run-specs.test.ts so schema creation never races across parallel files.

function queryAgent(agentId: string): Promise<{ content: string; error?: string }> {
  const registry = createToolRegistry();
  registerAgentQueryKillTools(registry);
  return registry.execute({ name: 'query_agent', arguments: { agentId } });
}

function queryAgentScoped(agentId: string, tenantId: string): Promise<{ content: string; error?: string }> {
  const registry = createToolRegistry();
  registerAgentQueryKillTools(registry, { tenantId });
  return registry.execute({ name: 'query_agent', arguments: { agentId } });
}

function listAgents(): Promise<{ content: string; error?: string }> {
  const registry = createToolRegistry();
  registerAgentQueryKillTools(registry);
  return registry.execute({ name: 'list_agents', arguments: {} });
}

test('query_agent recovers a persisted completed background agent after restart', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  await ensureRunSpecStore();
  const childSessionId = `session-parent:child:${randomUUID()}`;
  const specId = `run-child-${childSessionId}-${Date.now()}`;
  try {
    await createRunSpec({
      id: specId,
      sessionId: childSessionId,
      prompt: 'background investigation',
      workspaceRoot: '/tmp/workspace',
      toolMode: 'read-only',
      parentRunSpecId: 'parent-run-spec',
    });
    await updateRunSpecResult(specId, {
      status: 'completed',
      text: 'persisted result text',
      loopCount: 3,
      totalTokens: 1200,
      completedAt: new Date().toISOString(),
    });

    const result = await queryAgent(`agent-${childSessionId}`);
    assert.equal(result.error, undefined);
    const parsed = JSON.parse(result.content) as {
      source: string; status: string; result: { text: string; loopCount: number; totalTokens: number } | null;
      childRunSpecId: string | null; childSessionId: string;
    };
    assert.equal(parsed.source, 'persisted');
    assert.equal(parsed.childRunSpecId, specId);
    assert.equal(parsed.childSessionId, childSessionId);
    assert.equal(parsed.status, 'completed');
    assert.equal(parsed.result?.text, 'persisted result text');
    assert.equal(parsed.result?.loopCount, 3);
    assert.equal(parsed.result?.totalTokens, 1200);
  } finally {
    await closeDb();
  }
});

test('query_agent recovers a failed background agent with error', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  await ensureRunSpecStore();
  const childSessionId = `session-parent:child:${randomUUID()}`;
  const specId = `run-child-${childSessionId}-${Date.now()}`;
  try {
    await createRunSpec({
      id: specId,
      sessionId: childSessionId,
      prompt: 'background task that fails',
      workspaceRoot: '/tmp/workspace',
      toolMode: 'read-only',
      parentRunSpecId: 'parent-run-spec',
    });
    await updateRunSpecResult(specId, {
      status: 'failed',
      text: '',
      error: 'provider timeout after 5 loops',
      completedAt: new Date().toISOString(),
    });

    const result = await queryAgent(`agent-${childSessionId}`);
    const parsed = JSON.parse(result.content) as { source: string; status: string; error: string | null };
    assert.equal(parsed.source, 'persisted');
    assert.equal(parsed.status, 'failed');
    assert.equal(parsed.error, 'provider timeout after 5 loops');
  } finally {
    await closeDb();
  }
});

test('query_agent reports unknown when run spec exists without a persisted result', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  await ensureRunSpecStore();
  const childSessionId = `session-parent:child:${randomUUID()}`;
  const specId = `run-child-${childSessionId}-${Date.now()}`;
  try {
    await createRunSpec({
      id: specId,
      sessionId: childSessionId,
      prompt: 'interrupted before completion',
      workspaceRoot: '/tmp/workspace',
      toolMode: 'read-only',
      parentRunSpecId: 'parent-run-spec',
    });

    const result = await queryAgent(`agent-${childSessionId}`);
    const parsed = JSON.parse(result.content) as { status: string; message: string };
    assert.equal(parsed.status, 'unknown');
    assert.match(parsed.message, /previous process/);
  } finally {
    await closeDb();
  }
});

test('query_agent returns error for unknown agentId', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  await ensureRunSpecStore();
  try {
    const result = await queryAgent(`agent-child:${randomUUID()}`);
    assert.match(result.error ?? '', /not found/i);
  } finally {
    await closeDb();
  }
});

test('query_agent recovery is scoped to the owning tenant', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  await ensureRunSpecStore();
  const childSessionId = `session-parent:child:${randomUUID()}`;
  const specId = `run-child-${childSessionId}-${Date.now()}`;
  try {
    await createRunSpec({
      id: specId,
      sessionId: childSessionId,
      tenantId: 'tenant-a',
      prompt: 'tenant-a background task',
      workspaceRoot: '/tmp/workspace',
      toolMode: 'read-only',
      parentRunSpecId: 'parent-run-spec',
    });
    await updateRunSpecResult(specId, {
      status: 'completed',
      text: 'tenant-a result',
      completedAt: new Date().toISOString(),
    });

    // Same session id looked up under the wrong tenant must not leak the record.
    const wrongTenant = await queryAgentScoped(`agent-${childSessionId}`, 'tenant-b');
    assert.match(wrongTenant.error ?? '', /not found/i);
    const rightTenant = await queryAgentScoped(`agent-${childSessionId}`, 'tenant-a');
    const parsed = JSON.parse(rightTenant.content) as { source: string; result: { text: string } | null };
    assert.equal(parsed.source, 'persisted');
    assert.equal(parsed.result?.text, 'tenant-a result');
  } finally {
    await closeDb();
  }
});

test('list_agents merges persisted background agents after restart', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  await ensureRunSpecStore();
  const childSessionId = `session-parent:child:${randomUUID()}`;
  const specId = `run-child-${childSessionId}-${Date.now()}`;
  try {
    await createRunSpec({
      id: specId,
      sessionId: childSessionId,
      prompt: 'background listing probe',
      workspaceRoot: '/tmp/workspace',
      toolMode: 'read-only',
      parentRunSpecId: 'parent-run-spec',
    });
    await updateRunSpecResult(specId, {
      status: 'completed',
      text: 'listed result',
      completedAt: new Date().toISOString(),
    });

    const result = await listAgents();
    const parsed = JSON.parse(result.content) as Array<{ agentId: string; status: string; source: string }>;
    assert.ok(parsed.some(a => a.agentId === `agent-${childSessionId}` && a.status === 'completed' && a.source === 'persisted'));
  } finally {
    await closeDb();
  }
});
