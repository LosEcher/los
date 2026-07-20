import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createToolRegistry, registerBuiltinTools } from '../core/registry.js';
import { MCPClient } from './mcp-client.js';
import { normalizeMCPAdapterConfig } from '../../cantool-capability-adapter.js';

const fixture = fileURLToPath(new URL('./fixtures/mcp-echo-server.mjs', import.meta.url));
const cancelFixture = fileURLToPath(new URL('./fixtures/mcp-cancel-server.mjs', import.meta.url));
const cantoolFixture = fileURLToPath(new URL('./fixtures/mcp-cantool-server.mjs', import.meta.url));

test('stdio MCP performs handshake, discovery, and tool call', async () => {
  const client = new MCPClient({ command: process.execPath, args: [fixture] });
  try {
    await client.connect();
    assert.deepEqual(client.getTools().map(tool => tool.name), ['fixture_read', 'fixture_write']);
    assert.deepEqual(JSON.parse(await client.callTool('fixture_read', { value: 'ok' })), {
      tool: 'fixture_read',
      arguments: { value: 'ok' },
    });
  } finally {
    await client.close();
  }
});

test('registry MCP tool policy filters denied and non-allowed tools', async () => {
  const registry = createToolRegistry();
  const cleanup = await registerBuiltinTools(registry, {
    mcpRegistryRecords: [{
      id: 'fixture',
      command: process.execPath,
      args: [fixture],
      env: {},
      toolPolicy: { allow: ['fixture_read'], deny: ['fixture_write'], riskLevel: 'L0' },
    }],
  });
  try {
    assert.equal(registry.list().includes('fixture_read'), true);
    assert.equal(registry.list().includes('fixture_write'), false);
    assert.equal(registry.getCapability('fixture_read')?.riskLevel, 'L0');
    const result = await registry.execute({ name: 'fixture_read', arguments: { value: 'policy-ok' } });
    assert.equal(result.error, undefined);
    assert.equal(JSON.parse(result.content).arguments.value, 'policy-ok');
  } finally {
    await cleanup();
  }
});

test('MCP cancellation notifies the server, discards late results, and allows a fresh call', async () => {
  const client = new MCPClient({ command: process.execPath, args: [cancelFixture] });
  try {
    await client.connect();
    const controller = new AbortController();
    const pending = client.callTool('delayed_read', {}, { signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    await assert.rejects(pending, /MCP request cancelled/);
    await new Promise(resolve => setTimeout(resolve, 160));
    assert.equal(await client.callTool('cancel_count', {}), '1');
  } finally {
    await client.close();
  }
});

test('CanTool runtime projection blocks private and unreviewed tools even when registry policy is too broad', async () => {
  const registry = createToolRegistry();
  const cleanup = await registerBuiltinTools(registry, {
    mcpRegistryRecords: [{
      id: 'cantool-fixture',
      command: process.execPath,
      args: [cantoolFixture],
      env: {},
      toolPolicy: {
        allow: ['calculator.evaluate', 'snippet.search', 'future.local.read'],
        deny: [],
        riskLevel: 'L0',
      },
      adapterConfig: normalizeMCPAdapterConfig({ kind: 'cantool' }),
    }],
  });
  try {
    assert.equal(registry.list().includes('calculator.evaluate'), true);
    assert.equal(registry.list().includes('snippet.search'), false);
    assert.equal(registry.list().includes('future.local.read'), false);
    assert.equal(registry.getCapability('calculator.evaluate')?.sideEffect, false);
    assert.equal(registry.getCapability('calculator.evaluate')?.idempotent, true);
  } finally {
    await cleanup();
  }
});
