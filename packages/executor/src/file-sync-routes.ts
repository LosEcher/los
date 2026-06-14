// File-sync HTTP handler for the executor HTTP server.
// Extracted from index.ts to keep it under 600 lines.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { createScanner, createFileSyncStore } from './file-sync/index.js';

export async function handleFileSyncRoute(
  req: IncomingMessage,
  res: ServerResponse,
  route: URL,
  nodeId: string,
  readJson: <T>(req: IncomingMessage) => Promise<T>,
  normalizeOptionalString: (value: unknown) => string | undefined,
  normalizePositiveInteger: (value: unknown) => number | undefined,
  sendJson: (res: ServerResponse, status: number, data: unknown) => void,
): Promise<void> {
  const store = createFileSyncStore();
  const scanner = createScanner(store, nodeId);

  if (req.method === 'POST' && route.pathname === '/v1/file-sync/scan') {
    const body = await readJson<{ folder: string; path?: string; mode?: 'full' | 'incremental' }>(req);
    const folder = normalizeOptionalString(body.folder) ?? 'default';
    const localPath = normalizeOptionalString(body.path) ?? resolve(process.cwd(), folder);
    const result = await scanner.scanFolder(folder, localPath, body.mode === 'incremental' ? 'incremental' : 'full');
    sendJson(res, 200, { ok: true, scan: result });
    return;
  }

  if (req.method === 'POST' && route.pathname === '/v1/file-sync/deep-verify') {
    const body = await readJson<{ folder: string; path?: string; sha256?: boolean }>(req);
    const folder = normalizeOptionalString(body.folder) ?? 'default';
    const localPath = normalizeOptionalString(body.path) ?? resolve(process.cwd(), folder);
    const result = await scanner.deepVerify(folder, localPath, body.sha256 !== false);
    sendJson(res, 200, { ok: true, scan: result });
    return;
  }

  if (req.method === 'GET' && route.pathname === '/v1/file-sync/status') {
    const stats = await store.getAllFolderStats();
    sendJson(res, 200, { ok: true, nodeId, folders: stats.filter((s: { nodeId: string }) => s.nodeId === nodeId) });
    return;
  }

  if (req.method === 'GET' && route.pathname === '/v1/file-sync/events') {
    const limit = normalizePositiveInteger(route.searchParams.get('limit')) ?? 50;
    const events = await store.recentEvents(limit);
    sendJson(res, 200, { ok: true, events });
    return;
  }

  sendJson(res, 404, { error: 'not found' });
}
