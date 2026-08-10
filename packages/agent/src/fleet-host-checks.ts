/**
 * Fleet host checks (P2 monitoring).
 *
 * Bounded SSH self-checks for remote executors — not continuous probes.
 * Rate limits: one host at a time, default ≥15m per host, fail soft.
 *
 * Defaults (override with LOS_FLEET_HOST_CHECKS):
 *   node34-executor-1=localnode34-r-t:linux:8090
 *   oracle-executor=oracle-t:linux:8091
 *   desktop-r45553o=win-los:windows:8090
 * mbp is covered by local dogfood / runtime_readiness — not SSH.
 */

import { getDb } from '@los/infra/db';
import { getLogger } from '@los/infra/logger';
import {
  runHostSsh,
  runSshCommand,
  type HostSshTarget,
  type SshCommandResult,
} from './fleet-host-check-ssh.js';
import { appendSessionEvent } from './session-events.js';

const log = getLogger('fleet-host-checks');

export const DEFAULT_HOST_CHECK_MIN_INTERVAL_MS = 15 * 60_000;
export const DEFAULT_HOST_CHECK_SSH_TIMEOUT_MS = 25_000;
export const DEFAULT_HOST_CHECK_ALERT_COOLDOWN_MS = 30 * 60_000;

export type FleetHostPlatform = HostSshTarget['platform'];
export type FleetHostCheckStatus = 'ok' | 'degraded' | 'failed' | 'skipped';

export interface FleetHostTarget extends HostSshTarget {
  nodeId: string;
  minIntervalMs: number;
}

export interface FleetHostCheckResult {
  nodeId: string;
  sshHost: string;
  platform: FleetHostPlatform;
  status: FleetHostCheckStatus;
  skippedReason?: 'cooldown' | 'disabled' | 'dry_run_plan';
  durationMs: number;
  unitActive?: string;
  healthOk?: boolean;
  healthSnippet?: string;
  listenOk?: boolean | null;
  memAvailableMb?: number;
  memTotalMb?: number;
  swapUsedMb?: number;
  swapTotalMb?: number;
  detail: string;
  error?: string;
}

export interface FleetHostCheckRunOptions {
  now?: Date;
  force?: boolean;
  dryRun?: boolean;
  /** Inject SSH runner for tests (linux path). */
  sshRunner?: typeof runSshCommand;
  /** Full host transport override for tests. */
  hostRunner?: (target: FleetHostTarget, timeoutMs: number) => Promise<SshCommandResult>;
  targets?: FleetHostTarget[];
  minIntervalMs?: number;
  sshTimeoutMs?: number;
  alertCooldownMs?: number;
  tenantId?: string;
  projectId?: string;
  scheduleId?: string;
  runId?: string;
  quiet?: boolean;
}

export interface FleetHostCheckRunReport {
  assessedAt: string;
  results: FleetHostCheckResult[];
  checked: string[];
  skipped: string[];
  failed: string[];
  degraded: string[];
  ok: string[];
  alertsEmitted: string[];
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS fleet_host_check_state (
  node_id TEXT PRIMARY KEY,
  last_check_at TIMESTAMPTZ,
  last_status TEXT NOT NULL DEFAULT 'unknown',
  last_summary TEXT,
  last_detail_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_alert_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

let _initialized = false;

export async function ensureFleetHostCheckStore(): Promise<void> {
  if (_initialized) return;
  await getDb().exec(SCHEMA);
  _initialized = true;
}

export function _resetFleetHostCheckStoreForTests(): void {
  _initialized = false;
}

export const DEFAULT_FLEET_HOST_TARGETS: readonly FleetHostTarget[] = [
  {
    nodeId: 'node34-executor-1',
    sshHost: 'localnode34-r-t',
    platform: 'linux',
    healthPort: 8090,
    unitName: 'los-executor',
    minIntervalMs: DEFAULT_HOST_CHECK_MIN_INTERVAL_MS,
  },
  {
    nodeId: 'oracle-executor',
    sshHost: 'oracle-t',
    platform: 'linux',
    healthPort: 8091,
    unitName: 'los-executor',
    minIntervalMs: DEFAULT_HOST_CHECK_MIN_INTERVAL_MS,
  },
  {
    nodeId: 'desktop-r45553o',
    sshHost: 'win-los',
    platform: 'windows',
    healthPort: 8090,
    unitName: 'los-executor',
    minIntervalMs: DEFAULT_HOST_CHECK_MIN_INTERVAL_MS,
  },
] as const;

/**
 * LOS_FLEET_HOST_CHECKS format (comma-separated):
 *   nodeId=sshHost:platform:port[:unit]
 * Empty / unset → defaults. `none` disables all SSH host checks.
 */
export function resolveFleetHostTargets(
  env: NodeJS.ProcessEnv = process.env,
): FleetHostTarget[] {
  const raw = env.LOS_FLEET_HOST_CHECKS?.trim();
  if (!raw) return DEFAULT_FLEET_HOST_TARGETS.map((t) => ({ ...t }));
  if (raw.toLowerCase() === 'none' || raw === '-') return [];
  const out: FleetHostTarget[] = [];
  for (const part of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const nodeId = part.slice(0, eq).trim();
    const rest = part.slice(eq + 1).trim();
    const [sshHost, platformRaw, portRaw, unitRaw] = rest.split(':').map((s) => s.trim());
    if (!sshHost || !platformRaw || !portRaw) continue;
    const platform = platformRaw.toLowerCase() === 'windows' ? 'windows' : 'linux';
    const healthPort = Number(portRaw);
    if (!Number.isFinite(healthPort) || healthPort <= 0) continue;
    out.push({
      nodeId,
      sshHost,
      platform,
      healthPort: Math.floor(healthPort),
      unitName: unitRaw || 'los-executor',
      minIntervalMs: DEFAULT_HOST_CHECK_MIN_INTERVAL_MS,
    });
  }
  return out;
}

export function parseHostCheckOutput(
  target: FleetHostTarget,
  stdout: string,
  stderr: string,
  exitCode: number | null,
  durationMs: number,
  error?: string,
): FleetHostCheckResult {
  if (error) {
    return {
      nodeId: target.nodeId,
      sshHost: target.sshHost,
      platform: target.platform,
      status: 'failed',
      durationMs,
      detail: stderr || error,
      error,
    };
  }

  const text = `${stdout}\n${stderr}`;
  const unitLine = matchField(text, 'UNIT');
  const healthLine = matchField(text, 'HEALTH');
  const listenLine = matchField(text, 'LISTEN');
  const memLine = matchField(text, 'MEM');
  const swapLine = matchField(text, 'SWAP');

  const unitActive = unitLine?.trim().toLowerCase();
  const unitOk = unitActive === 'active'
    || unitActive === 'running'
    || unitActive === 'ready';
  const healthOk = Boolean(healthLine && /"status"\s*:\s*"ok"|status.:.ok/i.test(healthLine));
  const listenOk = target.platform === 'windows'
    ? null
    : Boolean(listenLine && listenLine.includes(String(target.healthPort)));

  const mem = parsePair(memLine);
  const swap = parsePair(swapLine);

  let status: FleetHostCheckStatus = 'ok';
  if (!unitOk || !healthOk) status = 'failed';
  else if (listenOk === false) status = 'degraded';
  else if (exitCode !== 0 && exitCode !== null) status = 'degraded';

  const detail = [
    `unit=${unitActive ?? 'n/a'}`,
    `health=${healthOk ? 'ok' : 'bad'}`,
    listenOk === null ? null : `listen=${listenOk ? 'ok' : 'missing'}`,
    mem ? `mem_avail_mb=${mem.b}` : null,
    swap ? `swap_used_mb=${swap.b}` : null,
  ].filter(Boolean).join(' ');

  return {
    nodeId: target.nodeId,
    sshHost: target.sshHost,
    platform: target.platform,
    status,
    durationMs,
    unitActive: unitActive ?? undefined,
    healthOk,
    healthSnippet: healthLine?.slice(0, 200),
    listenOk,
    memTotalMb: mem?.a,
    memAvailableMb: mem?.b,
    swapTotalMb: swap?.a,
    swapUsedMb: swap?.b,
    detail,
    error: status === 'failed' ? detail : undefined,
  };
}

function matchField(text: string, key: string): string | undefined {
  const m = text.match(new RegExp(`^${key}=(.*)$`, 'mi'));
  return m?.[1]?.trim();
}

function parsePair(line: string | undefined): { a: number; b: number } | undefined {
  if (!line || line === 'n/a') return undefined;
  const parts = line.trim().split(/\s+/).map(Number);
  if (parts.length >= 2 && parts.every((n) => Number.isFinite(n))) {
    return { a: parts[0]!, b: parts[1]! };
  }
  return undefined;
}

interface HostCheckStateRow {
  node_id: string;
  last_check_at: Date | string | null;
  last_status: string;
  last_summary: string | null;
  last_alert_at: Date | string | null;
}

function toMs(value: Date | string | null | undefined): number {
  if (!value) return 0;
  const d = value instanceof Date ? value : new Date(String(value));
  return Number.isFinite(d.getTime()) ? d.getTime() : 0;
}

/**
 * Serial host checks with per-host cooldown. Fail-soft across hosts.
 */
export async function runFleetHostChecks(
  options: FleetHostCheckRunOptions = {},
): Promise<FleetHostCheckRunReport> {
  await ensureFleetHostCheckStore();
  const now = options.now ?? new Date();
  const nowMs = now.getTime();
  const targets = options.targets ?? resolveFleetHostTargets();
  const sshTimeoutMs = options.sshTimeoutMs ?? DEFAULT_HOST_CHECK_SSH_TIMEOUT_MS;
  const alertCooldownMs = options.alertCooldownMs ?? DEFAULT_HOST_CHECK_ALERT_COOLDOWN_MS;
  const db = getDb();

  const results: FleetHostCheckResult[] = [];
  const alertsEmitted: string[] = [];

  for (const target of targets) {
    const minInterval = options.minIntervalMs ?? target.minIntervalMs;
    const existing = await db.query<HostCheckStateRow>(
      'SELECT node_id, last_check_at, last_status, last_summary, last_alert_at FROM fleet_host_check_state WHERE node_id = $1',
      [target.nodeId],
    );
    const prev = existing.rows[0];
    const lastCheckMs = toMs(prev?.last_check_at);
    if (!options.force && lastCheckMs > 0 && nowMs - lastCheckMs < minInterval) {
      results.push({
        nodeId: target.nodeId,
        sshHost: target.sshHost,
        platform: target.platform,
        status: 'skipped',
        skippedReason: 'cooldown',
        durationMs: 0,
        detail: `cooldown ${Math.round((minInterval - (nowMs - lastCheckMs)) / 1000)}s remaining`,
      });
      continue;
    }

    if (options.dryRun) {
      results.push({
        nodeId: target.nodeId,
        sshHost: target.sshHost,
        platform: target.platform,
        status: 'skipped',
        skippedReason: 'dry_run_plan',
        durationMs: 0,
        detail: `would check ${target.sshHost} (${target.platform}:${target.healthPort})`,
      });
      continue;
    }

    const started = Date.now();
    let raw: SshCommandResult;
    try {
      if (options.hostRunner) {
        raw = await options.hostRunner(target, sshTimeoutMs);
      } else if (options.sshRunner) {
        raw = await runHostSsh(target, sshTimeoutMs, options.sshRunner);
      } else {
        raw = await runHostSsh(target, sshTimeoutMs);
      }
    } catch (err) {
      raw = {
        stdout: '',
        stderr: '',
        exitCode: null,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    const result = parseHostCheckOutput(
      target,
      raw.stdout,
      raw.stderr,
      raw.exitCode,
      Date.now() - started,
      raw.error,
    );
    results.push(result);

    const lastAlertMs = toMs(prev?.last_alert_at);
    const shouldAlert =
      (result.status === 'failed' || result.status === 'degraded')
      && (lastAlertMs === 0 || nowMs - lastAlertMs >= alertCooldownMs)
      && !options.quiet;

    let nextAlertAt: Date | null = prev?.last_alert_at
      ? (prev.last_alert_at instanceof Date
        ? prev.last_alert_at
        : new Date(String(prev.last_alert_at)))
      : null;

    if (shouldAlert) {
      try {
        await appendSessionEvent({
          sessionId: `ops:fleet-host:${target.nodeId}`,
          type: 'ops.fleet_host_check',
          source: 'ops',
          tenantId: options.tenantId?.trim() || 'local',
          projectId: options.projectId?.trim() || 'los',
          payload: {
            kind: 'fleet_host_check',
            severity: result.status === 'failed' ? 'warning' : 'info',
            title: `舰队主机检查: ${target.nodeId} (${result.status})`,
            detail: result.detail,
            reason: result.detail,
            nodeId: target.nodeId,
            sshHost: target.sshHost,
            status: result.status,
            unitActive: result.unitActive ?? null,
            healthOk: result.healthOk ?? null,
            scheduleId: options.scheduleId ?? null,
            runId: options.runId ?? null,
            requiresDecision: false,
          },
        });
        nextAlertAt = now;
        alertsEmitted.push(target.nodeId);
      } catch (err) {
        log.warn(
          `fleet host check alert emit failed node=${target.nodeId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    await db.query(
      `INSERT INTO fleet_host_check_state
         (node_id, last_check_at, last_status, last_summary, last_detail_json, last_alert_at, updated_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
       ON CONFLICT (node_id) DO UPDATE SET
         last_check_at = EXCLUDED.last_check_at,
         last_status = EXCLUDED.last_status,
         last_summary = EXCLUDED.last_summary,
         last_detail_json = EXCLUDED.last_detail_json,
         last_alert_at = EXCLUDED.last_alert_at,
         updated_at = EXCLUDED.updated_at`,
      [
        target.nodeId,
        now,
        result.status,
        result.detail,
        JSON.stringify(result),
        nextAlertAt,
        now,
      ],
    );
  }

  return {
    assessedAt: now.toISOString(),
    results,
    checked: results.filter((r) => r.status !== 'skipped').map((r) => r.nodeId),
    skipped: results.filter((r) => r.status === 'skipped').map((r) => r.nodeId),
    failed: results.filter((r) => r.status === 'failed').map((r) => r.nodeId),
    degraded: results.filter((r) => r.status === 'degraded').map((r) => r.nodeId),
    ok: results.filter((r) => r.status === 'ok').map((r) => r.nodeId),
    alertsEmitted,
  };
}
