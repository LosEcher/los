/**
 * Node health index (B7, borrowed from mac-performance-monitor PressureIndex).
 *
 * A single continuous 0-100 number answering "how healthy is this executor
 * node?" — usable for ranking, trending and threshold alerts, instead of the
 * bare online/offline boolean.
 *
 * Design mirrors PressureIndex: a discrete level is authoritative for the
 * *band*, continuous signals position the index *within* the band.
 *
 *   level offline           -> 0-33
 *   level online, not candidate -> 34-66
 *   level online, candidate -> 67-100
 *
 * Within a band, signals (probe coverage, heartbeat freshness, blocker count,
 * verification debt) move the index toward the band edges. The index can never
 * read "calm" while the node is offline.
 */

export type NodeHealthLevel = 'offline' | 'degraded' | 'healthy';

export interface NodeHealthSignals {
  /** Probe modes verified ok out of attempted. */
  modesOk: number;
  modesTotal: number;
  /** Heartbeat freshness in seconds; 0 means never/unknown. */
  heartbeatAgeSec: number;
  /** Execution blockers beyond verification debt. */
  blockerCount: number;
  /** Whether any verification debt remains (verification:...:not_confirmed). */
  hasVerificationGap: boolean;
  /** Whether a previous offline status was recorded (recency penalty). */
  recovering: boolean;
}

export interface NodeHealthIndex {
  /** Continuous 0-100 score. */
  index: number;
  level: NodeHealthLevel;
  band: 'offline' | 'degraded' | 'healthy';
}

const OFFLINE_FLOOR = 0;
const DEGRADED_FLOOR = 34;
const HEALTHY_FLOOR = 67;
const BAND_SPAN = 33;

/** Seconds after the last heartbeat before freshness starts dragging the score. */
const FRESHNESS_GRACE_SEC = 120;
/** At this heartbeat age the freshness signal is fully degraded (0). */
const FRESHNESS_FULL_DEGRADE_SEC = 900;

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

/** Heartbeat freshness 0-1: 1 = just heartbeated, 0 = long stale. */
function freshnessSignal(ageSec: number): number {
  if (!(ageSec >= 0)) return 0;
  if (ageSec <= FRESHNESS_GRACE_SEC) return 1;
  return clamp01(1 - (ageSec - FRESHNESS_GRACE_SEC) / (FRESHNESS_FULL_DEGRADE_SEC - FRESHNESS_GRACE_SEC));
}

/**
 * Compute the health index for one node.
 *
 * @param status node status ('online' | 'offline')
 * @param candidate whether the node is a candidate for execution
 * @param signals probe/state signals
 * @returns index + level + band
 */
export function computeNodeHealthIndex(
  status: 'online' | 'offline',
  candidate: boolean,
  signals: NodeHealthSignals,
): NodeHealthIndex {
  // Offline is authoritative: hard floor band, signals only move within 0-33.
  if (status === 'offline') {
    const coverage = signals.modesTotal > 0 ? signals.modesOk / signals.modesTotal : 0;
    const freshness = freshnessSignal(signals.heartbeatAgeSec);
    const signal = clamp01(0.6 * coverage + 0.4 * freshness);
    return { index: Math.round(OFFLINE_FLOOR + signal * BAND_SPAN), level: 'offline', band: 'offline' };
  }

  // Online but not a candidate: degraded band. Signals: how close to candidate.
  if (!candidate) {
    // Verification gap is the most common blocker; treat it as mild.
    // Other blockers (resource/status) are heavier.
    const debt = signals.hasVerificationGap ? 0.25 : 0;
    const blockers = clamp01(signals.blockerCount / 3);
    const freshness = freshnessSignal(signals.heartbeatAgeSec);
    // Higher signal = closer to healthy: freshness matters most, then blockers.
    const health = clamp01(1 - (0.4 * blockers + 0.3 * debt + 0.3 * (1 - freshness)));
    return { index: Math.round(DEGRADED_FLOOR + health * BAND_SPAN), level: 'degraded', band: 'degraded' };
  }

  // Candidate: healthy band. Signals degrade from full.
  const coverage = signals.modesTotal > 0 ? signals.modesOk / signals.modesTotal : 1;
  const freshness = freshnessSignal(signals.heartbeatAgeSec);
  const recoveryPenalty = signals.recovering ? 0.15 : 0;
  const health = clamp01(0.5 * coverage + 0.5 * freshness - recoveryPenalty);
  return { index: Math.round(HEALTHY_FLOOR + health * BAND_SPAN), level: 'healthy', band: 'healthy' };
}

/** Extract blockers from an execution state (blockers list, excluding verification debt). */
export function blockerCountOf(blockers: string[]): number {
  if (!Array.isArray(blockers)) return 0;
  return blockers.filter((b) => !(typeof b === 'string' && b.startsWith('verification:') && b.endsWith(':not_confirmed'))).length;
}

/** Whether any verification debt remains. */
export function hasVerificationGapOf(blockers: string[]): boolean {
  if (!Array.isArray(blockers)) return false;
  return blockers.some((b) => typeof b === 'string' && b.startsWith('verification:') && b.endsWith(':not_confirmed'));
}

/** Heartbeat age in seconds; 0 when never/unknown. */
export function heartbeatAgeSecOf(lastHeartbeatAt: string | undefined, nowMs: number): number {
  if (!lastHeartbeatAt) return 0;
  const t = Date.parse(lastHeartbeatAt);
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, Math.floor((nowMs - t) / 1000));
}
