import { createInterface } from 'node:readline';

const tools = [
  { name: 'fixture_read', description: 'Echo a value', inputSchema: { type: 'object', properties: { value: { type: 'string' } } } },
  { name: 'fixture_write', description: 'Simulated write', inputSchema: { type: 'object', properties: {} } },
];

const lines = createInterface({ input: process.stdin });
lines.on('line', line => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  let result;
  if (message.method === 'initialize') {
    result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'los-mcp-fixture', version: '1.0.0' } };
  } else if (message.method === 'tools/list') {
    result = { tools };
  } else if (message.method === 'tools/call') {
    result = { content: [{ type: 'text', text: JSON.stringify({ tool: message.params?.name, arguments: message.params?.arguments ?? {} }) }] };
  } else {
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'method not found' } })}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`);
});
