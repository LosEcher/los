/**
 * Tests for @los/memory/scope-acl — pure logic, no DB required.
 */

import assert from 'node:assert';
import { describe, it } from 'node:test';
import {
  normalizeScope,
  scopeRank,
  resolveMemoryScope,
  canAccessMemory,
  canWriteToScope,
  canDeleteMemory,
  ownsObservationBoundary,
  canMutateObservation,
  evaluatePromotion,
  nextScope,
  candidateStatusToScope,
  scopeToCandidateStatus,
} from './core/scope-acl.js';
import type { MemoryScope } from './core/scope-acl.js';

describe('normalizeScope', () => {
  it('returns valid scopes unchanged', () => {
    assert.strictEqual(normalizeScope('session'), 'session');
    assert.strictEqual(normalizeScope('project'), 'project');
    assert.strictEqual(normalizeScope('user'), 'user');
    assert.strictEqual(normalizeScope('global'), 'global');
  });

  it('defaults to session for unknown/null/empty', () => {
    assert.strictEqual(normalizeScope('unknown'), 'session');
    assert.strictEqual(normalizeScope(null), 'session');
    assert.strictEqual(normalizeScope(undefined), 'session');
    assert.strictEqual(normalizeScope(''), 'session');
  });
});

describe('scopeRank', () => {
  it('session=0, project=1, user=2, global=3', () => {
    assert.strictEqual(scopeRank('session'), 0);
    assert.strictEqual(scopeRank('project'), 1);
    assert.strictEqual(scopeRank('user'), 2);
    assert.strictEqual(scopeRank('global'), 3);
  });

  it('unknown defaults to 0', () => {
    assert.strictEqual(scopeRank('unknown'), 0);
  });
});

describe('resolveMemoryScope', () => {
  it('derives scope from context', () => {
    assert.strictEqual(resolveMemoryScope({ sessionId: 's1' }), 'session');
    assert.strictEqual(resolveMemoryScope({ projectId: 'p1' }), 'project');
    assert.strictEqual(resolveMemoryScope({ userId: 'u1' }), 'user');
    assert.strictEqual(resolveMemoryScope({}), 'session');
  });
});

describe('canAccessMemory', () => {
  it('operator can read everything', () => {
    assert.strictEqual(canAccessMemory({
      requesterScope: 'session', targetScope: 'global', isOperator: true,
    }), true);
  });

  it('higher scope can read lower', () => {
    assert.strictEqual(canAccessMemory({
      requesterScope: 'global', targetScope: 'session',
    }), true);
  });

  it('same scope+same boundary can read', () => {
    assert.strictEqual(canAccessMemory({
      requesterScope: 'project', targetScope: 'project', sameProject: true,
    }), true);
  });

  it('same scope+different boundary cannot read', () => {
    assert.strictEqual(canAccessMemory({
      requesterScope: 'project', targetScope: 'project', sameProject: false,
    }), false);
  });

  it('lower scope cannot read higher', () => {
    assert.strictEqual(canAccessMemory({
      requesterScope: 'session', targetScope: 'project',
    }), false);
  });

  it('global reads global always', () => {
    assert.strictEqual(canAccessMemory({
      requesterScope: 'global', targetScope: 'global',
    }), true);
  });
});

describe('canWriteToScope', () => {
  it('operator can write at any scope', () => {
    assert.strictEqual(canWriteToScope({
      requesterScope: 'session', targetScope: 'global', isOperator: true,
    }), true);
  });

  it('can write at own scope or below', () => {
    assert.strictEqual(canWriteToScope({
      requesterScope: 'project', targetScope: 'project',
    }), true);
    assert.strictEqual(canWriteToScope({
      requesterScope: 'user', targetScope: 'session',
    }), true);
  });

  it('cannot write above own scope', () => {
    assert.strictEqual(canWriteToScope({
      requesterScope: 'session', targetScope: 'project',
    }), false);
  });
});

describe('canDeleteMemory', () => {
  it('operator can delete anything', () => {
    assert.strictEqual(canDeleteMemory({
      requesterScope: 'session', targetScope: 'global', isOperator: true,
    }), true);
  });

  it('same scope+same session can delete', () => {
    assert.strictEqual(canDeleteMemory({
      requesterScope: 'session', targetScope: 'session', sameSession: true,
    }), true);
  });

  it('higher scope can delete lower', () => {
    assert.strictEqual(canDeleteMemory({
      requesterScope: 'user', targetScope: 'session',
    }), true);
  });

  it('non-operator cannot delete global', () => {
    assert.strictEqual(canDeleteMemory({
      requesterScope: 'global', targetScope: 'global',
    }), false);
  });
});

describe('evaluatePromotion', () => {
  const baseEvidence = {
    fromScope: 'session' as MemoryScope,
    crossSessionEvidence: 0,
    crossProjectEvidence: 0,
    crossUserEvidence: 0,
    compactionAttested: false,
    operatorApproved: false,
    daysSinceCreation: 1,
    kind: 'note',
  };

  it('global cannot be promoted further', () => {
    const result = evaluatePromotion('global', baseEvidence);
    assert.strictEqual(result.allowed, false);
    assert.strictEqual(result.gate, 'at-max');
  });

  it('session→project: attested compaction allows promotion', () => {
    const result = evaluatePromotion('session', {
      ...baseEvidence, compactionAttested: true,
    });
    assert.strictEqual(result.allowed, true);
    assert.strictEqual(result.targetScope, 'project');
    assert.strictEqual(result.gate, 'compaction-attested');
  });

  it('session→project: >=2 cross-session evidence allows promotion', () => {
    const result = evaluatePromotion('session', {
      ...baseEvidence, crossSessionEvidence: 2,
    });
    assert.strictEqual(result.allowed, true);
    assert.strictEqual(result.targetScope, 'project');
  });

  it('session→project: kind=fact allows promotion', () => {
    const result = evaluatePromotion('session', {
      ...baseEvidence, kind: 'fact',
    });
    assert.strictEqual(result.allowed, true);
  });

  it('session→project: insufficient evidence blocks promotion', () => {
    const result = evaluatePromotion('session', baseEvidence);
    assert.strictEqual(result.allowed, false);
    assert.strictEqual(result.gate, 'insufficient-evidence');
  });

  it('project→user: operator approved allows promotion', () => {
    const result = evaluatePromotion('project', {
      ...baseEvidence, operatorApproved: true,
    });
    assert.strictEqual(result.allowed, true);
    assert.strictEqual(result.targetScope, 'user');
  });

  it('project→user: cross-project evidence allows promotion', () => {
    const result = evaluatePromotion('project', {
      ...baseEvidence, crossProjectEvidence: 1,
    });
    assert.strictEqual(result.allowed, true);
  });

  it('user→global: REQUIRES operator attestation', () => {
    const result = evaluatePromotion('user', {
      ...baseEvidence, crossUserEvidence: 5,
    });
    assert.strictEqual(result.allowed, false);
    assert.strictEqual(result.gate, 'operator-required');
  });

  it('user→global: operator + >=2 cross-user evidence allows promotion', () => {
    const result = evaluatePromotion('user', {
      ...baseEvidence, operatorApproved: true, crossUserEvidence: 3,
    });
    assert.strictEqual(result.allowed, true);
    assert.strictEqual(result.targetScope, 'global');
  });
});

describe('nextScope', () => {
  it('returns the next scope in hierarchy', () => {
    assert.strictEqual(nextScope('session'), 'project');
    assert.strictEqual(nextScope('project'), 'user');
    assert.strictEqual(nextScope('user'), 'global');
    assert.strictEqual(nextScope('global'), null);
  });
});

describe('candidateStatusToScope', () => {
  it('maps candidate status to memory scope', () => {
    assert.strictEqual(candidateStatusToScope('draft'), 'session');
    assert.strictEqual(candidateStatusToScope('review'), 'project');
    assert.strictEqual(candidateStatusToScope('approved'), 'user');
    assert.strictEqual(candidateStatusToScope('active'), 'global');
    assert.strictEqual(candidateStatusToScope('retired'), null);
  });
});

describe('scopeToCandidateStatus', () => {
  it('maps scope to minimum candidate status', () => {
    assert.strictEqual(scopeToCandidateStatus('session'), 'draft');
    assert.strictEqual(scopeToCandidateStatus('project'), 'review');
    assert.strictEqual(scopeToCandidateStatus('user'), 'approved');
    assert.strictEqual(scopeToCandidateStatus('global'), 'active');
  });
});

describe('ownsObservationBoundary', () => {
  it('allows operator across projects', () => {
    assert.strictEqual(ownsObservationBoundary(
      { tenantId: 't1', projectId: 'p1', isOperator: true },
      { tenantId: 't2', projectId: 'p2' },
    ), true);
  });

  it('allows exact tenant+project match', () => {
    assert.strictEqual(ownsObservationBoundary(
      { tenantId: 't1', projectId: 'p1' },
      { tenantId: 't1', projectId: 'p1' },
    ), true);
  });

  it('denies cross-project and cross-tenant', () => {
    assert.strictEqual(ownsObservationBoundary(
      { tenantId: 't1', projectId: 'p1' },
      { tenantId: 't1', projectId: 'p2' },
    ), false);
    assert.strictEqual(ownsObservationBoundary(
      { tenantId: 't1', projectId: 'p1' },
      { tenantId: 't2', projectId: 'p1' },
    ), false);
  });

  it('fails closed for unscoped legacy rows', () => {
    assert.strictEqual(ownsObservationBoundary(
      { tenantId: 't1', projectId: 'p1' },
      { tenantId: null, projectId: 'p1' },
    ), false);
    assert.strictEqual(ownsObservationBoundary(
      { tenantId: 't1', projectId: 'p1' },
      { tenantId: 't1', projectId: undefined },
    ), false);
  });
});

describe('canMutateObservation', () => {
  it('denies higher-scope delete across project boundary (adversarial)', () => {
    // Project-scoped caller must NOT delete another project's session row
    // just because requesterScope rank > targetScope rank.
    assert.strictEqual(canMutateObservation({
      requester: {
        tenantId: 't1', projectId: 'mine', requesterScope: 'project', isOperator: false,
      },
      observation: {
        tenantId: 't1', projectId: 'other', scope: 'session', sessionId: 's-other',
      },
      callerSessionId: 's-mine',
      action: 'delete',
    }), false);
  });

  it('allows same-project write at equal or lower scope', () => {
    assert.strictEqual(canMutateObservation({
      requester: {
        tenantId: 't1', projectId: 'p1', requesterScope: 'project', isOperator: false,
      },
      observation: {
        tenantId: 't1', projectId: 'p1', scope: 'session', sessionId: 's1',
      },
      action: 'write',
    }), true);
  });

  it('denies same-project write to higher scope without operator', () => {
    assert.strictEqual(canMutateObservation({
      requester: {
        tenantId: 't1', projectId: 'p1', requesterScope: 'session', isOperator: false,
      },
      observation: {
        tenantId: 't1', projectId: 'p1', scope: 'global',
      },
      action: 'write',
    }), false);
  });
});
