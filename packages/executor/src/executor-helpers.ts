import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ArtifactPathPolicy, NodeCommandName } from '@los/agent';

export function readJson<T>(req: IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf-8').trim();
        resolve(JSON.parse(raw) as T);
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

export function readOptionalJson<T extends Record<string, unknown>>(req: IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf-8').trim();
        resolve((raw ? JSON.parse(raw) : {}) as T);
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

export function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

export function normalizeRequiredString(value: unknown, name: string): string {
  const normalized = normalizeOptionalString(value);
  if (!normalized) throw new Error(`${name} is required`);
  return normalized;
}

export function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

export function normalizeJsonObject(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  return undefined;
}

export function normalizePositiveInteger(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(parsed)) return undefined;
  const integer = Math.floor(parsed);
  return integer > 0 ? integer : undefined;
}

export function normalizeLeaseMs(value: unknown, defaultMs: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return defaultMs;
  return Math.max(1_000, Math.min(Math.floor(value), 10 * 60_000));
}

export function normalizePathPolicy(value: unknown): ArtifactPathPolicy | undefined {
  if (value === 'workspace-relative' || value === 'artifact-store' || value === 'read-only-export') return value;
  return undefined;
}

export function normalizeNodeCommand(value: unknown): NodeCommandName | undefined {
  if (value === 'status' || value === 'probe' || value === 'drain' || value === 'promote' || value === 'restart' || value === 'upgrade' || value === 'rollback') {
    return value;
  }
  return undefined;
}

export function createAbortError(reason: string): Error {
  const err = new Error(reason);
  err.name = 'AbortError';
  return err;
}

export function acceptsNdjson(req: IncomingMessage): boolean {
  const accept = req.headers.accept;
  const raw = Array.isArray(accept) ? accept.join(',') : accept ?? '';
  return raw.includes('application/x-ndjson');
}
