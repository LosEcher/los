import { createConnection } from 'node:net';
import type {
  ExecutorNodeConnectMode,
  ExecutorNodeRecord,
  ExecutorNodeStatus,
} from '@los/agent/executor-nodes';

export const PROBE_TIMEOUT_MS = 3_000;

export async function probeNode(node: ExecutorNodeRecord): Promise<{
  status: ExecutorNodeStatus;
  verified: Record<string, unknown>;
  lastProbeError?: string;
}> {
  const modes = normalizeConnectModes(node.connectModes);
  const verified: Record<string, unknown> = {};
  let lastError: string | undefined;

  for (const mode of modes) {
    const probe = await probeMode(node, mode);
    if (probe.ok) {
      verified[mode] = {
        ok: true,
        checked_at: new Date().toISOString(),
        endpoint: probe.endpoint,
        kind: probe.kind,
      };
      return {
        status: 'online',
        verified,
      };
    }
    lastError = probe.error;
  }

  return {
    status: 'offline',
    verified,
    lastProbeError: lastError ?? 'probe failed',
  };
}

export async function probeMode(
  node: ExecutorNodeRecord,
  mode: ExecutorNodeConnectMode,
): Promise<{ ok: boolean; endpoint?: string; kind: string; error?: string }> {
  const config = normalizeJsonObject(node.connectConfig[mode]);
  const endpoint = resolveEndpoint(node, mode, config);

  if (mode === 'agent_http' || mode === 'agent_http_ndjson' || mode === 'http_health' || mode === 'cf_tunnel_http') {
    if (!endpoint) {
      return { ok: false, kind: 'http', error: `missing endpoint for ${mode}` };
    }
    try {
      const res = await fetchHealth(endpoint);
      if (res.ok) {
        return { ok: true, endpoint, kind: 'http' };
      }
      return { ok: false, endpoint, kind: 'http', error: `http ${res.status}` };
    } catch (error) {
      return { ok: false, endpoint, kind: 'http', error: errorMessage(error) };
    }
  }

  if (mode === 'direct_ssh' || mode === 'tailscale_ssh' || mode === 'tailscale_native_ssh' || mode === 'cf_tunnel_ssh' || mode === 'socks5') {
    if (!endpoint) {
      return { ok: false, kind: 'tcp', error: `missing endpoint for ${mode}` };
    }
    const socketEndpoint = parseSocketEndpoint(endpoint);
    if (!socketEndpoint) {
      return { ok: false, endpoint, kind: 'tcp', error: `invalid endpoint ${endpoint}` };
    }
    try {
      await probeTcp(socketEndpoint.host, socketEndpoint.port);
      return { ok: true, endpoint, kind: 'tcp' };
    } catch (error) {
      return { ok: false, endpoint, kind: 'tcp', error: errorMessage(error) };
    }
  }

  return { ok: false, endpoint, kind: 'unknown', error: `unsupported mode ${mode}` };
}

export function resolveEndpoint(node: ExecutorNodeRecord, mode: ExecutorNodeConnectMode, config: Record<string, unknown>): string | undefined {
  const explicit = readString(config.endpoint);
  if (explicit) return explicit;

  if (mode === 'http_health') {
    return readString(config.healthUrl) ?? readString(config.health_url) ?? readString(config.url) ?? node.baseUrl;
  }

  if (mode === 'agent_http' || mode === 'agent_http_ndjson') {
    const baseUrl = readString(config.baseUrl) ?? node.baseUrl;
    if (baseUrl) return `${baseUrl.replace(/\/+$/, '')}/health`;
  }

  if (mode === 'tailscale_native_ssh') {
    const host = readString(config.hostName) ?? readString(config.host_name) ?? node.baseUrl;
    const user = readString(config.user);
    if (host) return user ? `${user}@${host}` : host;
  }

  const address = readString(config.hostName) ?? readString(config.host_name) ?? node.baseUrl;
  const port = readInteger(config.port) ?? (mode === 'socks5' ? 1080 : 22);
  if (address) return `${address}:${port}`;

  return node.baseUrl ? `${node.baseUrl}` : undefined;
}

export function parseSocketEndpoint(raw: string): { host: string; port: number } | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      const defaultPort = url.protocol === 'https:' ? 443 : url.protocol === 'socks5:' ? 1080 : 80;
      return { host: url.hostname, port: readInteger(url.port) ?? defaultPort };
    } catch {
      return null;
    }
  }

  const withoutUser = trimmed.includes('@') ? trimmed.slice(trimmed.lastIndexOf('@') + 1) : trimmed;
  const lastColon = withoutUser.lastIndexOf(':');
  if (lastColon === -1) {
    const host = withoutUser.trim();
    return host ? { host, port: 22 } : null;
  }
  const host = withoutUser.slice(0, lastColon).trim();
  const port = Number(withoutUser.slice(lastColon + 1));
  if (!host || !Number.isFinite(port) || port <= 0) return null;
  return { host, port: Math.floor(port) };
}

export function probeTcp(host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host, port });
    const timer = setTimeout(() => {
      socket.destroy(new Error(`tcp timeout ${host}:${port}`));
    }, PROBE_TIMEOUT_MS);

    socket.once('connect', () => {
      clearTimeout(timer);
      socket.end();
      resolve();
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.once('close', () => clearTimeout(timer));
  });
}

export async function fetchHealth(url: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    return await fetch(url, { method: 'GET', signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export function normalizeConnectModes(value: unknown): ExecutorNodeConnectMode[] {
  if (Array.isArray(value)) {
    return value.map(item => readString(item)).filter((item): item is ExecutorNodeConnectMode => Boolean(item));
  }
  if (typeof value === 'string') {
    return value.split(',').map(item => readString(item)).filter((item): item is ExecutorNodeConnectMode => Boolean(item));
  }
  return [];
}

export function normalizeJsonObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

export function readString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

export function readInteger(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.floor(value);
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.floor(parsed);
  }
  return undefined;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
