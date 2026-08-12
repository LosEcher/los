/**
 * Rate-limited auto-probe for online executors that still lack active verification.
 *
 * Heartbeats intentionally leave verified.ok=false until a real probe confirms the
 * health URL (see buildHeartbeatVerification). After path flaps, nodes can be
 * online+acceptingTasks yet candidate=false forever without this loop.
 *
 * Storm controls:
 * - at most maxPerTick probes per maintenance tick
 * - serial probes with minProbeGapMs between them
 * - per-node cooldownMs after any probe attempt (uses lastProbeAt)
 * - only executor + run_agent + verification:*:not_confirmed
 * - single-flight across ticks
 */

import type { FastifyInstance } from 'fastify';
import {
  listExecutorNodes,
  loadExecutorNode,
  recordExecutorNodeProbe,
  type ExecutorNodeConnectMode,
  type ExecutorNodeRecord,
} from '@los/agent/executor-nodes';
import { getLogger } from '@los/infra/logger';
import { probeNode } from './routes/node-probes.js';
import {
  isHeartbeatStaleForOutbound,
  isRemoteCircuitOpen,
  noteRemoteExecutorFailure,
  noteRemoteExecutorSuccess,
} from './remote-executor-circuit.js';

const log = getLogger('gateway');

export interface NodeAutoProbeOptions {
  /** Maintenance tick interval (default 120s). */
  intervalMs?: number;
  /** Max probes attempted in one tick (default 2). */
  maxPerTick?: number;
  /** Minimum delay between probes within a tick (default 2s). */
  minProbeGapMs?: number;
  /** Skip a node if lastProbeAt is newer than this (default 5m). */
  cooldownMs?: number;
  /** Initial delay before first tick (default 90s). */
  initialDelayMs?: number;
}

export interface AutoProbeTickResult {
  eligible: number;
  probed: string[];
  failed: string[];
  skippedCooldown: number;
}

const DEFAULTS = {
  intervalMs: 120_000,
  maxPerTick: 2,
  minProbeGapMs: 2_000,
  cooldownMs: 5 * 60_000,
  initialDelayMs: 90_000,
} as const;

/** Pure selection: online fleet executors blocked only by unverified preferred mode. */
export function selectAutoProbeTargets(
  nodes: ExecutorNodeRecord[],
  options: { cooldownMs?: number; now?: number } = {},
): ExecutorNodeRecord[] {
  const cooldownMs = options.cooldownMs ?? DEFAULTS.cooldownMs;
  const now = options.now ?? Date.now();

  return nodes
    .filter((node) => isAutoProbeEligible(node, cooldownMs, now))
    // Prefer freshest heartbeats — they just recovered and need candidate restore.
    .sort((a, b) => (b.lastHeartbeatAt ?? '').localeCompare(a.lastHeartbeatAt ?? ''));
}

export function isAutoProbeEligible(
  node: ExecutorNodeRecord,
  cooldownMs = DEFAULTS.cooldownMs,
  now = Date.now(),
): boolean {
  if (node.status !== 'online') return false;
  if (node.nodeKind !== 'executor') return false;
  if (node.capabilities?.run_agent !== true) return false;
  if (node.execution.candidate === true) return false;
  // Boot grace: do not probe while heartbeats are already stale (node mid-restart).
  if (isHeartbeatStaleForOutbound(node.lastHeartbeatAt, now)) return false;
  // Process-local circuit from prior ECONNREFUSED / fetch failures.
  if (isRemoteCircuitOpen(node.nodeId, now)) return false;

  const blockers = node.execution.blockers ?? [];
  // Only auto-heal verification debt — do not probe resource/status blockers.
  const hasVerificationGap = blockers.some(
    (b) => b.startsWith('verification:') && b.endsWith(':not_confirmed'),
  );
  if (!hasVerificationGap) return false;
  // If other hard blockers remain, probing cannot make them candidates anyway.
  const otherBlockers = blockers.filter(
    (b) => !(b.startsWith('verification:') && b.endsWith(':not_confirmed')),
  );
  if (otherBlockers.length > 0) return false;

  if (node.lastProbeAt) {
    const last = Date.parse(node.lastProbeAt);
    if (Number.isFinite(last) && now - last < cooldownMs) return false;
  }

  return true;
}

export async function runNodeAutoProbeTick(
  options: {
    maxPerTick?: number;
    minProbeGapMs?: number;
    cooldownMs?: number;
    now?: number;
    listNodes?: () => Promise<ExecutorNodeRecord[]>;
    probe?: typeof probeNode;
    record?: typeof recordExecutorNodeProbe;
    load?: typeof loadExecutorNode;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<AutoProbeTickResult> {
  const maxPerTick = options.maxPerTick ?? DEFAULTS.maxPerTick;
  const minProbeGapMs = options.minProbeGapMs ?? DEFAULTS.minProbeGapMs;
  const cooldownMs = options.cooldownMs ?? DEFAULTS.cooldownMs;
  const now = options.now ?? Date.now();
  const listNodes = options.listNodes ?? (() => listExecutorNodes(50));
  const probe = options.probe ?? probeNode;
  const record = options.record ?? recordExecutorNodeProbe;
  const load = options.load ?? loadExecutorNode;
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  const nodes = await listNodes();
  const eligible = selectAutoProbeTargets(nodes, { cooldownMs, now });
  const batch = eligible.slice(0, Math.max(0, maxPerTick));
  const probed: string[] = [];
  const failed: string[] = [];
  let skippedCooldown = Math.max(0, eligible.length - batch.length);

  for (let i = 0; i < batch.length; i += 1) {
    const target = batch[i]!;
    // Re-load to avoid racing a manual probe that just ran.
    const fresh = (await load(target.nodeId)) ?? target;
    if (!isAutoProbeEligible(fresh, cooldownMs, Date.now())) {
      skippedCooldown += 1;
      continue;
    }

    try {
      const result = await probe(fresh);
      await record({
        nodeId: fresh.nodeId,
        status: result.status,
        verified: result.verified,
        connectModes: fresh.connectModes as ExecutorNodeConnectMode[],
        connectConfig: fresh.connectConfig,
        capabilities: fresh.capabilities,
        queueDepth: fresh.queueDepth,
        activeTaskCount: fresh.activeTaskCount,
        meshLinks: fresh.meshLinks,
        lastProbeAt: new Date(),
        lastProbeError: result.lastProbeError ?? null,
      });
      if (result.status === 'online' && !result.lastProbeError) {
        probed.push(fresh.nodeId);
        noteRemoteExecutorSuccess(fresh.nodeId);
      } else {
        failed.push(fresh.nodeId);
        noteRemoteExecutorFailure(
          fresh.nodeId,
          result.lastProbeError ?? `probe status=${result.status}`,
        );
      }
    } catch (error) {
      failed.push(fresh.nodeId);
      const msg = error instanceof Error ? error.message : String(error);
      noteRemoteExecutorFailure(fresh.nodeId, msg);
      log.warn(`auto-probe ${fresh.nodeId} failed: ${msg}`);
      // Still stamp lastProbeAt via a soft record so cooldown applies.
      try {
        await record({
          nodeId: fresh.nodeId,
          status: fresh.status,
          verified: fresh.verified,
          connectModes: fresh.connectModes as ExecutorNodeConnectMode[],
          connectConfig: fresh.connectConfig,
          capabilities: fresh.capabilities,
          queueDepth: fresh.queueDepth,
          activeTaskCount: fresh.activeTaskCount,
          meshLinks: fresh.meshLinks,
          lastProbeAt: new Date(),
          lastProbeError: msg,
        });
      } catch {
        // ignore secondary write errors
      }
    }

    if (i + 1 < batch.length && minProbeGapMs > 0) {
      await sleep(minProbeGapMs);
    }
  }

  return { eligible: eligible.length, probed, failed, skippedCooldown };
}

/** Register single-flight auto-probe maintenance timer. */
export function registerNodeAutoProbe(
  app: FastifyInstance,
  options: NodeAutoProbeOptions = {},
): void {
  const intervalMs = options.intervalMs ?? DEFAULTS.intervalMs;
  const initialDelayMs = options.initialDelayMs ?? DEFAULTS.initialDelayMs;
  const maxPerTick = options.maxPerTick ?? DEFAULTS.maxPerTick;
  const minProbeGapMs = options.minProbeGapMs ?? DEFAULTS.minProbeGapMs;
  const cooldownMs = options.cooldownMs ?? DEFAULTS.cooldownMs;

  let closed = false;
  let running: Promise<void> | null = null;

  const invoke = (): void => {
    if (closed || running) return;
    running = runNodeAutoProbeTick({ maxPerTick, minProbeGapMs, cooldownMs })
      .then((result) => {
        if (result.probed.length > 0 || result.failed.length > 0) {
          log.info(
            `auto-probe: eligible=${result.eligible} probed=${result.probed.join(',') || '-'} ` +
              `failed=${result.failed.join(',') || '-'} skippedCooldown=${result.skippedCooldown}`,
          );
        }
      })
      .catch((error) => {
        log.warn(`auto-probe tick failed: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        running = null;
      });
  };

  const timeout = setTimeout(invoke, initialDelayMs);
  const timer = setInterval(invoke, intervalMs);
  app.addHook('onClose', async () => {
    closed = true;
    clearTimeout(timeout);
    clearInterval(timer);
    if (running) await running;
  });
}
