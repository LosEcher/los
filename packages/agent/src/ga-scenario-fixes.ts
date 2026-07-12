/**
 * GA Loop auto-fix strategies for branch cleanup and related project scanning.
 *
 * Extracted from ga-loop-runner.ts to keep that file under the 600-line CI limit
 * while maintaining full auto-fix coverage.
 */
import { getLogger } from '@los/infra/logger';
import type { BranchHygieneExecFn } from './governance-auditors.js';

const log = getLogger('ga-loop-runner');

function isSafeRemoteName(value: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(value);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

// ── Branch cleanup auto-fix ────────────────────────────

/**
 * Branch auto-fix uses git's CLI to (1) re-attach a detached HEAD, (2) fast-forward
 * the configured mirror when safe, and (3) classify and safely delete stale primary
 * branches.
 *
 * Detached HEAD: only re-attached when the working tree is clean (never lose work).
 *
 * Forgejo sync: only `git push forgejo main` when the audit classified drift as
 * `syncable` (ff-able, behind>0, ahead===0) AND env `LOS_BRANCH_GOVERNANCE_FORGEJO_SYNC`
 * is enabled. A push failure (network/creds) is infra, not a fix failure: it degrades
 * to report-only for this round without throwing or marking applied=false — so a forgejo
 * outage never trips the circuit breaker.
 *
 * Stale branch classification (inspired by lsclaw's branch-governance-report.mjs):
 *   - delete: no unique commits remain versus main (ahead=0)
 *   - delete: all patches already absorbed into main (git cherry)
 *   - extract: ≤3 unique commits behind main, good candidate for fresh branch
 *   - archive: >30 commits behind or >15 unique commits ahead, needs owner review
 *   - active_review: referenced by an open PR
 *   - review: all other cases needing human judgement
 *
 * For safety, only 'delete' branches are actually deleted. Others are reported
 * as findings for operator review via the escalation todo path.
 *
 * `exec` is injected for testability; production callers omit it and get the
 * real execSync-backed implementation. `applyAutoFix` calls this with a single
 * arg, so the second arg must remain optional.
 */
export async function applyBranchCleanupFix(
  summary: Record<string, unknown>,
  exec?: BranchHygieneExecFn,
): Promise<{ applied: boolean; detail: string }> {
  // Resolve the exec function: caller-injected (tests) or the real execSync.
  // `await import` here (function is async) keeps it ESM-safe; execSync itself is synchronous.
  const { execSync: realExecSync } = await import('node:child_process');
  const execSyncImpl: BranchHygieneExecFn = exec ?? ((cmd, opts) =>
    realExecSync(cmd, { encoding: 'utf8', ...opts }) as string);

  const detailLines: string[] = [];

  try {
    try {
      execSyncImpl('git rev-parse --is-inside-work-tree', { timeout: 5000 });
    } catch {
      return { applied: false, detail: 'Not a git worktree — branch cleanup requires git' };
    }

    // ── STEP 1: Detached HEAD (reversible, only when working tree clean) ──
    if (summary.detached === true) {
      // Re-verify cleanliness now: the audit ran in a prior call and the tree may
      // have changed in between. Never checkout across a dirty tree (would risk
      // carrying uncommitted changes across the switch).
      let dirtyNow = summary.workingTreeDirty === true;
      try {
        dirtyNow = execSyncImpl('git status --porcelain', { timeout: 5000 }).trim().length > 0;
      } catch {
        dirtyNow = true; // if status itself fails, treat as dirty (safe default)
      }
      if (dirtyNow) {
        detailLines.push('detached HEAD: NOT re-attached — working tree dirty (report-only; commit or stash then checkout main)');
      } else {
        try {
          execSyncImpl('git checkout main', { timeout: 10000, stdio: 'pipe' });
          detailLines.push('detached HEAD: checked out main (jj bookmark may need manual sync in colocate mode)');
        } catch (err) {
          detailLines.push(`detached HEAD: checkout main failed — ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    const primaryRemote = typeof summary.primaryRemote === 'string' ? summary.primaryRemote : 'origin';
    const mirrorRemote = typeof summary.mirrorRemote === 'string' ? summary.mirrorRemote : 'forgejo';
    if (!isSafeRemoteName(primaryRemote) || !isSafeRemoteName(mirrorRemote)) {
      return { applied: false, detail: 'Branch cleanup refused unsafe remote name' };
    }
    const mirrorSyncEnabled = summary.mirrorSyncEnabled ?? summary.forgejoSyncEnabled;
    const mirrorSyncable = summary.mirrorSyncable ?? summary.forgejoSyncable;
    const mirrorBehind = summary.mirrorBehind ?? summary.forgejoBehind;

    // ── STEP 2: Optional mirror fast-forward sync ──
    if (mirrorSyncEnabled === true && mirrorSyncable === true) {
      try {
        execSyncImpl(`git push ${mirrorRemote} ${primaryRemote}/main:main`, { timeout: 30000, stdio: 'pipe' });
        detailLines.push(`${mirrorRemote}: pushed ${primaryRemote}/main → ${mirrorRemote}/main (ff, +${mirrorBehind ?? '?'} commits)`);
      } catch (err) {
        detailLines.push(`${mirrorRemote}: push failed (network/creds) — degraded to report-only this round: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // ── STEP 3: Stale primary branch deletion ──
    try {
      execSyncImpl(`git fetch ${primaryRemote} --prune`, { timeout: 30000, stdio: 'pipe' });
    } catch (err) {
      return { applied: false, detail: `Failed to fetch remote branches: ${err instanceof Error ? err.message : String(err)}` };
    }

    const refsOutput = execSyncImpl(
      `git for-each-ref --format='%(refname:short)' refs/remotes/${primaryRemote}`,
      { timeout: 5000 },
    );
    const branches = refsOutput
      .split('\n')
      .map(l => l.trim())
      .filter(b => b && b !== primaryRemote && !b.startsWith(`${primaryRemote}/HEAD`) && b !== `${primaryRemote}/main`);

    if (branches.length === 0) {
      detailLines.push('stale branches: none found');
      return { applied: true, detail: detailLines.join('\n') };
    }

    const classified: { branch: string; action: string; reason: string; ahead: number | null; behind: number | null }[] = [];
    let deleted = 0;

    for (const branch of branches) {
      const short = branch.slice(primaryRemote.length + 1);

      let ahead: number | null = null;
      let behind: number | null = null;
      try {
        const counts = execSyncImpl(`git rev-list --left-right --count ${shellQuote(`${primaryRemote}/main...${branch}`)}`, {
          timeout: 5000,
        }).trim().split(/\s+/);
        behind = Number.parseInt(counts[0] || '0', 10);
        ahead = Number.parseInt(counts[1] || '0', 10);
      } catch { /* skip if unreachable */ }

      let allAbsorbed = false;
      try {
        const cherryOut = execSyncImpl(`git cherry ${shellQuote(`${primaryRemote}/main`)} ${shellQuote(branch)}`, {
          timeout: 5000,
        }).trim();
        const cherryLines = cherryOut.split('\n').filter(Boolean);
        const plus = cherryLines.filter(l => l.startsWith('+')).length;
        allAbsorbed = cherryLines.length > 0 && plus === 0;
      } catch { /* skip if cherry fails */ }

      let action: string;
      let reason: string;

      if (ahead === 0) {
        action = 'delete';
        reason = 'no unique commits remain versus main';
      } else if (allAbsorbed) {
        action = 'delete';
        reason = 'all branch patches already absorbed into main';
      } else if (ahead !== null && ahead <= 3 && behind !== null && behind > 0 && behind <= 100) {
        action = 'extract';
        reason = `${ahead} unique commit(s), behind by ${behind} — extract smallest useful rollback unit`;
      } else if ((behind !== null && behind > 30) || (ahead !== null && ahead > 15)) {
        action = 'archive';
        reason = `stale (behind=${behind ?? '?'} ahead=${ahead ?? '?'}) — archive after grace period`;
      } else {
        action = 'review';
        reason = `contains ${ahead ?? '?'} unique commit(s) — needs owner judgement`;
      }

      classified.push({ branch: short, action, reason, ahead, behind });

      if (action === 'delete') {
        try {
          execSyncImpl(`git push ${primaryRemote} --delete ${shellQuote(short)}`, { timeout: 15000, stdio: 'pipe' });
          deleted += 1;
        } catch (err) {
          classified.push({
            branch: short,
            action: 'delete_failed',
            reason: `Deletion failed: ${err instanceof Error ? err.message : String(err)}`,
            ahead: null,
            behind: null,
          });
        }
      }
    }

    const actionable = classified.filter(c => c.action !== 'delete');
    detailLines.push(
      `stale branches: scanned=${branches.length} deleted=${deleted}`,
      `  to extract: ${classified.filter(c => c.action === 'extract').length}`,
      `  to review/archive: ${classified.filter(c => c.action === 'review' || c.action === 'archive').length}`,
    );
    if (actionable.length > 0) {
      detailLines.push(
        '  Actionable:',
        ...actionable.slice(0, 10).map(c => `    - ${c.branch} [${c.action}]: ${c.reason}`),
      );
    } else {
      detailLines.push('  No manual action needed.');
    }

    return { applied: true, detail: detailLines.join('\n') };
  } catch (err) {
    return { applied: false, detail: `Branch cleanup failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// ── Related project scan auto-fix ─────────────────────

export async function applyRelatedProjectScanFix(
  _summary: Record<string, unknown>,
): Promise<{ applied: boolean; detail: string }> {
  try {
    const { scanRelatedProjects, formatScanReport } = await import('./ga-related-project-scanner.js');
    const result = await scanRelatedProjects(process.cwd());
    const report = formatScanReport(result);

    const { writeFileSync, mkdirSync, existsSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const researchDir = resolve(process.cwd(), 'docs', 'research');
    if (!existsSync(researchDir)) {
      mkdirSync(researchDir, { recursive: true });
    }

    const dateStr = new Date().toISOString().slice(0, 10);
    const filename = `related-project-scan-${dateStr}.md`;
    writeFileSync(resolve(researchDir, filename), report, 'utf8');

    const absorbable = result.projects.filter(p => p.absorbableCapabilities && p.absorbableCapabilities.length > 0);
    return {
      applied: true,
      detail: [
        `Report written to docs/research/${filename}`,
        `Scanned ${result.projects.length} project(s): ${result.projects.filter(p => p.accessible).length} accessible`,
        absorbable.length > 0
          ? `Absorbable capabilities found in: ${absorbable.map(p => p.project.name).join(', ')}`
          : 'No absorbable capabilities detected this week',
      ].join('\n'),
    };
  } catch (err) {
    return { applied: false, detail: `Related project scan failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}
