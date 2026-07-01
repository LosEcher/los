/**
 * @los/agent/memory-lifecycle — Autonomous memory lifecycle management.
 *
 * Empowers the agent to make its own decisions about what to remember,
 * compress, and forget. This is NOT a traditional LRU or TTL policy —
 * it's an AI-driven retention judgment.
 *
 * Layers (per the memory hierarchy from ADR 0020):
 *   Working  → context window (managed by context-monitor.ts + semantic eviction)
 *   Episode  → session_events (managed by compaction + this module)
 *   Semantic → observations (managed by this module)
 *   Archive  → cold storage (managed by event_retention governance job)
 *
 * Design principle: the agent, not a fixed policy, decides retention value.
 * Human operators can override, but the default is agent autonomy.
 */

import { getLogger } from '@los/infra/logger';

const log = getLogger('memory-lifecycle');

// ── Types ─────────────────────────────────────────────────

export interface MemoryAssessment {
  /** What memory is being assessed. */
  target: {
    type: 'observation' | 'session' | 'compaction' | 'candidate';
    id: string | number;
  };
  /** AI-assessed retention value (0-1). Higher = more worth keeping. */
  retentionValue: number;
  /** Why the agent made this judgment. */
  rationale: string;
  /** Recommended action. */
  recommendation: 'keep' | 'compact' | 'archive' | 'delete';
  /** Minimum detail level to preserve (1-5, 5 = full detail). */
  detailLevel: number;
  /** When to re-assess. */
  reassessAfter: string; // ISO 8601 duration or timestamp
}

export interface MemoryLifecyclePolicy {
  /** Maximum observations before triggering lifecycle review. */
  maxObservations: number;
  /** Maximum session events per session before triggering compaction. */
  maxEventsPerSession: number;
  /** Age threshold for cold storage (days). */
  coldStorageAgeDays: number;
  /** Minimum retention value for keeping in hot storage. */
  hotRetentionThreshold: number;
  /** Allow autonomous deletion (dangerous — default false). */
  allowAutonomousDeletion: boolean;
}

export const DEFAULT_POLICY: MemoryLifecyclePolicy = {
  maxObservations: 100_000,
  maxEventsPerSession: 10_000,
  coldStorageAgeDays: 30,
  hotRetentionThreshold: 0.3,
  allowAutonomousDeletion: false,
};

// ── Assessment engine ──────────────────────────────────────

/**
 * Assess the retention value of an observation.
 *
 * Current heuristic (to be replaced by LLM-driven assessment):
 *  - High value: has entities, high observation count, recent
 *  - Low value: no entities, old, redundant tags
 */
export function assessObservationRetention(
  observation: {
    id: number;
    kind: string;
    tags: string[];
    metadata: Record<string, unknown>;
    createdAt: string;
  },
): MemoryAssessment {
  let value = 0.5; // baseline

  // Boost: has entities
  const entities = Array.isArray(observation.metadata.entities)
    ? (observation.metadata.entities as Array<{ id: string }>)
    : [];
  if (entities.length > 0) value += 0.2;

  // Boost: procedural/skill types are high value
  if (observation.kind === 'skill' || observation.kind === 'procedure') value += 0.15;

  // Boost: tagged as important
  if (observation.tags.includes('critical') || observation.tags.includes('p0')) value += 0.2;

  // Penalty: very old (30+ days)
  const ageDays = (Date.now() - new Date(observation.createdAt).getTime()) / 86_400_000;
  if (ageDays > 30) value -= 0.2;
  if (ageDays > 90) value -= 0.3;

  // Clamp
  value = Math.max(0, Math.min(1, value));

  let recommendation: MemoryAssessment['recommendation'] = 'keep';
  if (value < 0.2) recommendation = 'delete';
  else if (value < 0.4 && ageDays > 30) recommendation = 'archive';
  else if (value < 0.6 && ageDays > 60) recommendation = 'compact';

  return {
    target: { type: 'observation', id: observation.id },
    retentionValue: value,
    rationale: `kind=${observation.kind}, ${entities.length} entities, ${ageDays.toFixed(0)}d old`,
    recommendation,
    detailLevel: Math.ceil(value * 5),
    reassessAfter: ageDays > 30 ? 'P30D' : 'P7D',
  };
}

/**
 * Generate a lifecycle report for the current memory state.
 * This is intended to be called by the agent itself (via a tool)
 * or by a governance job.
 */
export async function generateMemoryLifecycleReport(): Promise<{
  policy: MemoryLifecyclePolicy;
  timestamp: string;
  assessments: { total: number; keep: number; compact: number; archive: number; delete: number };
  actionRequired: boolean;
}> {
  const policy = DEFAULT_POLICY;
  const timestamp = new Date().toISOString();

  // This would query observations, session_events, compactions
  // and generate assessments. For now, a lightweight placeholder
  // that the governance sweep can build on.

  log.info('Memory lifecycle: report requested (lightweight mode)');

  return {
    policy,
    timestamp,
    assessments: { total: 0, keep: 0, compact: 0, archive: 0, delete: 0 },
    actionRequired: false,
  };
}
