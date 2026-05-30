import { createConnection } from 'node:net';
import type { FastifyInstance } from 'fastify';
import {
  ensureExecutorNodeStore,
  loadExecutorNode,
  listExecutorNodes,
  recordExecutorNodeProbe,
  upsertExecutorNode,
  type ExecutorNodeConnectMode,
  type ExecutorNodeKind,
  type ExecutorNodeRecord,
  type ExecutorNodeRolloutState,
  type ExecutorNodeStatus,
} from '@los/agent/executor-nodes';
import { buildSshImportItems } from './ssh-config-import.js';

type NodeEditorBody = {
  nodeKind?: ExecutorNodeKind;
  baseUrl?: string;
  hostLabel?: string;
  status?: ExecutorNodeStatus;
  version?: string;
  targetVersion?: string;
  rolloutState?: ExecutorNodeRolloutState;
  rolloutMessage?: string;
  connectModes?: ExecutorNodeConnectMode[] | string;
  connectConfig?: Record<string, unknown>;
  capacity?: Record<string, unknown>;
  capabilities?: Record<string, unknown>;
  verified?: Record<string, unknown>;
  queueDepth?: number;
  activeTaskCount?: number;
  meshLinks?: Array<Record<string, unknown>>;
};

type SshImportRequestBody = {
  content?: string;
  dryRun?: boolean;
  createMissing?: boolean;
  conflictStrategy?: 'preserve_existing' | 'overwrite';
};

const PROBE_TIMEOUT_MS = 3_000;

export function registerNodeRoutes(app: FastifyInstance): void {
  app.get('/nodes', async () => {
    await ensureExecutorNodeStore();
    return await listExecutorNodes();
  });

  app.patch('/nodes/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as NodeEditorBody | undefined;
    const nodeId = normalizeOptionalString(id);
    if (!nodeId) return reply.status(400).send({ error: 'node id is required' });

    await ensureExecutorNodeStore();
    const node = await upsertExecutorNode({
      nodeId,
      nodeKind: normalizeNodeKind(body?.nodeKind),
      baseUrl: normalizeOptionalString(body?.baseUrl),
      hostLabel: normalizeOptionalString(body?.hostLabel),
      status: hasField(body, 'status') ? normalizeNodeStatus(body?.status) : undefined,
      version: normalizeOptionalString(body?.version),
      targetVersion: normalizeOptionalString(body?.targetVersion),
      rolloutState: hasField(body, 'rolloutState') ? normalizeRolloutState(body?.rolloutState) : undefined,
      rolloutMessage: normalizeOptionalString(body?.rolloutMessage),
      connectModes: hasField(body, 'connectModes') ? normalizeConnectModes(body?.connectModes) : undefined,
      connectConfig: hasField(body, 'connectConfig') ? normalizeJsonObject(body?.connectConfig) : undefined,
      capacity: hasField(body, 'capacity') ? normalizeJsonObject(body?.capacity) : undefined,
      capabilities: hasField(body, 'capabilities') ? normalizeJsonObject(body?.capabilities) : undefined,
      verified: hasField(body, 'verified') ? normalizeJsonObject(body?.verified) : undefined,
      queueDepth: hasField(body, 'queueDepth') ? normalizeInteger(body?.queueDepth) : undefined,
      activeTaskCount: hasField(body, 'activeTaskCount') ? normalizeInteger(body?.activeTaskCount) : undefined,
      meshLinks: hasField(body, 'meshLinks') ? normalizeJsonArray(body?.meshLinks) : undefined,
    });
    return { ok: true, node };
  });

  app.post('/nodes/:id/probe', async (req, reply) => {
    const { id } = req.params as { id: string };
    const nodeId = normalizeOptionalString(id);
    if (!nodeId) return reply.status(400).send({ error: 'node id is required' });

    await ensureExecutorNodeStore();
    const existing = await loadExecutorNode(nodeId);
    if (!existing) return reply.status(404).send({ error: 'Not found' });

    const result = await probeNode(existing);
    const saved = await recordExecutorNodeProbe({
      nodeId,
      status: result.status,
      verified: result.verified,
      connectModes: existing.connectModes as ExecutorNodeConnectMode[],
      connectConfig: existing.connectConfig,
      capabilities: existing.capabilities,
      queueDepth: existing.queueDepth,
      activeTaskCount: existing.activeTaskCount,
      meshLinks: existing.meshLinks,
      lastProbeAt: new Date(),
      lastProbeError: result.lastProbeError ?? null,
    });

    return {
      ok: true,
      node: saved,
      probe: result,
    };
  });

  app.post('/nodes/import-ssh-config', async (req, reply) => {
    const body = req.body as SshImportRequestBody | undefined;
    const content = normalizeOptionalString(body?.content);
    if (!content) return reply.status(422).send({ error: 'content is required' });

    const dryRun = body?.dryRun !== false;
    const createMissing = body?.createMissing !== false;
    const conflictStrategy = body?.conflictStrategy === 'overwrite' ? 'overwrite' : 'preserve_existing';

    await ensureExecutorNodeStore();
    const existingNodes = await listExecutorNodes(1000);
    const existingById = new Map(existingNodes.map(node => [node.nodeId, node]));
    const items = buildSshImportItems(content, new Set(existingById.keys()), { dryRun, createMissing });

    const appliedItems = [];
    let created = 0;
    let updated = 0;
    let skipped = 0;
    let failed = 0;

    for (const item of items) {
      if (item.action === 'error') {
        failed += 1;
        appliedItems.push(item);
        continue;
      }
      if (item.action === 'skip_no_match') {
        skipped += 1;
        appliedItems.push(item);
        continue;
      }
      if (dryRun) {
        appliedItems.push(item);
        if (item.action === 'create') created += 1;
        if (item.action === 'update') updated += 1;
        continue;
      }

      const draft = item.node;
      if (!draft) {
        failed += 1;
        appliedItems.push({ ...item, action: 'error', error: 'missing node draft' });
        continue;
      }

      const existing = existingById.get(draft.nodeId);
      const payload = mergeImportPayload(existing, draft, conflictStrategy);
      const saved = await upsertExecutorNode({
        nodeId: draft.nodeId,
        nodeKind: payload.nodeKind,
        baseUrl: payload.baseUrl,
        hostLabel: payload.hostLabel,
        status: payload.status,
        version: payload.version,
        connectModes: payload.connectModes,
        connectConfig: payload.connectConfig,
        capacity: payload.capacity,
        capabilities: payload.capabilities,
        verified: existing?.verified ?? {},
        queueDepth: existing?.queueDepth ?? 0,
        activeTaskCount: existing?.activeTaskCount ?? 0,
        meshLinks: payload.meshLinks,
      });
      existingById.set(saved.nodeId, saved);
      appliedItems.push({
        ...item,
        matchedNodeId: existing?.nodeId,
        node: draft,
        willWrite: true,
      });
      if (existing) updated += 1;
      else created += 1;
    }

    return {
      ok: true,
      dryRun,
      conflictStrategy,
      summary: { created, updated, skipped, failed, total: items.length },
      items: appliedItems,
    };
  });
}

async function probeNode(node: ExecutorNodeRecord): Promise<{
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

async function probeMode(
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

function resolveEndpoint(node: ExecutorNodeRecord, mode: ExecutorNodeConnectMode, config: Record<string, unknown>): string | undefined {
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

function parseSocketEndpoint(raw: string): { host: string; port: number } | null {
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

function probeTcp(host: string, port: number): Promise<void> {
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

async function fetchHealth(url: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    return await fetch(url, { method: 'GET', signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function normalizeConnectModes(value: unknown): ExecutorNodeConnectMode[] {
  if (Array.isArray(value)) {
    return value.map(item => readString(item)).filter((item): item is ExecutorNodeConnectMode => Boolean(item));
  }
  if (typeof value === 'string') {
    return value.split(',').map(item => readString(item)).filter((item): item is ExecutorNodeConnectMode => Boolean(item));
  }
  return [];
}

function normalizeJsonObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function normalizeJsonArray(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value
    .map(item => (item && typeof item === 'object' && !Array.isArray(item) ? item as Record<string, unknown> : null))
    .filter((item): item is Record<string, unknown> => Boolean(item));
}

function normalizeNodeKind(value: unknown): ExecutorNodeKind {
  if (value === 'ssh_target' || value === 'ingress' || value === 'proxy') return value;
  return 'executor';
}

function normalizeNodeStatus(value: unknown): ExecutorNodeStatus {
  if (value === 'draining' || value === 'offline') return value;
  return 'online';
}

function normalizeRolloutState(value: unknown): ExecutorNodeRolloutState | undefined {
  if (value === 'idle' || value === 'draining' || value === 'upgrading' || value === 'verifying' || value === 'failed') {
    return value;
  }
  return undefined;
}

function normalizeInteger(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.floor(value));
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.max(0, Math.floor(parsed));
  }
  return 0;
}

function readString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function readInteger(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.floor(value);
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.floor(parsed);
  }
  return undefined;
}

function normalizeOptionalString(value: unknown): string | undefined {
  return readString(value);
}

function hasField<T extends object>(value: T | undefined, key: keyof T): value is T {
  return Boolean(value && Object.prototype.hasOwnProperty.call(value, key));
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function mergeImportPayload(
  existing: ExecutorNodeRecord | undefined,
  draft: {
    nodeId: string;
    nodeKind: ExecutorNodeKind;
    status: ExecutorNodeStatus;
    hostLabel: string;
    connectModes: ExecutorNodeConnectMode[];
    connectConfig: Record<string, unknown>;
    capabilities: Record<string, unknown>;
    capacity: Record<string, unknown>;
    meshLinks: Array<Record<string, unknown>>;
  },
  conflictStrategy: 'preserve_existing' | 'overwrite',
): {
  nodeKind: ExecutorNodeKind;
  status: ExecutorNodeStatus;
  hostLabel?: string;
  baseUrl?: string;
  version?: string;
  connectModes: ExecutorNodeConnectMode[];
  connectConfig: Record<string, unknown>;
  capabilities: Record<string, unknown>;
  capacity: Record<string, unknown>;
  meshLinks: Array<Record<string, unknown>>;
} {
  if (!existing || conflictStrategy === 'overwrite') {
    return {
      nodeKind: draft.nodeKind,
      status: draft.status,
      hostLabel: draft.hostLabel,
      connectModes: draft.connectModes,
      connectConfig: draft.connectConfig,
      capabilities: draft.capabilities,
      capacity: draft.capacity,
      meshLinks: draft.meshLinks,
      baseUrl: existing?.baseUrl,
      version: existing?.version,
    };
  }

  return {
    nodeKind: existing.nodeKind,
    status: existing.status,
    hostLabel: existing.hostLabel ?? draft.hostLabel,
    connectModes: existing.connectModes.length ? (existing.connectModes as ExecutorNodeConnectMode[]) : draft.connectModes,
    connectConfig: { ...draft.connectConfig, ...existing.connectConfig },
    capabilities: { ...draft.capabilities, ...existing.capabilities },
    capacity: { ...draft.capacity, ...existing.capacity },
    meshLinks: existing.meshLinks.length ? existing.meshLinks : draft.meshLinks,
    baseUrl: existing.baseUrl,
    version: existing.version,
  };
}
