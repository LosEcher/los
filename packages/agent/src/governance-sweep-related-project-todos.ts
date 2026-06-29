/**
 * Related-project-scan TODO creation (mirrors sweeper-branch-todos.ts pattern).
 * Converts absorbable capabilities from the related_project_scan GA job into
 * dispatchable cross-project TODOs — one per project with absorbable features.
 *
 * Each TODO carries workspaceRoot in metadata so dispatchTodo can target the
 * foreign project's directory.
 */
import type { GovernanceJob } from './governance-jobs-types.js';
import { createTodo } from './todos.js';
import { getLogger } from '@los/infra/logger';

const log = getLogger('governance-jobs');

interface AbsorbableProject {
  name: string;
  workspacePath: string;
  realPath?: string;
  role: string;
  capabilities?: string[];
  recommendation: string;
  lastCommitDate?: string;
}

export async function createRelatedProjectScanTodos(
  job: GovernanceJob,
  summary: Record<string, unknown>,
): Promise<number> {
  const absorbableProjects = summary.absorbableProjects as AbsorbableProject[] | undefined;
  if (!absorbableProjects || absorbableProjects.length === 0) return 0;

  let created = 0;
  for (const proj of absorbableProjects) {
    if (!proj.realPath) continue; // skip if path is unavailable

    const title = `Cross-project: Absorb capabilities from ${proj.name}`;
    const description = [
      `Related project scan found absorbable capabilities in **${proj.name}** (${proj.role}).`,
      '',
      `- **Workspace**: ${proj.realPath}`,
      `- **Recommendation**: ${proj.recommendation}`,
      `- **Last commit**: ${proj.lastCommitDate ?? 'unknown'}`,
      '',
      `**Absorbable capabilities**:`,
      ...(proj.capabilities ?? []).slice(0, 10).map(c => `- ${c}`),
      '',
      `Dispatch this TODO to run a los agent in ${proj.name}'s workspace to analyze and absorb these capabilities.`,
    ].join('\n');

    try {
      await createTodo({
        title,
        description,
        kind: 'task',
        status: 'ready',
        priority: 'P2',
        source: 'governance_sweep',
        projectId: proj.name,
        metadata: {
          sweepJobId: job.id,
          sweepJobType: job.jobType,
          auditType: 'absorbableCapability',
          workspaceRoot: proj.realPath,
          fromProject: proj.name,
          workspacePath: proj.workspacePath,
          capabilities: proj.capabilities,
          recommendation: proj.recommendation,
        },
      });
      created += 1;
    } catch (err) {
      log.warn(`Failed to create related_project_scan todo for ${proj.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return created;
}
