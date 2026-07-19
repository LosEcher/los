import { createServer, type Server } from 'node:http';

export interface TelegramHealthSnapshot {
  ready: boolean;
  sseConnected: boolean;
  telegramConnected: boolean;
  mode: 'polling' | 'webhook';
}

export interface TelegramHealthServer {
  url: string;
  close(): Promise<void>;
}

export async function startTelegramHealthServer(options: {
  port: number;
  host?: string;
  getSnapshot: () => TelegramHealthSnapshot;
}): Promise<TelegramHealthServer> {
  const host = options.host ?? '127.0.0.1';
  const startedAt = Date.now();
  const server = createServer((request, response) => {
    if (request.method !== 'GET' || request.url?.split('?')[0] !== '/health') {
      response.writeHead(404).end('Not found');
      return;
    }

    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({
      status: 'ok',
      service: 'telegram-bot',
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      ...options.getSnapshot(),
    }));
  });

  await listen(server, options.port, host);
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : options.port;
  return {
    url: `http://${host}:${port}`,
    close: () => close(server),
  };
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  });
}
