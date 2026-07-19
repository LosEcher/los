import assert from 'node:assert/strict';
import test from 'node:test';
import {
  inspectMCPServer,
  listMCPServerVersions,
  pinMCPServerVersion,
  rollbackMCPServerVersion,
  setMCPServerEnabled,
  unpinMCPServerVersion,
} from './mcp-distribution.js';
import { isMCPToolAllowed, normalizeMCPToolPolicy } from './mcp-distribution-policy.js';
import {
  deleteMCPServer,
  loadMCPServer,
  updateMCPServerStatus,
  upsertMCPServer,
} from './mcp-servers.js';
import { mcpServerExecutionBlocker } from './mcp-distribution-policy.js';

test('MCP distribution requires inspected versions and supports pin and rollback', async () => {
  const id = `mcp-distribution-${Date.now()}`;
  const scope = { tenantId: 'test', projectId: 'distribution' };
  try {
    const first = inspectMCPServer({
      id,
      ...scope,
      transport: 'stdio',
      command: process.execPath,
      args: ['fixture-a.js'],
      sourceUri: 'catalog:test/fixture@1',
      toolPolicy: { allow: ['read'], deny: ['write'], riskLevel: 'L0' },
    });
    const created = await upsertMCPServer(first.normalized);
    assert.equal(created.enabled, false);
    assert.equal(created.versionHash, first.versionHash);
    assert.equal(created.sourceUri, 'catalog:test/fixture@1');

    await pinMCPServerVersion(id, scope.tenantId, scope.projectId);
    const second = inspectMCPServer({
      id,
      ...scope,
      transport: 'stdio',
      command: process.execPath,
      args: ['fixture-b.js'],
      sourceUri: 'catalog:test/fixture@2',
    });
    await assert.rejects(() => upsertMCPServer(second.normalized), /pinned to version/);
    await unpinMCPServerVersion(id, scope.tenantId, scope.projectId);
    await upsertMCPServer(second.normalized);
    assert.equal((await listMCPServerVersions(id, scope.tenantId, scope.projectId)).length, 2);

    const rolledBack = await rollbackMCPServerVersion(id, first.versionHash, scope.tenantId, scope.projectId);
    assert.equal(rolledBack.versionHash, first.versionHash);
    assert.equal(rolledBack.enabled, false);
    await assert.rejects(() => setMCPServerEnabled(id, true, scope.tenantId, scope.projectId), /status is unverified/);
    await updateMCPServerStatus(id, { status: 'connected' }, scope.tenantId, scope.projectId);
    const enabled = await setMCPServerEnabled(id, true, scope.tenantId, scope.projectId);
    assert.equal(mcpServerExecutionBlocker(enabled), undefined);
  } finally {
    await deleteMCPServer(id, scope.tenantId, scope.projectId);
  }
});

test('MCP auth and tool policy are separate fail-closed controls', () => {
  const oauth = inspectMCPServer({
    id: 'oauth-fixture',
    transport: 'streamable-http',
    url: 'https://example.invalid/mcp',
    authConfig: { mode: 'oauth', credentialRef: 'vault:mcp/example' },
    toolPolicy: { allow: ['read'], deny: ['delete'], riskLevel: 'L0' },
  });
  assert.equal(oauth.executionSupported, false);
  assert.match(oauth.blockers.join(' '), /oauth/);
  const policy = normalizeMCPToolPolicy(oauth.normalized.toolPolicy);
  assert.equal(isMCPToolAllowed(policy, 'read'), true);
  assert.equal(isMCPToolAllowed(policy, 'delete'), false);
  assert.equal(isMCPToolAllowed(policy, 'other'), false);
});

test('CanTool inspect fixes the local adapter identity and narrows policy to reviewed L0 capabilities', () => {
  const inspection = inspectMCPServer({
    id: 'cantool-local',
    transport: 'stdio',
    command: '/Applications/CanTool.app/Contents/MacOS/cantool',
    args: ['--mcp-server'],
    adapterConfig: { kind: 'cantool', providerId: 'cantool.mcp.local', providerLocation: 'local', dataGrantOwner: 'cantool', sessionBinding: 'per_call' },
  });
  assert.equal(inspection.normalized.adapterConfig?.kind, 'cantool');
  assert.equal(inspection.normalized.toolPolicy?.riskLevel, 'L0');
  assert.equal(inspection.normalized.toolPolicy?.allow.includes('calculator.evaluate'), true);
  assert.equal(inspection.normalized.toolPolicy?.allow.includes('snippet.search'), false);

  assert.throws(() => inspectMCPServer({
    id: 'cantool-private',
    transport: 'stdio',
    command: 'cantool',
    adapterConfig: { kind: 'cantool', providerId: 'cantool.mcp.local', providerLocation: 'local', dataGrantOwner: 'cantool', sessionBinding: 'per_call' },
    toolPolicy: { allow: ['snippet.search'], deny: [], riskLevel: 'L0' },
  }), /unreviewed capabilities/);
});
