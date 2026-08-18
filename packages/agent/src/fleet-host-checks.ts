/**
 * Fleet host checks (P2 monitoring).
 *
 * Bounded SSH self-checks for remote executors — not continuous probes.
 * Rate limits: one host at a time, default ≥15m per host, fail soft.
 * Failed hosts may be auto-repaired by the control plane (fleet-host-repair.ts)
 * when LOS_FLEET_AUTO_REPAIR=true.
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
  parseHostCheckOutput,
  type FleetHostCheckResult,
  type FleetHostTarget,
  type SshCommandResult,
} from './fleet-host-check-ssh.js';
import {
  measureFleetOfflineShare,
  runRepairPhase,
  decideFleetHostRepair,
  DEFAULT_FLEET_REPAIR_COOLDOWN_MS,
  DEFAULT_FLEET_REPAIR_MAX_CONSECUTIVE_FAILURES,
  DEFAULT_FLEET_REPAIR_QUORUM_THRESHOLD,
  type FleetHostRepairResult,
} from './fleet-host-repair.js';
import {
  loadNodeRecoveryPolicy,
  resolveRepairConfig,
  type GlobalRepairConfig,
} from './node-recovery-policy.js';
import { resolveGlobalRepairConfig } from './fleet-repair-config.js';
import { appendSessionEvent } from './session-events.js';

const log = getLogger('fleet-host-checks');

export const DEFAULT_HOST_CHECK_MIN_INTERVAL_MS = 15 * 60_000;
export const DEFAULT_HOST_CHECK_SSH_TIMEOUT_MS = 25_000;
export const DEFAULT_HOST_CHECK_ALERT_COOLDOWN_MS = 30 * 60_000;

export type FleetHostCheckStatus = import('./fleet-host-check-ssh.js').FleetHostCheckStatus;
export type FleetHostPlatform = import('./fleet-host-check-ssh.js').FleetHostPlatform;
export type { FleetHostCheckResult, FleetHostTarget } from './fleet-host-check-ssh.js';
export { parseHostCheckOutput };
export type {
  FleetHostRepairOutcome,
  FleetHostRepairResult,
  FleetHostRepairSkipReason,
  RepairDecision,
  RepairDecisionContext,
} from './fleet-host-repair.js';
// Local re-exports (imported above so the names are usable in this file).
export {
  decideFleetHostRepair,
  measureFleetOfflineShare,
  DEFAULT_FLEET_REPAIR_COOLDOWN_MS,
  DEFAULT_FLEET_REPAIR_MAX_CONSECUTIVE_FAILURES,
  DEFAULT_FLEET_REPAIR_QUORUM_THRESHOLD,
};

export interface FleetHostCheckRunOptions {
  now?: Date;
  force?: boolean;
  dryRun?: boolean;
  /** Auto-repair failed hosts (default off; enable with LOS_FLEET_AUTO_REPAIR=true). */
  autoRepair?: boolean;
  repairCooldownMs?: number;
  repairMaxConsecutiveFailures?: number;
  /**
   * Restart a unit/service that is up but unhealthy. Default off: restarting a
   * live executor can interrupt active tasks; only unit-down is auto-repaired.
   * Enable with LOS_FLEET_REPAIR_RESTART_UNHEALTHY=true.
   */
  repairRestartUnhealthy?: boolean;
  /** Inject SSH runner for tests (linux path). */
  sshRunner?: typeof runSshCommand;
  /** Full host transport override for tests. */
  hostRunner?: (target: FleetHostTarget, timeoutMs: number) => Promise<SshCommandResult>;
  /** Repair transport override for tests. */
  repairRunner?: (
    target: FleetHostTarget,
    action: import('./fleet-host-check-ssh.js').FleetHostRepairAction,
    timeoutMs: number,
  ) => Promise<SshCommandResult>;
  /** Override the fleet-offline share used by the quorum guard (tests). */
  offlineFleetShare?: number;
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
  repairs: FleetHostRepairResult[];
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

ALTER TABLE fleet_host_check_state ADD COLUMN IF NOT EXISTS last_repair_at TIMESTAMPTZ;
ALTER TABLE fleet_host_check_state ADD COLUMN IF NOT EXISTS repair_failures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE fleet_host_check_state ADD COLUMN IF NOT EXISTS last_repair_result TEXT;
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

interface HostCheckStateRow {
  node_id: string;
  last_check_at: Date | string | null;
  last_status: string;
  last_summary: string | null;
  last_alert_at: Date | string | null;
  last_repair_at?: Date | string | null;
  repair_failures?: number;
  last_repair_result?: string | null;
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
  // Global repair config: DB (fleet_repair_config) > env (LOS_FLEET_REPAIR_*) >
  // built-in defaults. Options remain the explicit test/invocation override.
  const globalRepairDefaults: GlobalRepairConfig = {
    autoRepair: false,
    repairCooldownMs: DEFAULT_FLEET_REPAIR_COOLDOWN_MS,
    repairMaxConsecutiveFailures: DEFAULT_FLEET_REPAIR_MAX_CONSECUTIVE_FAILURES,
    restartUnhealthy: false,
    quorumThreshold: DEFAULT_FLEET_REPAIR_QUORUM_THRESHOLD,
  };
  const globalRepair = await resolveGlobalRepairConfig(process.env, globalRepairDefaults);
  const autoRepair = options.autoRepair ?? globalRepair.autoRepair;
  const repairCooldownMs = options.repairCooldownMs ?? globalRepair.repairCooldownMs;
  const repairMaxConsecutiveFailures =
    options.repairMaxConsecutiveFailures ?? globalRepair.repairMaxConsecutiveFailures;
  const restartUnhealthy = options.repairRestartUnhealthy ?? globalRepair.restartUnhealthy;
  const quorumThreshold = globalRepair.quorumThreshold;
  const db = getDb();

  // Quorum guard share: computed once per run from the registry. Fail open (0)
  // on registry errors so repair is not blocked by a read failure.
  let offlineFleetShare = options.offlineFleetShare;
  if (offlineFleetShare === undefined && targets.length > 0) {
    offlineFleetShare = await measureFleetOfflineShare(targets.map((t) => t.nodeId));
  }

  const results: FleetHostCheckResult[] = [];
  const repairs: FleetHostRepairResult[] = [];
  const alertsEmitted: string[] = [];

  for (const target of targets) {
    const minInterval = options.minIntervalMs ?? target.minIntervalMs;
    const existing = await db.query<HostCheckStateRow>(
      `SELECT node_id, last_check_at, last_status, last_summary, last_alert_at,
              last_repair_at, repair_failures
         FROM fleet_host_check_state WHERE node_id = $1`,
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

    // --- repair phase (only for failed checks, delegated to fleet-host-repair) ---
    let repairResult: FleetHostRepairResult | null = null;
    if (!options.dryRun && result.status === 'failed') {
      // Declarative per-node policy merges over the effective global layer
      // (explicit options override DB/env/default for tests & invocations).
      const policy = await loadNodeRecoveryPolicy(target.nodeId).catch(() => null);
      const effectiveGlobal: GlobalRepairConfig = {
        autoRepair,
        repairCooldownMs,
        repairMaxConsecutiveFailures,
        restartUnhealthy,
        quorumThreshold,
      };
      const cfg = resolveRepairConfig(policy, effectiveGlobal);
      repairResult = await runRepairPhase({
        target,
        check: result,
        lastRepairAtMs: toMs(prev?.last_repair_at),
        repairFailures: prev?.repair_failures ?? 0,
        autoRepair: cfg.autoRepair,
        repairCooldownMs: cfg.repairCooldownMs,
        repairMaxConsecutiveFailures: cfg.repairMaxConsecutiveFailures,
        restartUnhealthy: cfg.restartUnhealthy,
        quorumThreshold: cfg.quorumThreshold,
        offlineFleetShare: offlineFleetShare ?? 0,
        nowMs,
        sshTimeoutMs,
        repairRunner: options.repairRunner,
        tenantId: options.tenantId,
        projectId: options.projectId,
        scheduleId: options.scheduleId,
        runId: options.runId,
        quiet: options.quiet,
      });
      repairs.push(repairResult);
    }

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

    const prevFailures = prev?.repair_failures ?? 0;
    // Only confirmed failures (non-zero exit / ssh error) accumulate; an
    // 'attempted' outcome (ran but state not yet confirmed) only throttles via
    // last_repair_at and does not count toward manual takeover.
    const nextFailures = repairResult?.outcome === 'repaired'
      ? 0
      : repairResult?.outcome === 'failed'
        ? prevFailures + 1
        : prevFailures;
    const nextRepairAt = repairResult?.outcome === 'repaired'
      || repairResult?.outcome === 'failed'
      || repairResult?.outcome === 'attempted'
      ? now
      : (prev?.last_repair_at ?? null);

    await db.query(
      `INSERT INTO fleet_host_check_state
         (node_id, last_check_at, last_status, last_summary, last_detail_json, last_alert_at,
          last_repair_at, repair_failures, last_repair_result, updated_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10)
       ON CONFLICT (node_id) DO UPDATE SET
         last_check_at = EXCLUDED.last_check_at,
         last_status = EXCLUDED.last_status,
         last_summary = EXCLUDED.last_summary,
         last_detail_json = EXCLUDED.last_detail_json,
         last_alert_at = EXCLUDED.last_alert_at,
         last_repair_at = EXCLUDED.last_repair_at,
         repair_failures = EXCLUDED.repair_failures,
         last_repair_result = EXCLUDED.last_repair_result,
         updated_at = EXCLUDED.updated_at`,
      [
        target.nodeId,
        now,
        result.status,
        result.detail,
        JSON.stringify(result),
        nextAlertAt,
        nextRepairAt,
        nextFailures,
        repairResult?.detail ?? null,
        now,
      ],
    );
  }

  return {
    assessedAt: now.toISOString(),
    results,
    repairs,
    checked: results.filter((r) => r.status !== 'skipped').map((r) => r.nodeId),
    skipped: results.filter((r) => r.status === 'skipped').map((r) => r.nodeId),
    failed: results.filter((r) => r.status === 'failed').map((r) => r.nodeId),
    degraded: results.filter((r) => r.status === 'degraded').map((r) => r.nodeId),
    ok: results.filter((r) => r.status === 'ok').map((r) => r.nodeId),
    alertsEmitted,
  };
}
