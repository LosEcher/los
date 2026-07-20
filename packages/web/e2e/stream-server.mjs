import { createServer } from 'node:http';

const server = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
    return;
  }
  if (req.method !== 'POST' || req.url !== '/chat') {
    res.writeHead(404);
    res.end();
    return;
  }

  let raw = '';
  req.setEncoding('utf8');
  req.on('data', chunk => { raw += chunk; });
  req.on('end', () => {
    const payload = JSON.parse(raw);
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    send(res, 'session', { sessionId: 'session-e2e', taskRunId: 'task-e2e' });

    if (payload.prompt === 'keep running until cancelled') {
      const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 250);
      res.on('close', () => clearInterval(heartbeat));
      return;
    }

    setTimeout(() => {
      send(res, 'tool.denied', {
        taskRunId: 'task-e2e',
        callId: 'call-e2e',
        toolName: 'write_file',
        argsPreview: '{"path":"README.md"}',
        reason: 'operator approval required',
        capability: 'project-write',
      });
      send(res, 'done', { taskRunId: 'task-e2e', message: 'completed' });
      res.end();
    }, 50);
  });
});

function send(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

server.listen(4180, '127.0.0.1');

function shutdown() {
  server.close(() => process.exit(0));
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
