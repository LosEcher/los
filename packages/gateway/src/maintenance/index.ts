import { loadConfig } from '@los/infra/config';
import { initDb, closeDb } from '@los/infra/db';
import {
  ensureServiceInstanceStore,
  loadServiceInstance,
  upsertServiceInstance,
} from '@los/agent/service-instances';
import { resolveGatewayServiceIdentity } from '../server.js';

type Command = 'status' | 'set-status' | 'set-rollout' | 'drain' | 'promote';

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const [command, ...rest] = argv[0] === '--' ? argv.slice(1) : argv;
  if (!command || !isCommand(command)) {
    printHelp();
    process.exit(command ? 2 : 0);
  }

  const config = await loadConfig();
  await initDb(config.databaseUrl);
  await ensureServiceInstanceStore();

  try {
    const service = resolveGatewayServiceIdentity(config);
    switch (command) {
      case 'status':
        await statusCmd(service.serviceId);
        break;
      case 'set-status':
        await setStatusCmd(service.serviceId, rest[0]);
        break;
      case 'set-rollout':
        await setRolloutCmd(service.serviceId, rest[0], rest[1]);
        break;
      case 'drain':
        await drainCmd(service.serviceId, rest[0]);
        break;
      case 'promote':
        await setStatusCmd(service.serviceId, 'online', 'idle', rest[0] ?? 'promoted');
        break;
    }
  } finally {
    await closeDb();
  }
}

async function statusCmd(serviceId: string): Promise<void> {
  const service = await requireService(serviceId);
  console.log(formatServiceState(service));
}

async function setStatusCmd(
  serviceId: string,
  status?: string,
  rolloutState?: string,
  rolloutMessage?: string,
): Promise<void> {
  await requireService(serviceId);
  const saved = await upsertServiceInstance({
    serviceId,
    status: normalizeStatus(status),
    rolloutState: normalizeRolloutState(rolloutState),
    rolloutMessage: normalizeOptionalString(rolloutMessage),
  });
  console.log(formatServiceState(saved));
}

async function setRolloutCmd(serviceId: string, rolloutState?: string, rolloutMessage?: string): Promise<void> {
  await requireService(serviceId);
  const saved = await upsertServiceInstance({
    serviceId,
    rolloutState: normalizeRolloutState(rolloutState),
    rolloutMessage: normalizeOptionalString(rolloutMessage),
  });
  console.log(formatServiceState(saved));
}

async function drainCmd(serviceId: string, reason?: string): Promise<void> {
  await setStatusCmd(serviceId, 'draining', 'draining', reason ?? 'draining before stop');
}

async function requireService(serviceId: string) {
  const service = await loadServiceInstance(serviceId);
  if (!service) {
    throw new Error(`service instance not found: ${serviceId}`);
  }
  return service;
}

function formatServiceState(service: Awaited<ReturnType<typeof requireService>>): string {
  const parts = [
    `serviceId=${service.serviceId}`,
    `status=${service.status}`,
    `ready=${service.readiness.ready}`,
    `role=${service.role}`,
  ];
  if (service.rolloutState) parts.push(`rollout=${service.rolloutState}`);
  if (service.readiness.blockers.length > 0) parts.push(`blockers=${service.readiness.blockers.join(',')}`);
  if (service.readiness.warnings.length > 0) parts.push(`warnings=${service.readiness.warnings.join(',')}`);
  return parts.join(' ');
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeStatus(value: string | undefined): 'online' | 'draining' | 'offline' {
  if (value === 'online' || value === 'draining') return value;
  return 'offline';
}

function normalizeRolloutState(value: string | undefined): 'idle' | 'draining' | 'upgrading' | 'verifying' | 'failed' | undefined {
  if (value === 'idle' || value === 'draining' || value === 'upgrading' || value === 'verifying' || value === 'failed') {
    return value;
  }
  return undefined;
}

function isCommand(value: string): value is Command {
  return ['status', 'set-status', 'set-rollout', 'drain', 'promote'].includes(value);
}

function printHelp(): void {
  console.log([
    'los gateway maintenance',
    '',
    'Usage:',
    '  pnpm --filter @los/gateway run maint -- status',
    '  pnpm --filter @los/gateway run maint -- set-status [online|draining|offline]',
    '  pnpm --filter @los/gateway run maint -- set-rollout [idle|draining|upgrading|verifying|failed] [message]',
    '  pnpm --filter @los/gateway run maint -- drain [reason]',
    '  pnpm --filter @los/gateway run maint -- promote [reason]',
  ].join('\n'));
}

void main().catch((err) => {
  console.error(err?.message ?? String(err));
  process.exit(1);
});
