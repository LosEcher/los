/**
 * Branch-hygiene GA loop tests — pure-function, hermetic (no network, no DB).
 *
 * The audit (`computeBranchHygieneSummary`) and fix (`applyBranchCleanupFix`)
 * accept an injected `exec` function so we can drive them with canned git
 * outputs and assert on the commands issued — never touching a real repo or
 * the LAN forgejo mirror. `checkHasFindings` is exercised directly to lock the
 * circuit-breaker classification (unreachable/disabled must NOT be findings).
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeBranchHygieneSummary,
  type BranchHygieneExecFn,
} from './governance-auditors.js';
import { applyBranchCleanupFix } from './ga-scenario-fixes.js';
import { checkHasFindings } from './ga-loop-runner.js';
import { SEED_JOBS } from './governance-jobs-schema.js';

// ── Fake exec helpers ─────────────────────────────────

type FakeCmd = { match: string; out?: string; error?: string };

/**
 * Build an exec fake that matches commands by substring (first match wins) and
 * records every command issued. Matches return `out` (default ''); entries with
 * `error` throw. Unmatched commands return '' (success, empty output).
 */
function fakeExec(cmds: FakeCmd[], recorded: string[] = []): BranchHygieneExecFn {
  return (cmd: string) => {
    recorded.push(cmd);
    for (const c of cmds) {
      if (cmd.includes(c.match)) {
        if (c.error !== undefined) throw new Error(c.error);
        return c.out ?? '';
      }
    }
    return '';
  };
}

/** Default "healthy repo" git responses: worktree, attached, clean, forgejo in sync. */
const healthyCmds: FakeCmd[] = [
  { match: 'rev-parse --is-inside-work-tree', out: 'true' },
  { match: 'symbolic-ref -q HEAD', out: 'refs/heads/main\n' },
  { match: 'git status --porcelain', out: '' },
  { match: 'git fetch forgejo --prune', out: '' },
  { match: 'rev-parse --verify forgejo/main', out: '<sha>\n' },
  { match: 'rev-list --left-right --count forgejo/main...origin/main', out: '0 0' },
  { match: 'merge-base --is-ancestor forgejo/main origin/main', out: '' },
  { match: 'for-each-ref', out: '' },
];

const PREV_SYNC_FLAG = process.env.LOS_BRANCH_GOVERNANCE_FORGEJO_SYNC;

describe('computeBranchHygieneSummary — audit', () => {
  afterEach(() => {
    if (PREV_SYNC_FLAG === undefined) delete process.env.LOS_BRANCH_GOVERNANCE_FORGEJO_SYNC;
    else process.env.LOS_BRANCH_GOVERNANCE_FORGEJO_SYNC = PREV_SYNC_FLAG;
  });

  it('returns branchable=false when not a git worktree', () => {
    const exec = fakeExec([{ match: 'rev-parse --is-inside-work-tree', error: 'fatal: not a git repo' }]);
    const s = computeBranchHygieneSummary(exec);
    assert.equal(s.branchable, false);
    assert.match(String(s.reason), /Not a git worktree/);
  });

  it('reports attached/clean/in-sync as detached=false, forgejoDrift=none', () => {
    const s = computeBranchHygieneSummary(fakeExec(healthyCmds));
    assert.equal(s.branchable, true);
    assert.equal(s.detached, false);
    assert.equal(s.workingTreeDirty, false);
    assert.equal(s.forgejoDrift, 'none');
    assert.equal(s.forgejoBehind, 0);
    assert.equal(s.forgejoSyncable, false);
    assert.equal(s.staleOriginBranches, 0);
  });

  it('detects detached HEAD (symbolic-ref throws)', () => {
    const exec = fakeExec(healthyCmds.map(c => c.match === 'symbolic-ref -q HEAD' ? { match: c.match, error: 'fatal: ref HEAD is not a symbolic ref' } : c));
    const s = computeBranchHygieneSummary(exec);
    assert.equal(s.detached, true);
  });

  it('detects dirty working tree', () => {
    const exec = fakeExec(healthyCmds.map(c => c.match === 'git status --porcelain' ? { match: c.match, out: ' M src/foo.ts\n' } : c));
    const s = computeBranchHygieneSummary(exec);
    assert.equal(s.workingTreeDirty, true);
  });

  it('classifies forgejo behind + ff-able as syncable', () => {
    const cmds = healthyCmds.map(c => {
      if (c.match === 'rev-list --left-right --count forgejo/main...origin/main') return { match: c.match, out: '5 0' };
      return c;
    });
    const s = computeBranchHygieneSummary(fakeExec(cmds));
    assert.equal(s.forgejoDrift, 'syncable');
    assert.equal(s.forgejoBehind, 5);
    assert.equal(s.forgejoAhead, 0);
    assert.equal(s.forgejoSyncable, true);
  });

  it('classifies forgejo divergence (ahead>0) as non_ff', () => {
    const cmds = healthyCmds.map(c => {
      if (c.match === 'rev-list --left-right --count forgejo/main...origin/main') return { match: c.match, out: '3 2' };
      if (c.match === 'merge-base --is-ancestor forgejo/main origin/main') return { match: c.match, error: 'not an ancestor' };
      return c;
    });
    const s = computeBranchHygieneSummary(fakeExec(cmds));
    assert.equal(s.forgejoDrift, 'non_ff');
    assert.equal(s.forgejoAhead, 2);
    assert.equal(s.forgejoSyncable, false);
  });

  it('classifies forgejo fetch failure as unreachable (NOT a thrown error)', () => {
    const cmds = healthyCmds.map(c => c.match === 'git fetch forgejo --prune' ? { match: c.match, error: 'Could not resolve host' } : c);
    const s = computeBranchHygieneSummary(fakeExec(cmds));
    assert.equal(s.forgejoDrift, 'unreachable');
    assert.equal(s.forgejoReachable, false);
    assert.equal(s.forgejoBehind, null);
  });

  it('classifies env-disabled sync as disabled and skips fetch', () => {
    process.env.LOS_BRANCH_GOVERNANCE_FORGEJO_SYNC = '0';
    const recorded: string[] = [];
    const s = computeBranchHygieneSummary(fakeExec(healthyCmds, recorded));
    assert.equal(s.forgejoDrift, 'disabled');
    assert.equal(s.forgejoSyncEnabled, false);
    assert.equal(recorded.some(c => c.includes('fetch forgejo')), false);
  });

  it('counts stale origin branches (non-main remote refs)', () => {
    const cmds = healthyCmds.map(c => c.match === 'for-each-ref' ? { match: c.match, out: 'origin/feature-a\norigin/feature-b\norigin/main\norigin/HEAD -> origin/main\n' } : c);
    const s = computeBranchHygieneSummary(fakeExec(cmds));
    assert.equal(s.staleOriginBranches, 2);
    assert.equal(s.staleCandidateCount, 2); // backward-compat alias
  });
});

describe('checkHasFindings — branch_cleanup circuit-breaker classification', () => {
  it('detached HEAD is a finding', () => {
    assert.equal(checkHasFindings('branch_cleanup', { detached: true, forgejoDrift: 'none', staleOriginBranches: 0 }), true);
  });

  it('stale origin branches > 0 is a finding', () => {
    assert.equal(checkHasFindings('branch_cleanup', { detached: false, forgejoDrift: 'none', staleOriginBranches: 3 }), true);
  });

  it('forgejoDrift=syncable is a finding (auto-fixable)', () => {
    assert.equal(checkHasFindings('branch_cleanup', { detached: false, forgejoDrift: 'syncable', staleOriginBranches: 0 }), true);
  });

  it('forgejoDrift=non_ff is a finding (escalates to P1)', () => {
    assert.equal(checkHasFindings('branch_cleanup', { detached: false, forgejoDrift: 'non_ff', staleOriginBranches: 0 }), true);
  });

  it('forgejoDrift=unreachable is NOT a finding (infra, no breaker trip)', () => {
    assert.equal(checkHasFindings('branch_cleanup', { detached: false, forgejoDrift: 'unreachable', staleOriginBranches: 0 }), false);
  });

  it('forgejoDrift=disabled is NOT a finding', () => {
    assert.equal(checkHasFindings('branch_cleanup', { detached: false, forgejoDrift: 'disabled', staleOriginBranches: 0 }), false);
  });

  it('forgejoDrift=none with nothing else is NOT a finding', () => {
    assert.equal(checkHasFindings('branch_cleanup', { detached: false, forgejoDrift: 'none', staleOriginBranches: 0 }), false);
  });
});

describe('applyBranchCleanupFix — detached HEAD + forgejo sync', () => {
  it('re-attaches detached HEAD when working tree is clean', async () => {
    const recorded: string[] = [];
    const exec = fakeExec([{ match: 'rev-parse --is-inside-work-tree', out: 'true' }, { match: 'git status --porcelain', out: '' }, { match: 'checkout main', out: '' }, { match: 'fetch origin --prune', out: '' }, { match: 'for-each-ref', out: '' }], recorded);
    const res = await applyBranchCleanupFix({ detached: true, workingTreeDirty: false, forgejoSyncEnabled: false, forgejoSyncable: false, forgejoDrift: 'disabled' }, exec);
    assert.equal(res.applied, true);
    assert.equal(recorded.some(c => c.includes('git checkout main')), true);
  });

  it('does NOT checkout when detached on a dirty tree (re-verified at fix time)', async () => {
    const recorded: string[] = [];
    // Fix re-runs `git status --porcelain`; even if the audit said clean, a dirty
    // re-verification must block the checkout. Here the audit says dirty AND re-verify is dirty.
    const exec = fakeExec([{ match: 'rev-parse --is-inside-work-tree', out: 'true' }, { match: 'git status --porcelain', out: ' M file.ts\n' }, { match: 'fetch origin --prune', out: '' }, { match: 'for-each-ref', out: '' }], recorded);
    const res = await applyBranchCleanupFix({ detached: true, workingTreeDirty: true, forgejoSyncEnabled: false, forgejoSyncable: false, forgejoDrift: 'disabled' }, exec);
    assert.equal(res.applied, true);
    assert.equal(recorded.some(c => c.includes('git checkout main')), false);
    assert.match(res.detail, /dirty/);
  });

  it('does NOT checkout when audit said clean but tree turned dirty before fix', async () => {
    // Audit reported workingTreeDirty=false, but the fix-time re-verification sees dirt.
    const recorded: string[] = [];
    const exec = fakeExec([{ match: 'rev-parse --is-inside-work-tree', out: 'true' }, { match: 'git status --porcelain', out: ' M file.ts\n' }, { match: 'fetch origin --prune', out: '' }, { match: 'for-each-ref', out: '' }], recorded);
    const res = await applyBranchCleanupFix({ detached: true, workingTreeDirty: false, forgejoSyncEnabled: false, forgejoSyncable: false, forgejoDrift: 'disabled' }, exec);
    assert.equal(recorded.some(c => c.includes('git checkout main')), false);
    assert.match(res.detail, /dirty/);
  });

  it('pushes forgejo when syncable and sync enabled (refspec origin/main:main)', async () => {
    const recorded: string[] = [];
    const exec = fakeExec([{ match: 'rev-parse --is-inside-work-tree', out: 'true' }, { match: 'push forgejo', out: '' }, { match: 'fetch origin --prune', out: '' }, { match: 'for-each-ref', out: '' }], recorded);
    const res = await applyBranchCleanupFix({ detached: false, forgejoSyncEnabled: true, forgejoSyncable: true, forgejoBehind: 5, forgejoDrift: 'syncable' }, exec);
    assert.equal(res.applied, true);
    assert.equal(recorded.some(c => c.includes('git push forgejo origin/main:main')), true);
    assert.match(res.detail, /pushed origin\/main/);
  });

  it('degrades to report-only (applied:true, no throw) when forgejo push fails', async () => {
    const recorded: string[] = [];
    const exec = fakeExec([{ match: 'rev-parse --is-inside-work-tree', out: 'true' }, { match: 'push forgejo', error: 'Could not resolve host' }, { match: 'fetch origin --prune', out: '' }, { match: 'for-each-ref', out: '' }], recorded);
    const res = await applyBranchCleanupFix({ detached: false, forgejoSyncEnabled: true, forgejoSyncable: true, forgejoBehind: 5, forgejoDrift: 'syncable' }, exec);
    assert.equal(res.applied, true); // NOT false — infra failure, not fix failure
    assert.match(res.detail, /degraded/i);
  });

  it('never pushes forgejo when drift is non_ff (syncable=false)', async () => {
    const recorded: string[] = [];
    const exec = fakeExec([{ match: 'rev-parse --is-inside-work-tree', out: 'true' }, { match: 'fetch origin --prune', out: '' }, { match: 'for-each-ref', out: '' }], recorded);
    await applyBranchCleanupFix({ detached: false, forgejoSyncEnabled: true, forgejoSyncable: false, forgejoAhead: 2, forgejoDrift: 'non_ff' }, exec);
    assert.equal(recorded.some(c => c.includes('push forgejo')), false);
  });

  it('never pushes forgejo when sync disabled by env', async () => {
    const recorded: string[] = [];
    const exec = fakeExec([{ match: 'rev-parse --is-inside-work-tree', out: 'true' }, { match: 'fetch origin --prune', out: '' }, { match: 'for-each-ref', out: '' }], recorded);
    await applyBranchCleanupFix({ detached: false, forgejoSyncEnabled: false, forgejoSyncable: true, forgejoDrift: 'disabled' }, exec);
    assert.equal(recorded.some(c => c.includes('push forgejo')), false);
  });
});

describe('applyBranchCleanupFix — stale origin branch deletion (preserved)', () => {
  // Stale-branch step runs (detached=false, forgejo disabled) so only step 3 fires.
  const baseSummary = { detached: false, workingTreeDirty: false, forgejoSyncEnabled: false, forgejoSyncable: false, forgejoDrift: 'disabled' };

  it('deletes a branch with ahead=0 (no unique commits)', async () => {
    const recorded: string[] = [];
    const exec = fakeExec([
      { match: 'rev-parse --is-inside-work-tree', out: 'true' },
      { match: 'fetch origin --prune', out: '' },
      { match: 'for-each-ref', out: 'origin/feature-old\n' },
      { match: 'rev-list --left-right --count origin/main...origin/feature-old', out: '2 0' },
      { match: 'git cherry origin/main origin/feature-old', out: '- <sha>\n' },
      { match: 'push origin --delete', out: '' },
    ], recorded);
    const res = await applyBranchCleanupFix(baseSummary, exec);
    assert.equal(res.applied, true);
    assert.equal(recorded.some(c => c.includes('git push origin --delete "feature-old"')), true);
  });

  it('does NOT delete a branch with unique commits (ahead=5, behind=2 → review)', async () => {
    const recorded: string[] = [];
    const exec = fakeExec([
      { match: 'rev-parse --is-inside-work-tree', out: 'true' },
      { match: 'fetch origin --prune', out: '' },
      { match: 'for-each-ref', out: 'origin/feature-active\n' },
      { match: 'rev-list --left-right --count origin/main...origin/feature-active', out: '2 5' },
      { match: 'git cherry origin/main origin/feature-active', out: '+ <sha1>\n+ <sha2>\n' },
    ], recorded);
    const res = await applyBranchCleanupFix(baseSummary, exec);
    assert.equal(res.applied, true);
    assert.equal(recorded.some(c => c.includes('push origin --delete')), false);
    assert.match(res.detail, /review/i);
  });
});

describe('branch_cleanup seed config', () => {
  it('cadence is hourly with autoFix enabled', () => {
    const seed = SEED_JOBS.find(s => s.jobType === 'branch_cleanup');
    assert.ok(seed);
    assert.equal(seed.cadence, 'hourly');
    assert.ok(seed.autoFix);
    assert.equal(seed.autoFix.autoFixEnabled, true);
    assert.equal(seed.autoFix.maxAutoFixAttempts, 1);
    assert.equal(seed.autoFix.escalationCadence, 'immediate');
  });
});
