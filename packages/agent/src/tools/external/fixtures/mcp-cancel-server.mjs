import { createInterface } from 'node:readline';

let cancelled = 0;
const lines = createInterface({ input: process.stdin });

lines.on('line', line => {
  const message = JSON.parse(line);
  if (message.method === 'notifications/cancelled') {
    cancelled += 1;
    return;
  }
  if (message.id === undefined) return;

  if (message.method === 'initialize') {
    respond(message.id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'los-mcp-cancel-fixture', version: '1.0.0' },
    });
    return;
  }
  if (message.method === 'tools/list') {
    respond(message.id, {
      tools: [
        { name: 'delayed_read', description: 'Return after a delay', inputSchema: { type: 'object' } },
        { name: 'cancel_count', description: 'Return observed cancellations', inputSchema: { type: 'object' } },
      ],
    });
    return;
  }
  if (message.method === 'tools/call' && message.params?.name === 'delayed_read') {
    setTimeout(() => respond(message.id, {
      content: [{ type: 'text', text: JSON.stringify({ late: true }) }],
    }), 120);
    return;
  }
  if (message.method === 'tools/call' && message.params?.name === 'cancel_count') {
    respond(message.id, { content: [{ type: 'text', text: String(cancelled) }] });
    return;
  }
  respondError(message.id, 'method not found');
});

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}

function respondError(id, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message } })}\n`);
}
