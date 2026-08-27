import { createConnection } from 'node:net';
import type {
  ExecutorNodeConnectMode,
  ExecutorNodeRecord,
  ExecutorNodeStatus,
} from '@los/agent/executor-nodes';
import { runSshCommand } from '../ssh-command-runner.js';

export const PROBE_TIMEOUT_MS = 3_000;

/** SSH 探测的系统信息采集命令：连通标记 + hostname + uname（OS/arch）。
 * Windows 节点无 uname → 该行缺失被 coverage 诚实标记（B4），不伪造值。 */
const SSH_INFO_CMD = 'echo los-probe-ok && hostname && uname -s && uname -m';

export async function probeNode(node: ExecutorNodeRecord): Promise<{
  status: ExecutorNodeStatus;
  verified: Record<string, unknown>;
  lastProbeError?: string;
  /** B4 coverage honesty: which probe channels/fields could be read. */
  coverage?: {
    modes: Record<string, { ok: boolean; kind: string; detail?: string }>;
    system?: { hostname?: string; os?: string; arch?: string; unreadable: string[] };
  };
  /** B6 status transition detected against the node's previous status. */
  transition?: { from: ExecutorNodeStatus; to: ExecutorNodeStatus } | null;
}> {
  // Probe every declared connect mode. Candidate eligibility uses the preferred
  // mode (agent_http_ndjson over agent_http); short-circuiting on the first
  // success left preferred modes as verification:…:not_confirmed while status
  // looked healthy.
  const modes = normalizeConnectModes(node.connectModes);
  const verified: Record<string, unknown> = {};
  const modeCoverage: Record<string, { ok: boolean; kind: string; detail?: string }> = {};
  let lastError: string | undefined;
  let anyOk = false;
  const checkedAt = new Date().toISOString();

  // B4: merge system info from every successful SSH probe (dedupe by field).
  let system: { hostname?: string; os?: string; arch?: string } | undefined;
  const unreadable = new Set<string>();

  for (const mode of modes) {
    const probe = await probeMode(node, mode);
    modeCoverage[mode] = { ok: probe.ok, kind: probe.kind, detail: probe.error };
    if (probe.ok) {
      anyOk = true;
      verified[mode] = {
        ok: true,
        checked_at: checkedAt,
        source: 'probe',
        endpoint: probe.endpoint,
        kind: probe.kind,
      };
      if (probe.system) {
        if (probe.system.hostname) {
          system = { ...system, hostname: probe.system.hostname };
        } else {
          unreadable.add('hostname');
        }
        if (probe.system.os) {
          system = { ...system, os: probe.system.os };
        } else {
          unreadable.add('uname -s');
        }
        if (probe.system.arch) {
          system = { ...system, arch: probe.system.arch };
        } else {
          unreadable.add('uname -m');
        }
      }
      continue;
    }
    lastError = probe.error;
    verified[mode] = {
      ok: false,
      checked_at: checkedAt,
      source: 'probe',
      endpoint: probe.endpoint,
      kind: probe.kind,
      reason: probe.error ?? 'probe failed',
    };
  }

  // B4: coverage report — mark unreadable fields only when SSH probing happened
  // and the field stayed empty despite a successful connection.
  const sshModesProbed = modes.some((mode) => ['direct_ssh', 'tailscale_ssh', 'tailscale_native_ssh', 'cf_tunnel_ssh'].includes(mode));
  const coverage = {
    modes: modeCoverage,
    system: sshModesProbed
      ? {
          hostname: system?.hostname,
          os: system?.os,
          arch: system?.arch,
          unreadable: [...unreadable],
        }
      : undefined,
  };

  // B6: status transition vs the node's previous status (for eventization).
  const previousStatus = node.status;
  const resultStatus: ExecutorNodeStatus = anyOk ? 'online' : 'offline';
  const transition = previousStatus !== resultStatus ? { from: previousStatus, to: resultStatus } : null;

  if (anyOk) {
    return {
      status: 'online',
      verified,
      coverage,
      transition,
    };
  }

  return {
    status: 'offline',
    verified,
    lastProbeError: lastError ?? 'probe failed',
    coverage,
    transition,
  };
}

export async function probeMode(
  node: ExecutorNodeRecord,
  mode: ExecutorNodeConnectMode,
): Promise<{
  ok: boolean;
  endpoint?: string;
  kind: string;
  error?: string;
  /** B4: system info gathered by this probe (SSH modes), for coverage reporting. */
  system?: { hostname?: string; os?: string; arch?: string };
}> {
  // Prefer mode-specific config; agent_http_ndjson commonly inherits agent_http.
  const config = normalizeJsonObject(
    node.connectConfig[mode]
      ?? (mode === 'agent_http_ndjson' ? node.connectConfig.agent_http : undefined),
  );
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
    // For SSH modes, do a full SSH connection + echo test to verify
    // the transport, user, and key work (not just TCP reachable).
    if (mode === 'direct_ssh' || mode === 'tailscale_ssh' || mode === 'tailscale_native_ssh' || mode === 'cf_tunnel_ssh') {
      try {
        const result = await runSshCommand(node, {
          command: SSH_INFO_CMD,
          timeoutMs: PROBE_TIMEOUT_MS + 2_000,
        });
        if (result.connected && result.exitCode === 0) {
          const system = _parseSystemInfo(result.stdout ?? '');
          return {
            ok: true,
            endpoint,
            kind: 'ssh',
            system,
          };
        }
        return {
          ok: false, endpoint, kind: 'ssh',
          error: result.error ?? `ssh exit ${result.exitCode}: ${result.stderr}`,
        };
      } catch (error) {
        return { ok: false, endpoint, kind: 'ssh', error: errorMessage(error) };
      }
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

/**
 * B4 coverage honesty: parse the SSH_INFO_CMD output into hostname/os/arch.
 * Missing lines (e.g. Windows nodes without `uname`) yield undefined and are
 * reported as `unreadable` gaps rather than fabricated values — mirroring
 * mac-performance-monitor's unreadableProcessCount (read what you can, mark
 * the rest, never fake zeros).
 */
export function _parseSystemInfo(output: string): {
  hostname?: string;
  os?: string;
  arch?: string;
  unreadable: string[];
} {
  const lines = (output ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  // Line 0 = los-probe-ok marker; line 1 = hostname; 2 = uname -s; 3 = uname -m.
  const marker = lines.find((line) => line.includes('los-probe-ok'));
  const rest = marker === undefined ? lines : lines.slice(lines.indexOf(marker) + 1);
  const hostname = rest[0];
  const os = rest[1];
  const arch = rest[2];
  const unreadable: string[] = [];
  if (!hostname) unreadable.push('hostname');
  if (!os) unreadable.push('uname -s');
  if (!arch) unreadable.push('uname -m');
  return { hostname, os, arch, unreadable };
}
