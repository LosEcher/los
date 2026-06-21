/**
 * @los/memory/scope-acl — Memory scope hierarchy and access control.
 *
 * Memory observations exist at one of four scope levels, ascending:
 *   session < project < user < global
 *
 * Higher scopes subsume lower ones for read access. Write access
 * is constrained: you can write at your scope or below, never above.
 * Promotion between scopes requires evidence gates (see PromotionGate).
 *
 * Aligns with RuleScope ('global' | 'user' | 'project') from @los/agent/rules,
 * adding 'session' as the most granular level.
 */

import type { CandidateStatus } from './compaction.js';

// ── Scope type ────────────────────────────────────────────

/**
 * Memory scope hierarchy (ascending).
 *
 * | Scope     | Visibility                   | Typical lifetime       |
 * |-----------|------------------------------|------------------------|
 * | session   | Within the same session      | Session duration       |
 * | project   | Within the project           | Days–weeks (compacted) |
 * | user      | Across user's projects       | Weeks–months           |
 * | global    | All users, all projects      | Indefinite (permanent) |
 */
export type MemoryScope = 'session' | 'project' | 'user' | 'global';

/** Ordered from narrowest to broadest. */
const SCOPE_ORDER: MemoryScope[] = ['session', 'project', 'user', 'global'];

/**
 * Return the numeric rank of a scope (0 = session, 3 = global).
 * Unknown strings default to 'session' (most restrictive).
 */
export function scopeRank(scope: string): number {
  const idx = SCOPE_ORDER.indexOf(scope as MemoryScope);
  return idx >= 0 ? idx : 0;
}

/**
 * Normalize an arbitrary string to a valid MemoryScope.
 * Unknown values fall back to 'session'.
 */
export function normalizeScope(raw: string | undefined | null): MemoryScope {
  if (!raw) return 'session';
  return SCOPE_ORDER.includes(raw as MemoryScope) ? (raw as MemoryScope) : 'session';
}

// ── ACL ───────────────────────────────────────────────────

export interface MemoryAccessContext {
  /** The scope of the requester (derived from session/tenant/user context). */
  requesterScope: MemoryScope;
  /** The scope of the target observation or resource. */
  targetScope: MemoryScope;
  /** When true, the requester is the same session/project/user as the target. */
  sameSession?: boolean;
  sameProject?: boolean;
  sameUser?: boolean;
  /** Operator override — humans can cross scope boundaries. */
  isOperator?: boolean;
}

/**
 * Can the requester READ the target observation?
 *
 * Read is hierarchical: higher scope can read lower, and same-scope
 * can read within the same boundary. Operators can read everything.
 *
 * Rules:
 * - requester scope >= target scope  →  allow
 * - requester scope == target scope AND same boundary  →  allow
 * - isOperator  →  allow
 */
export function canAccessMemory(ctx: MemoryAccessContext): boolean {
  if (ctx.isOperator) return true;

  const reqRank = scopeRank(ctx.requesterScope);
  const tgtRank = scopeRank(ctx.targetScope);

  // Higher scope can read lower scope
  if (reqRank > tgtRank) return true;

  // Same scope requires same boundary
  if (reqRank === tgtRank) {
    switch (ctx.requesterScope) {
      case 'session': return ctx.sameSession === true;
      case 'project': return ctx.sameProject === true;
      case 'user':    return ctx.sameUser === true;
      case 'global':  return true; // global reads global always
    }
  }

  // reqRank < tgtRank: lower scope cannot read higher scope
  return false;
}

/**
 * Can the requester WRITE at the target scope?
 *
 * Write is downward-only: you can write at your scope or below.
 * Writing at a higher scope than your own is denied.
 *
 * Rules:
 * - requester scope >= target scope  →  allow
 * - isOperator  →  allow (can write at any scope)
 */
export function canWriteToScope(ctx: MemoryAccessContext): boolean {
  if (ctx.isOperator) return true;
  return scopeRank(ctx.requesterScope) >= scopeRank(ctx.targetScope);
}

/**
 * Can the requester DELETE the target observation?
 *
 * Delete requires ownership: same scope AND same boundary,
 * or higher scope. Operators can delete anything.
 */
export function canDeleteMemory(ctx: MemoryAccessContext): boolean {
  if (ctx.isOperator) return true;

  const reqRank = scopeRank(ctx.requesterScope);
  const tgtRank = scopeRank(ctx.targetScope);

  // Higher scope can delete lower scope's observations
  if (reqRank > tgtRank) return true;

  // Same scope requires same boundary ownership
  if (reqRank === tgtRank) {
    switch (ctx.requesterScope) {
      case 'session': return ctx.sameSession === true;
      case 'project': return ctx.sameProject === true;
      case 'user':    return ctx.sameUser === true;
      case 'global':  return false; // no one owns global — operator only
    }
  }

  return false;
}

// ── Scope resolution ──────────────────────────────────────

export interface ScopeResolutionInput {
  sessionId?: string | null;
  tenantId?: string | null;
  projectId?: string | null;
  userId?: string | null;
  nodeId?: string | null;
}

/**
 * Resolve the effective memory scope from runtime context.
 *
 * Priority: explicit metadata.scope > context-derived scope > 'session' default.
 *
 * Derivation:
 * - Has userId but no projectId → 'user'
 * - Has projectId → 'project'
 * - Has sessionId but no projectId → 'session'
 * - None of the above → 'session'
 */
export function resolveMemoryScope(input: ScopeResolutionInput): MemoryScope {
  if (input.userId && !input.projectId) return 'user';
  if (input.projectId) return 'project';
  if (input.sessionId) return 'session';
  return 'session';
}

// ── Promotion gate ────────────────────────────────────────

export interface PromotionEvidence {
  /** Current scope of the observation. */
  fromScope: MemoryScope;
  /** Number of cross-session references. */
  crossSessionEvidence: number;
  /** Number of distinct projects that have referenced this observation. */
  crossProjectEvidence: number;
  /** Number of distinct users that have referenced this observation. */
  crossUserEvidence: number;
  /** Whether a compaction has attested this observation as meaningful. */
  compactionAttested: boolean;
  /** Whether an operator has explicitly approved promotion. */
  operatorApproved: boolean;
  /** Number of days since the observation was created. */
  daysSinceCreation: number;
  /** Observation kind (note, fact, rule, decision). */
  kind: string;
}

export interface PromotionDecision {
  /** Can the observation be promoted? */
  allowed: boolean;
  /** Target scope if allowed. */
  targetScope: MemoryScope | null;
  /** Required scope to attempt promotion (what the caller needs). */
  requiredCallerScope: MemoryScope | null;
  /** Human-readable reason for the decision. */
  reason: string;
  /** Which gate criterion was met (or which was missing). */
  gate: string;
}

/**
 * Promotion gate: decide whether an observation can move from one scope to the next.
 *
 * Gates (ascending):
 *
 *   session → project (ephemeral → durable):
 *     - Observation must be compacted AND attested
 *     - OR: cross-session evidence >= 2
 *     - OR: kind is 'fact' or 'rule' (compaction-classified)
 *     - Caller must have at least 'project' scope
 *
 *   project → user (durable → cross-project):
 *     - Cross-project evidence >= 1 (observed in >1 project)
 *     - OR: operator approved
 *     - Caller must have at least 'user' scope
 *
 *   user → global (cross-project → permanent):
 *     - Operator attestation REQUIRED (no automatic promotion)
 *     - Cross-user evidence >= 2 (observed by >1 distinct user)
 *     - OR: operator explicitly sets retention=permanent
 *     - Caller must be operator (not automated)
 */
export function evaluatePromotion(
  fromScope: MemoryScope,
  evidence: PromotionEvidence,
): PromotionDecision {
  // Already at global — cannot promote further
  if (fromScope === 'global') {
    return {
      allowed: false,
      targetScope: null,
      requiredCallerScope: null,
      reason: 'Already at global scope — maximum visibility',
      gate: 'at-max',
    };
  }

  // Gate: session → project
  if (fromScope === 'session') {
    const hasEvidence =
      (evidence.compactionAttested) ||
      (evidence.crossSessionEvidence >= 2) ||
      (evidence.kind === 'fact' || evidence.kind === 'rule');

    if (hasEvidence) {
      return {
        allowed: true,
        targetScope: 'project',
        requiredCallerScope: 'project',
        reason: evidence.compactionAttested
          ? 'Compaction attested — promoting to project scope'
          : evidence.crossSessionEvidence >= 2
            ? `Cross-session evidence from ${evidence.crossSessionEvidence} sessions`
            : `Classified as ${evidence.kind} — promoting to project scope`,
        gate: evidence.compactionAttested ? 'compaction-attested'
          : evidence.crossSessionEvidence >= 2 ? 'cross-session-evidence'
          : 'classification',
      };
    }

    return {
      allowed: false,
      targetScope: 'project',
      requiredCallerScope: 'project',
      reason: `Insufficient evidence: need compaction attestation OR >=2 cross-session references OR kind=fact/rule (have: attested=${evidence.compactionAttested}, crossSessions=${evidence.crossSessionEvidence}, kind=${evidence.kind})`,
      gate: 'insufficient-evidence',
    };
  }

  // Gate: project → user
  if (fromScope === 'project') {
    const hasEvidence =
      evidence.operatorApproved ||
      evidence.crossProjectEvidence >= 1;

    if (hasEvidence) {
      return {
        allowed: true,
        targetScope: 'user',
        requiredCallerScope: 'user',
        reason: evidence.operatorApproved
          ? 'Operator approved — promoting to user scope'
          : `Cross-project evidence from ${evidence.crossProjectEvidence} project(s)`,
        gate: evidence.operatorApproved ? 'operator-approved' : 'cross-project-evidence',
      };
    }

    return {
      allowed: false,
      targetScope: 'user',
      requiredCallerScope: 'user',
      reason: `Insufficient evidence: need operator approval OR >=1 cross-project reference (have: approved=${evidence.operatorApproved}, crossProjects=${evidence.crossProjectEvidence})`,
      gate: 'insufficient-evidence',
    };
  }

  // Gate: user → global (highest bar)
  if (fromScope === 'user') {
    // REQUIRES operator attestation — no automatic gate
    if (!evidence.operatorApproved) {
      return {
        allowed: false,
        targetScope: 'global',
        requiredCallerScope: 'global',
        reason: 'Promotion to global scope requires explicit operator attestation (no automatic promotion)',
        gate: 'operator-required',
      };
    }

    const hasEvidence = evidence.crossUserEvidence >= 2 || evidence.compactionAttested;

    if (hasEvidence) {
      return {
        allowed: true,
        targetScope: 'global',
        requiredCallerScope: 'global',
        reason: `Operator attested with ${evidence.crossUserEvidence} cross-user reference(s) — promoting to global scope`,
        gate: 'operator-attested',
      };
    }

    return {
      allowed: false,
      targetScope: 'global',
      requiredCallerScope: 'global',
      reason: `Operator attested but insufficient cross-user evidence (need >=2, have ${evidence.crossUserEvidence})`,
      gate: 'insufficient-evidence',
    };
  }

  // Should never reach here
  return {
    allowed: false,
    targetScope: null,
    requiredCallerScope: null,
    reason: `Unknown scope: ${fromScope}`,
    gate: 'unknown-scope',
  };
}

/**
 * Next scope in the hierarchy, or null if already at global.
 */
export function nextScope(current: MemoryScope): MemoryScope | null {
  const idx = SCOPE_ORDER.indexOf(current);
  if (idx < 0 || idx >= SCOPE_ORDER.length - 1) return null;
  return SCOPE_ORDER[idx + 1]!;
}

/**
 * Check whether a CandidateStatus transitions to a given scope.
 *
 * | Status    | Effective Scope |
 * |-----------|-----------------|
 * | draft     | session         |
 * | review    | project         |
 * | approved  | user            |
 * | active    | global          |
 * | retired   | (none)          |
 */
export function candidateStatusToScope(status: CandidateStatus): MemoryScope | null {
  switch (status) {
    case 'draft':    return 'session';
    case 'review':   return 'project';
    case 'approved': return 'user';
    case 'active':   return 'global';
    case 'retired':  return null;
  }
}

/**
 * Map a MemoryScope to the minimum CandidateStatus required.
 */
export function scopeToCandidateStatus(scope: MemoryScope): CandidateStatus {
  switch (scope) {
    case 'session': return 'draft';
    case 'project': return 'review';
    case 'user':    return 'approved';
    case 'global':  return 'active';
  }
}
