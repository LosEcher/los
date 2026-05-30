import { loadConfig } from '@los/infra/config';
import { initDb, closeDb, getDb } from '@los/infra/db';
import {
  ensureExecutorNodeStore,
  evaluateExecutorNode,
  loadExecutorNode,
  upsertExecutorNode,
} from '@los/agent/executor-nodes';
import { ensureTaskRunStore } from '@los/agent/task-runs';

type Command =
  | 'status'
  | 'set-status'
  | 'set-rollout'
  | 'wait-drain'
  | 'active-count'
  | 'promote'
  | 'drain';

const DEFAULT_POLL_MS = 1_000;
const DEFAULT_TIMEOUT_MS = 120_000;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const [command, ...rest] = argv[0] === '--' ? argv.slice(1) : argv;
  if (!command || !isCommand(command)) {
    printHelp();
    process.exit(command ? 2 : 0);
  }

  const config = await loadConfig();
  await initDb(config.databaseUrl);
  await ensureExecutorNodeStore();
  await ensureTaskRunStore();

  try {
    const nodeId = resolveNodeId(config.executor.nodeId, rest[0]);
    switch (command) {
      case 'status':
        await statusCmd(nodeId);
        break;
      case 'set-status':
        await setStatusCmd(nodeId, rest[1]);
        break;
      case 'set-rollout':
        await setRolloutCmd(nodeId, rest[1], rest[2]);
        break;
      case 'wait-drain':
        await waitDrainCmd(nodeId, parsePositiveInteger(rest[1]) ?? DEFAULT_TIMEOUT_MS);
        break;
      case 'active-count':
        await activeCountCmd(nodeId);
        break;
      case 'promote':
        await setStatusCmd(nodeId, 'online');
        break;
      case 'drain':
        await drainCmd(nodeId, parsePositiveInteger(rest[1]) ?? DEFAULT_TIMEOUT_MS);
        break;
    }
  } finally {
    await closeDb();
  }
}

async function statusCmd(nodeId: string): Promise<void> {
  const node = await requireNode(nodeId);
  const activeTaskCount = await getActiveTaskCount(nodeId);
  const execution = evaluateExecutorNode(node);
  console.log(formatNodeState(node, activeTaskCount, execution));
}

async function setStatusCmd(nodeId: string, status?: string): Promise<void> {
  const nextStatus = normalizeStatus(status);
  await requireNode(nodeId);
  const activeTaskCount = await getActiveTaskCount(nodeId);
  const saved = await upsertExecutorNode({
    nodeId,
    status: nextStatus,
    activeTaskCount,
  });
  const execution = evaluateExecutorNode(saved);
  console.log(formatNodeState(saved, activeTaskCount, execution));
}

async function setRolloutCmd(nodeId: string, rolloutState?: string, rolloutMessage?: string): Promise<void> {
  await requireNode(nodeId);
  const activeTaskCount = await getActiveTaskCount(nodeId);
  const saved = await upsertExecutorNode({
    nodeId,
    rolloutState: normalizeRolloutState(rolloutState),
    rolloutMessage: normalizeOptionalString(rolloutMessage),
    activeTaskCount,
  });
  const execution = evaluateExecutorNode(saved);
  console.log(formatNodeState(saved, activeTaskCount, execution));
}

async function waitDrainCmd(nodeId: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const activeTaskCount = await getActiveTaskCount(nodeId);
    await requireNode(nodeId);
    const saved = await upsertExecutorNode({
      nodeId,
      status: 'draining',
      activeTaskCount,
    });
    const execution = evaluateExecutorNode(saved);
    console.log(formatNodeState(saved, activeTaskCount, execution));
    if (activeTaskCount === 0) return;
    await sleep(DEFAULT_POLL_MS);
  }
  throw new Error(`timed out waiting for ${nodeId} to drain`);
}

async function activeCountCmd(nodeId: string): Promise<void> {
  const activeTaskCount = await getActiveTaskCount(nodeId);
  console.log(String(activeTaskCount));
}

async function drainCmd(nodeId: string, timeoutMs: number): Promise<void> {
  await setStatusCmd(nodeId, 'draining');
  await waitDrainCmd(nodeId, timeoutMs);
}

async function getActiveTaskCount(nodeId: string): Promise<number> {
  const db = getDb();
  const rows = await db.query<{ active_task_count: number | string }>(
    `
    SELECT COUNT(*)::int AS active_task_count
    FROM task_runs
    WHERE node_id = $1
      AND status IN ('queued', 'running')
  `,
    [nodeId],
  );
  return normalizeInteger(rows.rows[0]?.active_task_count);
}

async function requireNode(nodeId: string) {
  const node = await loadExecutorNode(nodeId);
  if (!node) {
    throw new Error(`executor node not found: ${nodeId}`);
  }
  return node;
}

function formatNodeState(
  node: Awaited<ReturnType<typeof requireNode>>,
  activeTaskCount: number,
  execution: ReturnType<typeof evaluateExecutorNode>,
): string {
  const parts = [
    `nodeId=${node.nodeId}`,
    `status=${node.status}`,
    `candidate=${execution.candidate}`,
    `mode=${execution.mode ?? 'none'}`,
    `active=${activeTaskCount}`,
  ];
  if (execution.blockers.length > 0) parts.push(`blockers=${execution.blockers.join(',')}`);
  if (execution.warnings.length > 0) parts.push(`warnings=${execution.warnings.join(',')}`);
  return parts.join(' ');
}

function resolveNodeId(configNodeId: string | undefined, argNodeId?: string): string {
  const nodeId = normalizeOptionalString(argNodeId) ?? normalizeOptionalString(configNodeId);
  if (!nodeId) throw new Error('executor node id is required');
  return nodeId;
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeStatus(value: string | undefined): 'online' | 'draining' | 'offline' {
  if (value === 'draining' || value === 'offline') return value;
  return 'online';
}

function normalizeRolloutState(value: string | undefined): 'idle' | 'draining' | 'upgrading' | 'verifying' | 'failed' | undefined {
  if (value === 'idle' || value === 'draining' || value === 'upgrading' || value === 'verifying' || value === 'failed') {
    return value;
  }
  return undefined;
}

function parsePositiveInteger(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return undefined;
  const integer = Math.floor(parsed);
  return integer > 0 ? integer : undefined;
}

function normalizeInteger(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.floor(value));
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.max(0, Math.floor(parsed));
  }
  return 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isCommand(value: string): value is Command {
  return ['status', 'set-status', 'set-rollout', 'wait-drain', 'active-count', 'promote', 'drain'].includes(value);
}

function printHelp(): void {
  console.log([
    'los executor maintenance',
    '',
    'Usage:',
    '  pnpm --filter @los/executor run maint -- status [nodeId]',
    '  pnpm --filter @los/executor run maint -- set-status [nodeId] [online|draining|offline]',
    '  pnpm --filter @los/executor run maint -- set-rollout [nodeId] [idle|draining|upgrading|verifying|failed] [message]',
    '  pnpm --filter @los/executor run maint -- wait-drain [nodeId] [timeoutMs]',
    '  pnpm --filter @los/executor run maint -- active-count [nodeId]',
    '  pnpm --filter @los/executor run maint -- promote [nodeId]',
    '  pnpm --filter @los/executor run maint -- drain [nodeId] [timeoutMs]',
  ].join('\n'));
}

void main().catch((err) => {
  console.error(err?.message ?? String(err));
  process.exit(1);
});
