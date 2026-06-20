import type { FastifyInstance } from 'fastify';
import {
  ensureExecutorNodeStore,
  loadExecutorNode,
  listExecutorNodes,
  recordExecutorNodeProbe,
  upsertExecutorNode,
  upsertExecutorNodeHeartbeat,
  type ExecutorNodeConnectMode,
  type ExecutorNodeKind,
  type ExecutorNodeRecord,
  type ExecutorNodeRolloutState,
  type ExecutorNodeStatus,
} from '@los/agent/executor-nodes';
import { buildSshImportItems } from '../../ssh-config-import.js';
import { runSshCommand } from '../../ssh-command-runner.js';
import {
  errorMessage,
  normalizeConnectModes,
  normalizeJsonObject,
  probeNode,
  readString,
} from '../node-probes.js';

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

  // POST /nodes/heartbeat — remote executor auto-registration
  app.post('/nodes/heartbeat', async (req, reply) => {
    const body = req.body as Record<string, unknown> | undefined;
    const nodeId = normalizeOptionalString(body?.nodeId ?? body?.node_id);
    if (!nodeId) return reply.status(400).send({ error: 'nodeId is required' });

    await ensureExecutorNodeStore();
    const node = await upsertExecutorNodeHeartbeat({
      nodeId,
      hostLabel: normalizeOptionalString(body?.hostLabel ?? body?.host_label),
      baseUrl: normalizeOptionalString(body?.baseUrl ?? body?.base_url),
      version: normalizeOptionalString(body?.version),
      connectModes: hasField(body, 'connectModes') ? normalizeConnectModes(body?.connectModes) : undefined,
      connectConfig: hasField(body, 'connectConfig') ? normalizeJsonObject(body?.connectConfig) : undefined,
      capacity: hasField(body, 'capacity') ? normalizeJsonObject(body?.capacity) : undefined,
      capabilities: hasField(body, 'capabilities') ? normalizeJsonObject(body?.capabilities) : undefined,
      queueDepth: hasField(body, 'queueDepth') ? normalizeInteger(body?.queueDepth) : undefined,
      activeTaskCount: hasField(body, 'activeTaskCount') ? normalizeInteger(body?.activeTaskCount) : undefined,
      meshLinks: hasField(body, 'meshLinks') ? normalizeJsonArray(body?.meshLinks) : undefined,
    });
    return { ok: true, nodeId: node.nodeId, status: node.status };
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

  app.post('/nodes/:id/ssh-run', async (req, reply) => {
    const { id } = req.params as { id: string };
    const nodeId = normalizeOptionalString(id);
    if (!nodeId) return reply.status(400).send({ error: 'node id is required' });

    const body = req.body as Record<string, unknown> | undefined;
    const command = normalizeOptionalString(body?.command);
    if (!command) return reply.status(422).send({ error: 'command is required' });

    await ensureExecutorNodeStore();
    const node = await loadExecutorNode(nodeId);
    if (!node) return reply.status(404).send({ error: 'Not found' });

    const timeoutMs = typeof body?.timeoutMs === 'number' && body.timeoutMs > 0
      ? Math.min(body.timeoutMs, 120_000)
      : 30_000;
    const result = await runSshCommand(node, { command, timeoutMs });
    return { ok: true, ...result };
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

function normalizeOptionalString(value: unknown): string | undefined {
  return readString(value);
}

function hasField<T extends object>(value: T | undefined, key: keyof T): value is T {
  return Boolean(value && Object.prototype.hasOwnProperty.call(value, key));
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
