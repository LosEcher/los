/**
 * Leaf stdio MCP client tests.
 *
 * The server fixture is an inline `node -e` script so this package stays
 * self-contained: no fixture files, no dependency on `@los/agent`, no network.
 *
 * Run: pnpm --filter @los/mcp-stdio test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MCPStdioClient, MCP_PROTOCOL_VERSION } from './client.js';

/** Minimal MCP stdio server: initialize handshake, tools/list, tools/call. */
const SERVER_SOURCE = `
let buf = '';
process.stdin.on('data', chunk => {
  buf += chunk.toString('utf-8');
  const lines = buf.split('\\n');
  buf = lines.pop() ?? '';
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const msg = JSON.parse(trimmed);
    if (msg.id === undefined) continue;
    const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\\n');
    if (msg.method === 'initialize') {
      reply({ protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'leaf-fixture', version: '9.9.9' } });
    } else if (msg.method === 'tools/list') {
      reply({ tools: [
        { name: 'echo', description: 'Echo the input', inputSchema: { type: 'object' } },
        { name: 'no_schema' }
      ] });
    } else if (msg.method === 'tools/call') {
      if (msg.params.name === 'boom') {
        reply({ content: [{ type: 'text', text: 'tool blew up' }], isError: true });
      } else {
        reply({ content: [{ type: 'text', text: JSON.stringify(msg.params.arguments) }] });
      }
    } else {
      reply({});
    }
  }
});
`;

function inlineServer(): { command: string; args: string[] } {
  return { command: process.execPath, args: ['-e', SERVER_SOURCE] };
}

test('connects over stdio, exposes the handshake identity and tools', async () => {
  const client = new MCPStdioClient(inlineServer());
  try {
    await client.connect();
    assert.deepEqual(client.getServerIdentity(), {
      name: 'leaf-fixture',
      version: '9.9.9',
      protocolVersion: MCP_PROTOCOL_VERSION,
    });
    const tools = client.getTools();
    assert.deepEqual(tools.map(t => t.name), ['echo', 'no_schema']);
    // NEGATIVE CONTROL: a server that omits inputSchema must not leave the field
    // undefined for consumers — the leaf normalises it to an empty schema.
    assert.deepEqual(tools.find(t => t.name === 'no_schema')?.inputSchema, {});
  } finally {
    await client.close();
  }
});

test('callTool returns the joined text content', async () => {
  const client = new MCPStdioClient(inlineServer());
  try {
    await client.connect();
    const text = await client.callTool('echo', { hello: 'world' });
    assert.equal(text, JSON.stringify({ hello: 'world' }));
  } finally {
    await client.close();
  }
});

test('NEGATIVE CONTROL: an isError tool result throws instead of returning text', async () => {
  const client = new MCPStdioClient(inlineServer());
  try {
    await client.connect();
    await assert.rejects(() => client.callTool('boom', {}), /MCP tool error \[boom\]: tool blew up/);
  } finally {
    await client.close();
  }
});

test('NEGATIVE CONTROL: callTool before connect is refused', async () => {
  const client = new MCPStdioClient(inlineServer());
  await assert.rejects(() => client.callTool('echo', {}), /MCP client not initialized/);
  await client.close();
});

test('NEGATIVE CONTROL: a config without a command is rejected up front', () => {
  assert.throws(
    () => new MCPStdioClient({ command: '' } as unknown as { command: string }),
    /MCP stdio transport requires a command/,
  );
});

test('an aborted signal cancels the request', async () => {
  const client = new MCPStdioClient(inlineServer());
  try {
    await client.connect();
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      () => client.callTool('echo', {}, { signal: controller.signal }),
      /MCP request cancelled/,
    );
  } finally {
    await client.close();
  }
});
