import { getDb } from '@los/infra/db';

const SERVICE_INSTANCE_STALE_MS = 60_000;

export type ServiceInstanceKind = 'gateway' | 'web' | 'scheduler' | 'artifact_proxy' | 'worker';
export type ServiceInstanceStatus = 'online' | 'draining' | 'offline';
export type ServiceInstanceRole = 'active' | 'standby' | 'worker';
export type ServiceInstanceRolloutState = 'idle' | 'draining' | 'upgrading' | 'verifying' | 'failed';

export interface ServiceInstanceRecord {
  serviceId: string;
  serviceKind: ServiceInstanceKind;
  nodeId?: string;
  hostLabel?: string;
  bindUrl?: string;
  publicUrl?: string;
  status: ServiceInstanceStatus;
  role: ServiceInstanceRole;
  version?: string;
  targetVersion?: string;
  rolloutState?: ServiceInstanceRolloutState;
  rolloutMessage?: string;
  capabilities: Record<string, unknown>;
  health: Record<string, unknown>;
  load: Record<string, unknown>;
  priority: number;
  region?: string;
  lastProbeAt?: string;
  lastProbeError?: string;
  lastHeartbeatAt: string;
  createdAt: string;
  updatedAt: string;
  readiness: ServiceInstanceReadiness;
}

export interface ServiceInstanceReadiness {
  ready: boolean;
  blockers: string[];
  warnings: string[];
}

export interface ServiceInstanceHeartbeatInput {
  serviceId: string;
  serviceKind?: ServiceInstanceKind;
  nodeId?: string;
  hostLabel?: string;
  bindUrl?: string;
  publicUrl?: string;
  status?: ServiceInstanceStatus;
  role?: ServiceInstanceRole;
  version?: string;
  targetVersion?: string;
  rolloutState?: ServiceInstanceRolloutState;
  rolloutMessage?: string;
  capabilities?: Record<string, unknown>;
  health?: Record<string, unknown>;
  load?: Record<string, unknown>;
  priority?: number;
  region?: string;
}

export interface ServiceInstanceUpsertInput extends ServiceInstanceHeartbeatInput {
  lastProbeAt?: Date | string | null;
  lastProbeError?: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS service_instances (
  service_id TEXT PRIMARY KEY,
  service_kind TEXT NOT NULL DEFAULT 'gateway',
  node_id TEXT,
  host_label TEXT,
  bind_url TEXT,
  public_url TEXT,
  status TEXT NOT NULL DEFAULT 'offline',
  role TEXT NOT NULL DEFAULT 'active',
  version TEXT,
  target_version TEXT,
  rollout_state TEXT NOT NULL DEFAULT 'idle',
  rollout_message TEXT,
  capabilities_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  health_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  load_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  priority INTEGER NOT NULL DEFAULT 100,
  region TEXT,
  last_probe_at TIMESTAMPTZ,
  last_probe_error TEXT,
  last_heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE service_instances ADD COLUMN IF NOT EXISTS service_kind TEXT NOT NULL DEFAULT 'gateway';
ALTER TABLE service_instances ADD COLUMN IF NOT EXISTS node_id TEXT;
ALTER TABLE service_instances ADD COLUMN IF NOT EXISTS host_label TEXT;
ALTER TABLE service_instances ADD COLUMN IF NOT EXISTS bind_url TEXT;
ALTER TABLE service_instances ADD COLUMN IF NOT EXISTS public_url TEXT;
ALTER TABLE service_instances ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'active';
ALTER TABLE service_instances ADD COLUMN IF NOT EXISTS target_version TEXT;
ALTER TABLE service_instances ADD COLUMN IF NOT EXISTS rollout_state TEXT NOT NULL DEFAULT 'idle';
ALTER TABLE service_instances ADD COLUMN IF NOT EXISTS rollout_message TEXT;
ALTER TABLE service_instances ADD COLUMN IF NOT EXISTS capabilities_json JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE service_instances ADD COLUMN IF NOT EXISTS health_json JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE service_instances ADD COLUMN IF NOT EXISTS load_json JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE service_instances ADD COLUMN IF NOT EXISTS priority INTEGER NOT NULL DEFAULT 100;
ALTER TABLE service_instances ADD COLUMN IF NOT EXISTS region TEXT;
ALTER TABLE service_instances ADD COLUMN IF NOT EXISTS last_probe_at TIMESTAMPTZ;
ALTER TABLE service_instances ADD COLUMN IF NOT EXISTS last_probe_error TEXT;

CREATE INDEX IF NOT EXISTS idx_service_instances_kind ON service_instances(service_kind);
CREATE INDEX IF NOT EXISTS idx_service_instances_status ON service_instances(status);
CREATE INDEX IF NOT EXISTS idx_service_instances_heartbeat ON service_instances(last_heartbeat_at DESC);
CREATE INDEX IF NOT EXISTS idx_service_instances_priority ON service_instances(priority);
`;

let _initialized = false;

export async function ensureServiceInstanceStore(): Promise<void> {
  if (_initialized) return;
  const db = getDb();
  await db.exec(SCHEMA);
  _initialized = true;
}

export async function upsertServiceInstanceHeartbeat(input: ServiceInstanceHeartbeatInput): Promise<ServiceInstanceRecord> {
  await ensureServiceInstanceStore();
  const existing = await loadServiceInstance(input.serviceId);
  return writeServiceInstance(input.serviceId, {
    touchHeartbeat: true,
    serviceKind: input.serviceKind ?? 'gateway',
    nodeId: normalizeOptionalString(input.nodeId),
    hostLabel: normalizeOptionalString(input.hostLabel),
    bindUrl: normalizeOptionalString(input.bindUrl),
    publicUrl: normalizeOptionalString(input.publicUrl),
    status: resolveHeartbeatStatus(existing?.status, input.status),
    role: normalizeRole(input.role),
    version: normalizeOptionalString(input.version),
    targetVersion: normalizeOptionalString(input.targetVersion),
    rolloutState: normalizeRolloutState(input.rolloutState),
    rolloutMessage: normalizeOptionalString(input.rolloutMessage),
    capabilities: mergeObjects(existing?.capabilities, input.capabilities),
    health: mergeObjects(existing?.health, input.health),
    load: mergeObjects(existing?.load, input.load),
    priority: input.priority,
    region: normalizeOptionalString(input.region),
  });
}

export async function upsertServiceInstance(input: ServiceInstanceUpsertInput): Promise<ServiceInstanceRecord> {
  await ensureServiceInstanceStore();
  return writeServiceInstance(input.serviceId, {
    touchHeartbeat: false,
    serviceKind: input.serviceKind,
    nodeId: normalizeOptionalString(input.nodeId),
    hostLabel: normalizeOptionalString(input.hostLabel),
    bindUrl: normalizeOptionalString(input.bindUrl),
    publicUrl: normalizeOptionalString(input.publicUrl),
    status: input.status,
    role: input.role,
    version: normalizeOptionalString(input.version),
    targetVersion: normalizeOptionalString(input.targetVersion),
    rolloutState: normalizeRolloutState(input.rolloutState),
    rolloutMessage: normalizeOptionalString(input.rolloutMessage),
    capabilities: input.capabilities,
    health: input.health,
    load: input.load,
    priority: input.priority,
    region: normalizeOptionalString(input.region),
    lastProbeAt: input.lastProbeAt ?? null,
    lastProbeError: input.lastProbeError ?? null,
  });
}

export async function listServiceInstances(limit = 50): Promise<ServiceInstanceRecord[]> {
  await ensureServiceInstanceStore();
  const db = getDb();
  const rows = await db.query<ServiceInstanceRow>(
    'SELECT * FROM service_instances ORDER BY priority ASC, last_heartbeat_at DESC, updated_at DESC LIMIT $1',
    [limit],
  );
  return rows.rows.map(rowToServiceInstance);
}

export async function loadServiceInstance(serviceId: string): Promise<ServiceInstanceRecord | null> {
  await ensureServiceInstanceStore();
  const db = getDb();
  const rows = await db.query<ServiceInstanceRow>('SELECT * FROM service_instances WHERE service_id = $1', [serviceId]);
  return rows.rows[0] ? rowToServiceInstance(rows.rows[0]) : null;
}

export function evaluateServiceInstance(service: Omit<ServiceInstanceRecord, 'readiness'>): ServiceInstanceReadiness {
  const blockers: string[] = [];
  const warnings: string[] = [];

  if (service.status !== 'online') blockers.push(`status:${service.status}`);
  if (isHeartbeatStale(service.lastHeartbeatAt)) blockers.push('heartbeat:stale');
  if (service.health.db_ok === false) blockers.push('health:db_unavailable');
  if (service.health.schema_ok === false) blockers.push('health:schema_unavailable');
  if (service.role === 'standby') warnings.push('standby');

  return {
    ready: blockers.length === 0,
    blockers,
    warnings,
  };
}

type ServiceInstanceRow = {
  service_id: string;
  service_kind: ServiceInstanceKind;
  node_id: string | null;
  host_label: string | null;
  bind_url: string | null;
  public_url: string | null;
  status: ServiceInstanceStatus;
  role: ServiceInstanceRole;
  version: string | null;
  target_version: string | null;
  rollout_state: string | null;
  rollout_message: string | null;
  capabilities_json: unknown;
  health_json: unknown;
  load_json: unknown;
  priority: number | string;
  region: string | null;
  last_probe_at: Date | string | null;
  last_probe_error: string | null;
  last_heartbeat_at: Date | string;
  created_at: Date | string;
  updated_at: Date | string;
};

async function writeServiceInstance(
  serviceId: string,
  input: {
    serviceKind?: ServiceInstanceKind;
    nodeId?: string;
    hostLabel?: string;
    bindUrl?: string;
    publicUrl?: string;
    status?: ServiceInstanceStatus;
    role?: ServiceInstanceRole;
    version?: string;
    targetVersion?: string;
    rolloutState?: ServiceInstanceRolloutState;
    rolloutMessage?: string;
    capabilities?: Record<string, unknown>;
    health?: Record<string, unknown>;
    load?: Record<string, unknown>;
    priority?: number;
    region?: string;
    lastProbeAt?: Date | string | null;
    lastProbeError?: string | null;
    touchHeartbeat: boolean;
  },
): Promise<ServiceInstanceRecord> {
  const db = getDb();
  const hasLastProbeError = Object.prototype.hasOwnProperty.call(input, 'lastProbeError');
  const rows = await db.query<ServiceInstanceRow>(
    `
    INSERT INTO service_instances (
      service_id, service_kind, node_id, host_label, bind_url, public_url,
      status, role, version, target_version, rollout_state, rollout_message,
      capabilities_json, health_json, load_json, priority, region,
      last_probe_at, last_probe_error, last_heartbeat_at, updated_at
    )
    VALUES (
      $1, COALESCE($2, 'gateway'), $3, $4, $5, $6,
      COALESCE($7, 'offline'), COALESCE($8, 'active'), $9, $10,
      COALESCE($11, 'idle'), $12,
      COALESCE($13::jsonb, '{}'::jsonb),
      COALESCE($14::jsonb, '{}'::jsonb),
      COALESCE($15::jsonb, '{}'::jsonb),
      COALESCE($16::integer, 100), $17, $18::timestamptz, $19, now(), now()
    )
    ON CONFLICT (service_id) DO UPDATE
      SET service_kind = COALESCE($2, service_instances.service_kind),
          node_id = COALESCE($3, service_instances.node_id),
          host_label = COALESCE($4, service_instances.host_label),
          bind_url = COALESCE($5, service_instances.bind_url),
          public_url = COALESCE($6, service_instances.public_url),
          status = COALESCE($7, service_instances.status),
          role = COALESCE($8, service_instances.role),
          version = COALESCE($9, service_instances.version),
          target_version = COALESCE($10, service_instances.target_version),
          rollout_state = COALESCE($11, service_instances.rollout_state),
          rollout_message = COALESCE($12, service_instances.rollout_message),
          capabilities_json = COALESCE($13::jsonb, service_instances.capabilities_json),
          health_json = COALESCE($14::jsonb, service_instances.health_json),
          load_json = COALESCE($15::jsonb, service_instances.load_json),
          priority = COALESCE($16::integer, service_instances.priority),
          region = COALESCE($17, service_instances.region),
          last_probe_at = COALESCE($18::timestamptz, service_instances.last_probe_at),
          last_probe_error = CASE WHEN $21::boolean THEN $19 ELSE service_instances.last_probe_error END,
          last_heartbeat_at = CASE WHEN $20::boolean THEN now() ELSE service_instances.last_heartbeat_at END,
          updated_at = now()
    RETURNING *
  `,
    [
      serviceId,
      input.serviceKind ?? null,
      input.nodeId ?? null,
      input.hostLabel ?? null,
      input.bindUrl ?? null,
      input.publicUrl ?? null,
      input.status ?? null,
      input.role ?? null,
      input.version ?? null,
      input.targetVersion ?? null,
      input.rolloutState ?? null,
      input.rolloutMessage ?? null,
      jsonOrNull(input.capabilities),
      jsonOrNull(input.health),
      jsonOrNull(input.load),
      input.priority === undefined ? null : normalizePriority(input.priority),
      input.region ?? null,
      input.lastProbeAt ? toIsoString(input.lastProbeAt) : null,
      input.lastProbeError ?? null,
      input.touchHeartbeat,
      hasLastProbeError,
    ],
  );
  return rowToServiceInstance(assertRow(rows.rows[0]));
}

function rowToServiceInstance(row: ServiceInstanceRow): ServiceInstanceRecord {
  const record = {
    serviceId: row.service_id,
    serviceKind: row.service_kind,
    nodeId: row.node_id ?? undefined,
    hostLabel: row.host_label ?? undefined,
    bindUrl: row.bind_url ?? undefined,
    publicUrl: row.public_url ?? undefined,
    status: row.status,
    role: row.role,
    version: row.version ?? undefined,
    targetVersion: row.target_version ?? undefined,
    rolloutState: normalizeRolloutState(row.rollout_state) ?? undefined,
    rolloutMessage: row.rollout_message ?? undefined,
    capabilities: normalizeJsonObject(row.capabilities_json),
    health: normalizeJsonObject(row.health_json),
    load: normalizeJsonObject(row.load_json),
    priority: normalizePriority(row.priority),
    region: row.region ?? undefined,
    lastProbeAt: row.last_probe_at ? toIsoString(row.last_probe_at) : undefined,
    lastProbeError: row.last_probe_error ?? undefined,
    lastHeartbeatAt: toIsoString(row.last_heartbeat_at),
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
  return {
    ...record,
    readiness: evaluateServiceInstance(record),
  };
}

function resolveHeartbeatStatus(
  existing: ServiceInstanceStatus | undefined,
  requested: ServiceInstanceStatus | undefined,
): ServiceInstanceStatus {
  if (requested) return requested;
  return existing === 'draining' ? 'draining' : 'online';
}

function normalizeRole(value: unknown): ServiceInstanceRole | undefined {
  if (value === 'active' || value === 'standby' || value === 'worker') return value;
  return undefined;
}

function normalizeRolloutState(value: unknown): ServiceInstanceRolloutState | undefined {
  if (value === 'idle' || value === 'draining' || value === 'upgrading' || value === 'verifying' || value === 'failed') return value;
  return undefined;
}

function mergeObjects(
  existing: Record<string, unknown> | undefined,
  incoming: Record<string, unknown> | undefined,
): Record<string, unknown> {
  return {
    ...(existing ?? {}),
    ...(incoming ?? {}),
  };
}

function isHeartbeatStale(value: string | undefined): boolean {
  if (!value) return true;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return true;
  return Date.now() - timestamp > SERVICE_INSTANCE_STALE_MS;
}

function normalizePriority(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.floor(value));
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.max(0, Math.floor(parsed));
  }
  return 100;
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeJsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    } catch {
      return {};
    }
  }
  return {};
}

function jsonOrNull(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function assertRow<T>(row: T | undefined): T {
  if (!row) throw new Error('Failed to write service instance');
  return row;
}
