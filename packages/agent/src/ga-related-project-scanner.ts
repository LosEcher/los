/**
 * GA Related Project Scanner — periodically scans linked projects for new
 * features, changes, and absorbable capabilities into los.
 *
 * Linked projects (defined in workspace symlinks):
 *   - los-memory: memory ledger, now los' own memory module
 *   - vpsagentweb: execution fabric, phased migration to los executor
 *   - los-ast: code intelligence, AST absorption target
 *   - pi: Raspberry Pi management tools
 *
 * This scanner runs as a governance job type: 'related_project_scan'.
 * Output: a structured research report saved to docs/research/.
 */
import { getLogger } from '@los/infra/logger';
import { existsSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { execSync } from 'node:child_process';

const log = getLogger('ga-related-project');

export interface RelatedProject {
  /** Workspace alias path relative to projects/ */
  workspacePath: string;
  /** Display name */
  name: string;
  /** Real path on disk (resolved symlink) */
  realPath?: string;
  /** Role description */
  role: string;
}

export interface ProjectScanResult {
  project: RelatedProject;
  accessible: boolean;
  error?: string;
  lastCommit?: string;
  lastCommitDate?: string;
  recentCommits?: number;
  newFeatures?: string[];
  absorbableCapabilities?: string[];
  recommendation: 'absorb' | 'monitor' | 'archive' | 'no_action';
}

/** The workspace's linked projects. Real paths are resolved from symlinks. */
export const RELATED_PROJECTS: RelatedProject[] = [
  {
    workspacePath: 'projects/los-memory',
    name: 'los-memory',
    role: 'Memory ledger — los memory module absorbed its design',
  },
  {
    workspacePath: 'projects/vpsagentweb',
    name: 'vpsagentweb',
    role: 'Execution fabric — phased migration to los executor (P1: file-sync)',
  },
  {
    workspacePath: 'projects/los-ast',
    name: 'los-ast',
    role: 'Code intelligence — AST analysis target for absorption',
  },
  {
    workspacePath: 'projects/pi',
    name: 'pi',
    role: 'Raspberry Pi management — monitoring/control utilities',
  },
  {
    workspacePath: 'projects/lsclaw',
    name: 'lsclaw',
    role: 'Multi-tenant agent platform — self-iteration governance patterns',
  },
];

/**
 * Resolve a workspace-relative path to an absolute path.
 */
function resolveProjectPath(root: string, workspacePath: string): string {
  // workspacePath is relative to the los-workspace root
  // los is at projects/los within the workspace
  const workspaceRoot = resolve(root, '..', '..');
  return resolve(workspaceRoot, workspacePath);
}

/**
 * Check if a project directory is accessible and is a git repo.
 */
function probeProject(root: string, project: RelatedProject): {
  accessible: boolean;
  realPath?: string;
  error?: string;
} {
  const targetPath = resolveProjectPath(root, project.workspacePath);
  try {
    if (!existsSync(targetPath)) {
      return { accessible: false, error: `Path not found: ${targetPath}` };
    }
    // Try to read as a real path (symlink resolution)
    const realPath = (() => {
      try {
        return require('node:fs').realpathSync(targetPath);
      } catch {
        return targetPath;
      }
    })();
    return { accessible: true, realPath };
  } catch (err) {
    return { accessible: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Get recent git activity for a project directory.
 */
function getGitActivity(dir: string, since: string): {
  lastCommit?: string;
  lastCommitDate?: string;
  recentCommits: number;
} {
  try {
    execSync('git rev-parse --is-inside-work-tree', { cwd: dir, encoding: 'utf8', timeout: 5000 });
  } catch {
    return { recentCommits: 0 };
  }

  try {
    const log = execSync(
      `git log --oneline --since="${since}" --all`,
      { cwd: dir, encoding: 'utf8', timeout: 15000 },
    ).trim();

    const lines = log.split('\n').filter(Boolean);
    const lastLine = lines[0];
    const lastCommit = lastLine ? lastLine.split(' ')[0] : undefined;

    let lastCommitDate: string | undefined;
    if (lastCommit) {
      try {
        lastCommitDate = execSync(
          `git log -1 --format=%ai ${lastCommit}`,
          { cwd: dir, encoding: 'utf8', timeout: 5000 },
        ).trim();
      } catch { /* best-effort */ }
    }

    return {
      lastCommit,
      lastCommitDate,
      recentCommits: lines.length,
    };
  } catch {
    return { recentCommits: 0 };
  }
}

/**
 * Extract new feature fragments from recent commit messages.
 * This is a lightweight heuristic — a full analysis would require CBM code graph.
 */
function extractFeatures(commits: string[]): string[] {
  const featureKeywords = ['feat:', 'add:', 'implement:', 'support:', 'migrate:', 'extract:', 'refactor:'];
  const features: string[] = [];
  for (const line of commits) {
    const lower = line.toLowerCase();
    for (const kw of featureKeywords) {
      if (lower.startsWith(kw) || lower.includes(` ${kw}`)) {
        // Extract the feature description after the keyword
        const match = line.match(/(?:feat:|add:|implement:|support:|migrate:|extract:|refactor:)\s*(.+)/i);
        if (match) {
          features.push(match[1].trim().split('\n')[0].slice(0, 120));
        }
        break;
      }
    }
  }
  return features.slice(0, 10); // top 10 features
}

/**
 * Evaluate whether a feature from another project could be absorbed into los.
 */
function evaluateAbsorbability(
  project: RelatedProject,
  features: string[],
): string[] {
  const absorbable: string[] = [];

  for (const feature of features) {
    const lower = feature.toLowerCase();

    // Heuristic: features mentioning concepts relevant to los
    const losRelevant = [
      'agent', 'loop', 'scheduler', 'governance', 'audit', 'self-iterat',
      'memory', 'compaction', 'reflection', 'file-sync', 'executor',
      'tool', 'provider', 'model', 'gateway', 'contract', 'reconcili',
      'branch', 'circuit', 'throttle', 'backlog',
    ];

    if (losRelevant.some(kw => lower.includes(kw))) {
      absorbable.push(`${project.name}: ${feature}`);
    }
  }

  return absorbable;
}

/**
 * Determine recommendation for how los should handle this project.
 */
function determineRecommendation(
  project: RelatedProject,
  scan: { accessible: boolean; realPath?: string },
  activity: { recentCommits: number; lastCommitDate?: string },
): 'absorb' | 'monitor' | 'archive' | 'no_action' {
  if (!scan.accessible) return 'archive';

  // Already absorbed or in-progress: monitor for follow-up
  if (project.role.toLowerCase().includes('absorbed') || project.role.toLowerCase().includes('phased migration')) {
    return activity.recentCommits > 0 ? 'monitor' : 'archive';
  }

  // Active external project with recent changes: monitor
  if (activity.recentCommits > 10) return 'monitor';
  if (activity.recentCommits > 0) return 'no_action';

  return 'no_action';
}

/**
 * Scan all related projects and produce a structured report.
 */
export async function scanRelatedProjects(root: string): Promise<{
  scannedAt: string;
  since: string;
  projects: ProjectScanResult[];
}> {
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10); // 1 week ago
  const results: ProjectScanResult[] = [];

  for (const project of RELATED_PROJECTS) {
    try {
      const probe = probeProject(root, project);

      if (!probe.accessible) {
        results.push({
          project,
          accessible: false,
          error: probe.error,
          recommendation: 'archive',
        });
        continue;
      }

      const dir = probe.realPath!;
      const activity = getGitActivity(dir, since);

      let recentCommits: string[] = [];
      try {
        const log = execSync(
          `git log --oneline --since="${since}" --all`,
          { cwd: dir, encoding: 'utf8', timeout: 15000 },
        ).trim();
        recentCommits = log.split('\n').filter(Boolean);
      } catch { /* skip */ }

      const newFeatures = extractFeatures(recentCommits);
      const absorbableCapabilities = evaluateAbsorbability(project, newFeatures);
      const recommendation = determineRecommendation(project, probe, activity);

      results.push({
        project: { ...project, realPath: dir },
        accessible: true,
        lastCommit: activity.lastCommit,
        lastCommitDate: activity.lastCommitDate,
        recentCommits: activity.recentCommits,
        newFeatures: newFeatures.length > 0 ? newFeatures : undefined,
        absorbableCapabilities: absorbableCapabilities.length > 0 ? absorbableCapabilities : undefined,
        recommendation,
      });
    } catch (err) {
      log.warn(`Failed to scan project ${project.name}: ${err instanceof Error ? err.message : String(err)}`);
      results.push({
        project,
        accessible: false,
        error: err instanceof Error ? err.message : String(err),
        recommendation: 'monitor',
      });
    }
  }

  return { scannedAt: new Date().toISOString(), since, projects: results };
}

/**
 * Format a scan result as a human-readable markdown report.
 */
export function formatScanReport(result: Awaited<ReturnType<typeof scanRelatedProjects>>): string {
  const lines: string[] = [
    `# Related Project Scan Report`,
    `Generated: ${result.scannedAt}`,
    `Period: since ${result.since}`,
    '',
    '| Project | Accessible | Recent Commits | Recommendation | New Features |',
    '|---------|-----------|----------------|----------------|--------------|',
  ];

  for (const p of result.projects) {
    const features = p.newFeatures?.slice(0, 3).join('; ') || '-';
    lines.push(
      `| ${p.project.name} | ${p.accessible ? '✅' : '❌'} | ${p.recentCommits ?? 0} | ${p.recommendation} | ${features.slice(0, 80)} |`,
    );
  }

  lines.push('');

  // Detail section for projects with absorbable capabilities
  const absorbable = result.projects.filter(p => p.absorbableCapabilities && p.absorbableCapabilities.length > 0);
  if (absorbable.length > 0) {
    lines.push('## Potentially Absorbable Capabilities');
    lines.push('');
    for (const p of absorbable) {
      for (const cap of p.absorbableCapabilities!) {
        lines.push(`- ${cap}`);
      }
    }
    lines.push('');
  }

  // Projects with issues
  const failed = result.projects.filter(p => !p.accessible);
  if (failed.length > 0) {
    lines.push('## Inaccessible Projects');
    lines.push('');
    for (const p of failed) {
      lines.push(`- **${p.project.name}**: ${p.error ?? 'unknown error'}`);
    }
    lines.push('');
  }

  // Archive candidates
  const toArchive = result.projects.filter(p => p.recommendation === 'archive');
  if (toArchive.length > 0) {
    lines.push('## Archive Candidates');
    lines.push('');
    for (const p of toArchive) {
      lines.push(`- **${p.project.name}** — ${p.project.role}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
