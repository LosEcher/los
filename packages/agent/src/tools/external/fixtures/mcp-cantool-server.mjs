import { createInterface } from 'node:readline';

const annotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
const tools = [
  { name: 'calculator.evaluate', description: 'Reviewed calculator', inputSchema: { type: 'object' }, annotations },
  { name: 'snippet.search', description: 'Private snippets', inputSchema: { type: 'object' }, annotations },
  { name: 'future.local.read', description: 'Unreviewed local data', inputSchema: { type: 'object' }, annotations },
];

const lines = createInterface({ input: process.stdin });
lines.on('line', line => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  if (message.method === 'initialize') {
    respond(message.id, {
      protocolVersion: '2025-11-25',
      capabilities: { tools: {} },
      serverInfo: { name: 'cantool', version: 'fixture' },
    });
    return;
  }
  if (message.method === 'tools/list') {
    respond(message.id, { tools });
    return;
  }
  if (message.method === 'tools/call') {
    respond(message.id, {
      content: [{ type: 'text', text: JSON.stringify({ tool: message.params?.name }) }],
    });
    return;
  }
  respond(message.id, { error: { code: -32601, message: 'method not found' } });
});

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}
