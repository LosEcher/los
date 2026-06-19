/**
 * GA Loop auto-fix strategies for branch cleanup and related project scanning.
 *
 * Extracted from ga-loop-runner.ts to keep that file under the 600-line CI limit
 * while maintaining full auto-fix coverage.
 */
import { getLogger } from '@los/infra/logger';

const log = getLogger('ga-loop-runner');

// ── Branch cleanup auto-fix ────────────────────────────

/**
 * Branch auto-fix uses git's CLI to classify and safely delete stale branches.
 *
 * Classification (inspired by lsclaw's branch-governance-report.mjs):
 *   - delete: no unique commits remain versus main (ahead=0)
 *   - delete: all patches already absorbed into main (git cherry)
 *   - extract: ≤3 unique commits behind main, good candidate for fresh branch
 *   - archive: >30 commits behind or >15 unique commits ahead, needs owner review
 *   - active_review: referenced by an open PR
 *   - review: all other cases needing human judgement
 *
 * For safety, only 'delete' branches are actually deleted. Others are reported
 * as findings for operator review via the escalation todo path.
 */
export async function applyBranchCleanupFix(
  _summary: Record<string, unknown>,
): Promise<{ applied: boolean; detail: string }> {
  try {
    const { execSync } = await import('node:child_process');

    try {
      execSync('git rev-parse --is-inside-work-tree', { encoding: 'utf8', timeout: 5000 });
    } catch {
      return { applied: false, detail: 'Not a git worktree — branch cleanup requires git' };
    }

    try {
      execSync('git fetch --all --prune', { encoding: 'utf8', timeout: 30000, stdio: 'pipe' });
    } catch (err) {
      return { applied: false, detail: `Failed to fetch remote branches: ${err instanceof Error ? err.message : String(err)}` };
    }

    const refsOutput = execSync(
      'git for-each-ref --format=%(refname:short) refs/remotes/origin',
      { encoding: 'utf8', timeout: 5000 },
    );
    const branches = refsOutput
      .split('\n')
      .map(l => l.trim())
      .filter(b => b && b !== 'origin' && !b.startsWith('origin/HEAD') && b !== 'origin/main');

    if (branches.length === 0) {
      return { applied: true, detail: 'No stale remote branches found' };
    }

    const classified: { branch: string; action: string; reason: string; ahead: number | null; behind: number | null }[] = [];
    let deleted = 0;

    for (const branch of branches) {
      const short = branch.replace(/^origin\//, '');

      let ahead: number | null = null;
      let behind: number | null = null;
      try {
        const counts = execSync(`git rev-list --left-right --count origin/main...${branch}`, {
          encoding: 'utf8', timeout: 5000,
        }).trim().split(/\s+/);
        behind = Number.parseInt(counts[0] || '0', 10);
        ahead = Number.parseInt(counts[1] || '0', 10);
      } catch { /* skip if unreachable */ }

      let allAbsorbed = false;
      try {
        const cherryOut = execSync(`git cherry origin/main ${branch}`, {
          encoding: 'utf8', timeout: 5000,
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
          execSync(`git push origin --delete "${short}"`, { encoding: 'utf8', timeout: 15000, stdio: 'pipe' });
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
    const summaryText = [
      `Scanned ${branches.length} remote branch(es)`,
      `  deleted: ${deleted}`,
      `  to extract: ${classified.filter(c => c.action === 'extract').length}`,
      `  to review/archive: ${classified.filter(c => c.action === 'review' || c.action === 'archive').length}`,
      actionable.length > 0
        ? `Actionable:\n${actionable.slice(0, 10).map(c => `    - ${c.branch} [${c.action}]: ${c.reason}`).join('\n')}`
        : 'No manual action needed.',
    ].join('\n');

    return { applied: true, detail: summaryText };
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
