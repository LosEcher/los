import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

type SendJson = (res: ServerResponse, status: number, body: unknown) => void;
type ReadJson = <T>(req: IncomingMessage) => Promise<T>;

interface StatelessArtifact {
  artifactId: string;
  nodeId: string;
  path?: string;
  pathPolicy: string;
  contentType: string;
  sizeBytes: number;
  checksum: string;
  checksumAlgorithm: 'sha256';
  metadata: Record<string, unknown>;
  createdAt: string;
}

/**
 * File-backed artifact store for `EXECUTOR_DB_MODE=none`.
 *
 * No DB, no in-memory-only state: each artifact is `<root>/<id>.bin` plus
 * `<root>/<id>.json`. This keeps restart behavior and lets the gateway relay
 * use the same `/v1/artifacts` shape as DB-backed executors.
 */
export async function handleStatelessArtifactRoute(
  req: IncomingMessage,
  res: ServerResponse,
  route: URL,
  nodeId: string,
  storageRoot: string,
  readJson: ReadJson,
  sendJson: SendJson,
): Promise<void> {
  const root = resolve(storageRoot);
  await mkdir(root, { recursive: true });
  const prefix = '/v1/artifacts';
  if (!route.pathname.startsWith(prefix)) return sendJson(res, 404, { error: 'not found' });
  const rest = route.pathname.slice(prefix.length).replace(/^\/+/, '');
  const [rawId, tail] = rest.split('/');
  const artifactId = rawId ? decodeURIComponent(rawId) : undefined;
  if (artifactId && !/^[A-Za-z0-9._-]+$/.test(artifactId)) {
    return sendJson(res, 400, { error: 'invalid artifact id' });
  }

  if (req.method === 'GET' && !artifactId) {
    const files = (await readdir(root)).filter(name => name.endsWith('.json'));
    const records = await Promise.all(files.map(async name => JSON.parse(await readFile(join(root, name), 'utf8')) as StatelessArtifact));
    return sendJson(res, 200, records);
  }
  if (req.method === 'POST' && !artifactId) {
    const body = await readJson<Record<string, unknown>>(req);
    const id = typeof body.artifactId === 'string' && body.artifactId ? body.artifactId : `artifact-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    if (!/^[A-Za-z0-9._-]+$/.test(id)) return sendJson(res, 400, { error: 'invalid artifact id' });
    const content = typeof body.content === 'string'
      ? Buffer.from(body.content, body.encoding === 'base64' ? 'base64' : 'utf8')
      : null;
    if (!content) return sendJson(res, 422, { error: 'content is required' });
    const checksum = createHash('sha256').update(content).digest('hex');
    const record: StatelessArtifact = {
      artifactId: id,
      nodeId,
      path: typeof body.path === 'string' ? body.path : undefined,
      pathPolicy: typeof body.pathPolicy === 'string' ? body.pathPolicy : 'artifact-store',
      contentType: typeof body.contentType === 'string' ? body.contentType : 'application/octet-stream',
      sizeBytes: content.byteLength,
      checksum,
      checksumAlgorithm: 'sha256',
      metadata: body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata) ? body.metadata as Record<string, unknown> : {},
      createdAt: new Date().toISOString(),
    };
    await writeFile(join(root, `${id}.bin`), content);
    await writeFile(join(root, `${id}.json`), JSON.stringify(record, null, 2), 'utf8');
    return sendJson(res, 201, { ok: true, artifact: record });
  }
  if (!artifactId) return sendJson(res, 405, { error: 'method not allowed' });

  const metaPath = join(root, `${artifactId}.json`);
  const binPath = join(root, `${artifactId}.bin`);
  let record: StatelessArtifact;
  try {
    record = JSON.parse(await readFile(metaPath, 'utf8')) as StatelessArtifact;
  } catch {
    return sendJson(res, 404, { error: 'artifact not found' });
  }

  if (req.method === 'GET' && !tail) return sendJson(res, 200, record);
  if (req.method === 'GET' && tail === 'content') {
    const content = await readFile(binPath);
    res.writeHead(200, {
      'content-type': record.contentType,
      'x-artifact-id': record.artifactId,
      'x-artifact-checksum': record.checksum,
    });
    return void res.end(content);
  }
  if (req.method === 'DELETE' && !tail) {
    await rm(binPath, { force: true });
    await rm(metaPath, { force: true });
    return sendJson(res, 200, { ok: true, artifactId });
  }
  return sendJson(res, 404, { error: 'not found' });
}
