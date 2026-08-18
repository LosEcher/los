/**
 * Fleet host auto-repair (P2.5 control-plane fallback).
 *
 * Separated from fleet-host-checks.ts so the checker stays under the module
 * size gate. Node-side supervisors (systemd / nssm watchdog / launchd) remain
 * the primary self-heal path; this module is the operator-consented fallback
 * that SSH-starts a dead unit/service from the control plane.
 *
 * Anti-storm gates, in order: feature flag → healthy → unit missing →
 * repair cooldown → consecutive failures → quorum guard.
 */

import { getLogger } from '@los/infra/logger';
import { listExecutorNodes } from './executor-nodes.js';
import {
  beginOutOfBandNodeCommand,
  completeOutOfBandNodeCommand,
} from './node-commands.js';
import {
  parseRepairOutput,
  runHostRepair,
  type FleetHostRepairAction,
  type FleetHostCheckResult,
  type FleetHostTarget,
  type SshCommandResult,
} from './fleet-host-check-ssh.js';
import { appendSessionEvent } from './session-events.js';

const log = getLogger('fleet-host-repair');

export const DEFAULT_FLEET_REPAIR_COOLDOWN_MS = 30 * 60_000;
export const DEFAULT_FLEET_REPAIR_MAX_CONSECUTIVE_FAILURES = 3;
/** Skip repair when this share of fleet nodes is offline (control-plane outage guard). */
export const DEFAULT_FLEET_REPAIR_QUORUM_THRESHOLD = 0.5;

export type FleetHostRepairOutcome = 'attempted' | 'repaired' | 'failed' | 'skipped';
export type FleetHostRepairSkipReason =
  | 'disabled'
  | 'repair_cooldown'
  | 'quorum_guard'
  | 'unit_missing'
  | 'consecutive_failures'
  | 'healthy'
  | 'unhealthy_unit';

export interface FleetHostRepairResult {
  nodeId: string;
  action: FleetHostRepairAction | null;
  outcome: FleetHostRepairOutcome;
  skipReason?: FleetHostRepairSkipReason;
  detail: string;
  durationMs: number;
  exitCode?: number | null;
}

export interface RepairDecisionContext {
  target: FleetHostTarget;
  check: FleetHostCheckResult;
  lastRepairAtMs: number;
  repairFailures: number;
  autoRepair: boolean;
  repairCooldownMs: number;
  repairMaxConsecutiveFailures: number;
  restartUnhealthy: boolean;
  nowMs: number;
  /** Share of fleet nodes currently offline in the registry (0..1). */
  offlineFleetShare: number;
  /** Quorum threshold override (node policy > global > default 0.5). */
  quorumThreshold?: number;
}

export interface RepairDecision {
  action: FleetHostRepairAction | null;
  skipReason?: FleetHostRepairSkipReason;
  detail: string;
}

/**
 * Pure repair gate: decide whether a failed host check may be auto-repaired.
 * Anti-storm gates, in order: feature flag → healthy → unit missing →
 * repair cooldown → consecutive failures → quorum guard (control-plane outage).
 */
export function decideFleetHostRepair(ctx: RepairDecisionContext): RepairDecision {
  if (!ctx.autoRepair) {
    return { action: null, skipReason: 'disabled', detail: 'auto-repair disabled' };
  }
  if (ctx.check.status !== 'failed') {
    return { action: null, skipReason: 'healthy', detail: `status=${ctx.check.status}` };
  }
  if (ctx.check.unitActive === 'missing') {
    return {
      action: null,
      skipReason: 'unit_missing',
      detail: 'unit/service missing on host; manual intervention required',
    };
  }
  if (ctx.lastRepairAtMs > 0 && ctx.nowMs - ctx.lastRepairAtMs < ctx.repairCooldownMs) {
    return {
      action: null,
      skipReason: 'repair_cooldown',
      detail: `cooldown ${Math.round((ctx.repairCooldownMs - (ctx.nowMs - ctx.lastRepairAtMs)) / 1000)}s remaining`,
    };
  }
  if (ctx.repairFailures >= ctx.repairMaxConsecutiveFailures) {
    return {
      action: null,
      skipReason: 'consecutive_failures',
      detail: `repair failed ${ctx.repairFailures}x consecutively; manual takeover`,
    };
  }
  if (ctx.offlineFleetShare > (ctx.quorumThreshold ?? DEFAULT_FLEET_REPAIR_QUORUM_THRESHOLD)) {
    const threshold = ctx.quorumThreshold ?? DEFAULT_FLEET_REPAIR_QUORUM_THRESHOLD;
    return {
      action: null,
      skipReason: 'quorum_guard',
      detail: `offline share ${(ctx.offlineFleetShare * 100).toFixed(0)}% > ${threshold * 100}%; likely control-plane/network outage, skipping repair`,
    };
  }
  // Unit down -> start. Unit up but unhealthy -> restart only when explicitly
  // enabled (restarting a live executor can interrupt active tasks).
  const down = ctx.check.unitActive === 'inactive'
    || ctx.check.unitActive === 'stopped'
    || ctx.check.unitActive === 'failed';
  if (!down) {
    if (ctx.restartUnhealthy) {
      return {
        action: 'restart',
        detail: `unit ${ctx.check.unitActive ?? 'n/a'} but health bad -> restart (restart-unhealthy enabled)`,
      };
    }
    return {
      action: null,
      skipReason: 'unhealthy_unit',
      detail: `unit ${ctx.check.unitActive ?? 'n/a'} is up but health bad; restart disabled (LOS_FLEET_REPAIR_RESTART_UNHEALTHY=false)`,
    };
  }
  return {
    action: 'start',
    detail: `unit ${ctx.check.unitActive} -> start`,
  };
}

/**
 * Compute the offline share among the given fleet node ids using the
 * executor registry. Returns 0 when the registry is unreachable (fail open:
 * the quorum guard must not block repair because of a registry read failure).
 */
export async function measureFleetOfflineShare(
  nodeIds: string[],
  listNodes: () => Promise<Array<{ nodeId: string; status: string }>> = async () => {
    const nodes = await listExecutorNodes(200);
    return nodes.map((n) => ({ nodeId: n.nodeId, status: n.status }));
  },
): Promise<number> {
  if (nodeIds.length === 0) return 0;
  try {
    const nodes = await listNodes();
    const fleet = nodes.filter((n) => nodeIds.includes(n.nodeId));
    if (fleet.length === 0) return 0;
    const offline = fleet.filter((n) => n.status !== 'online').length;
    return offline / fleet.length;
  } catch {
    return 0;
  }
}

export interface FleetRepairPhaseInput {
  target: FleetHostTarget;
  check: FleetHostCheckResult;
  lastRepairAtMs: number;
  repairFailures: number;
  autoRepair: boolean;
  repairCooldownMs: number;
  repairMaxConsecutiveFailures: number;
  restartUnhealthy: boolean;
  offlineFleetShare: number;
  nowMs: number;
  quorumThreshold?: number;
  sshTimeoutMs: number;
  repairRunner?: (
    target: FleetHostTarget,
    action: FleetHostRepairAction,
    timeoutMs: number,
  ) => Promise<SshCommandResult>;
  tenantId?: string;
  projectId?: string;
  scheduleId?: string;
  runId?: string;
  quiet?: boolean;
}

/**
 * Run one repair phase for a failed host check: decide → audit decision →
 * begin out-of-band command → SSH execute → complete command → audit result.
 * Returns the repair result; never throws.
 */
export async function runRepairPhase(input: FleetRepairPhaseInput): Promise<FleetHostRepairResult> {
  const decision = decideFleetHostRepair({
    target: input.target,
    check: input.check,
    lastRepairAtMs: input.lastRepairAtMs,
    repairFailures: input.repairFailures,
    autoRepair: input.autoRepair,
    repairCooldownMs: input.repairCooldownMs,
    repairMaxConsecutiveFailures: input.repairMaxConsecutiveFailures,
    restartUnhealthy: input.restartUnhealthy,
    nowMs: input.nowMs,
    offlineFleetShare: input.offlineFleetShare,
    quorumThreshold: input.quorumThreshold,
  });

  // Decision audit — emitted for every failed check, including skips, so
  // "why not repaired" is replayable (event-sourced decision trail).
  if (!input.quiet) {
    try {
      await appendSessionEvent({
        sessionId: `ops:fleet-repair:${input.target.nodeId}`,
        type: 'ops.fleet_host_repair_decision',
        source: 'ops',
        tenantId: input.tenantId?.trim() || 'local',
        projectId: input.projectId?.trim() || 'los',
        payload: {
          kind: 'fleet_host_repair_decision',
          severity: 'info',
          title: `舰队主机修复决策: ${input.target.nodeId} (${decision.action ?? decision.skipReason ?? 'none'})`,
          detail: decision.detail,
          reason: decision.detail,
          nodeId: input.target.nodeId,
          sshHost: input.target.sshHost,
          action: decision.action,
          skipReason: decision.skipReason ?? null,
          offlineShare: input.offlineFleetShare,
          repairFailures: input.repairFailures,
          lastRepairAtMs: input.lastRepairAtMs || null,
          autoRepair: input.autoRepair,
          repairCooldownMs: input.repairCooldownMs,
          scheduleId: input.scheduleId ?? null,
          runId: input.runId ?? null,
          requiresDecision: false,
        },
      });
    } catch (err) {
      log.warn(
        `fleet host repair decision event emit failed node=${input.target.nodeId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  if (!decision.action) {
    return {
      nodeId: input.target.nodeId,
      action: null,
      outcome: 'skipped',
      skipReason: decision.skipReason,
      detail: decision.detail,
      durationMs: 0,
    };
  }

  // Out-of-band command record (running) — same node_commands contract
  // surface as executor-side commands, for unified operator audit.
  let commandId: string | null = null;
  try {
    const cmd = await beginOutOfBandNodeCommand({
      nodeId: input.target.nodeId,
      action: decision.action,
      traceId: input.runId,
      reason: `fleet auto-repair: ${decision.detail}`,
    });
    commandId = cmd.commandId;
  } catch (err) {
    log.warn(
      `fleet out-of-band command record failed node=${input.target.nodeId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  const started = Date.now();
  let repairRaw: SshCommandResult;
  try {
    if (input.repairRunner) {
      repairRaw = await input.repairRunner(input.target, decision.action, input.sshTimeoutMs);
    } else {
      repairRaw = await runHostRepair(input.target, decision.action, input.sshTimeoutMs);
    }
  } catch (err) {
    repairRaw = {
      stdout: '',
      stderr: '',
      exitCode: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  const parsed = parseRepairOutput(`${repairRaw.stdout}\n${repairRaw.stderr}`);
  const state = parsed.state;
  const commandFailed = Boolean(repairRaw.error)
    || (parsed.exitCode !== undefined && parsed.exitCode !== 0);
  const success = !commandFailed && (state === 'active' || state === 'running');
  const outcome: FleetHostRepairOutcome = commandFailed
    ? 'failed'
    : success
      ? 'repaired'
      : 'attempted';
  const result: FleetHostRepairResult = {
    nodeId: input.target.nodeId,
    action: decision.action,
    outcome,
    detail: success
      ? `repair ${decision.action} -> ${state}`
      : `repair ${decision.action} incomplete: ${repairRaw.error ?? `state=${state ?? 'unknown'}`}`,
    durationMs: Date.now() - started,
    exitCode: repairRaw.exitCode,
  };

  if (commandId) {
    try {
      await completeOutOfBandNodeCommand(commandId, {
        status: outcome === 'failed' ? 'failed' : 'succeeded',
        output: {
          action: decision.action,
          sshExitCode: repairRaw.exitCode ?? null,
          repairState: state ?? null,
          outcome,
          detail: result.detail,
        },
        error: repairRaw.error
          ?? (commandFailed && parsed.exitCode !== undefined
            ? `REPAIR_EXIT=${parsed.exitCode}`
            : undefined),
      });
    } catch (err) {
      log.warn(
        `fleet out-of-band command complete failed node=${input.target.nodeId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  if (!input.quiet) {
    try {
      await appendSessionEvent({
        sessionId: `ops:fleet-repair:${input.target.nodeId}`,
        type: 'ops.fleet_host_repair',
        source: 'ops',
        tenantId: input.tenantId?.trim() || 'local',
        projectId: input.projectId?.trim() || 'los',
        payload: {
          kind: 'fleet_host_repair',
          severity: outcome === 'repaired' ? 'info' : 'warning',
          title: `舰队主机修复: ${input.target.nodeId} (${outcome})`,
          detail: result.detail,
          reason: result.detail,
          nodeId: input.target.nodeId,
          sshHost: input.target.sshHost,
          action: decision.action,
          outcome,
          exitCode: repairRaw.exitCode ?? null,
          commandId,
          scheduleId: input.scheduleId ?? null,
          runId: input.runId ?? null,
          requiresDecision: false,
        },
      });
    } catch (err) {
      log.warn(
        `fleet host repair event emit failed node=${input.target.nodeId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  return result;
}
