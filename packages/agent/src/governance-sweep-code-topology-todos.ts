/**
 * @los/agent/governance-sweep-code-topology-todos — create dispatchable todos
 * from code_topology_audit findings.
 *
 * Each topology cluster becomes one todo with status 'ready', scoped to the
 * external project. When dispatched, los chat reviews the cluster against the
 * assigned dimensions.
 */

import { getLogger } from '@los/infra/logger';
import type { GovernanceJob } from './governance-jobs-types.js';
import type { TopologyCluster } from './governance-auditors-code-topology.js';

const log = getLogger('governance-jobs');

export async function createCodeTopologyTodos(
  job: GovernanceJob,
  summary: Record<string, unknown>,
): Promise<number> {
  const { createTodo } = await import('./todos.js');

  const clusters = (summary.clusters as TopologyCluster[] | undefined) ?? [];
  if (clusters.length === 0) return 0;

  const config = (job.config ?? {}) as Record<string, unknown>;
  const targetRepo: string = typeof config.targetRepo === 'string' ? config.targetRepo : '';
  const projectName: string = (typeof config.projectName === 'string' && config.projectName)
    ? config.projectName
    : (summary.projectName as string) ?? 'unknown';

  let created = 0;
  for (const cluster of clusters) {
    const title = `Topology Review: ${cluster.name} (${cluster.priority}) — ${projectName}`;

    const description = [
      `**Code topology audit** identified a review cluster in **${projectName}**.`,
      '',
      `### Routes (${cluster.routes.length})`,
      ...cluster.routes.slice(0, 25).map((r: string) => `- \`${r}\``),
      cluster.routes.length > 25 ? `- ... and ${cluster.routes.length - 25} more` : '',
      '',
      `### Key Files (${cluster.fileCount})`,
      ...cluster.files.slice(0, 18).map((f: string) => `- ${f}`),
      cluster.files.length > 18 ? `- ... and ${cluster.files.length - 18} more` : '',
      '',
      `### Review Dimensions`,
      ...cluster.dimensions.map((d: string) => `- **${d}**`),
      '',
      cluster.cbmClusterLabel
        ? `CBM cluster: **${cluster.cbmClusterLabel}** (cohesion: ${cluster.cohesionScore ?? 'N/A'})`
        : '',
      '',
      `### Instructions`,
      `Review the handler code for each route in this cluster. For each dimension:`,
      `- **security**: Check auth guards, input validation, injection, CSRF, rate limiting, credential storage`,
      `- **wiring**: Verify dependency injection chain is intact (handler→service→repository), no circular deps, no nil guards missing`,
      `- **error-handling**: Ensure all code paths return errors, no swallowed errors, panics are recovered`,
      `- **data-integrity**: Validate DB queries use parameterized statements, transactions are complete, migrations are safe`,
      `- **structure**: Check for god files, missing abstractions, naming consistency, dead code`,
      '',
      `Report findings grouped by dimension. For each finding include: file:line, severity (critical/high/medium/low), description, and suggested fix.`,
      cluster.files.length > 0 ? '' : '',
    ].join('\n');

    try {
      await createTodo({
        title,
        description,
        kind: 'task',
        status: 'ready',
        priority: cluster.priority,
        source: 'governance_sweep',
        projectId: projectName,
        metadata: {
          sweepJobId: job.id,
          sweepJobType: job.jobType,
          auditType: 'topologyCluster',
          workspaceRoot: targetRepo,
          projectName,
          clusterName: cluster.name,
          routes: cluster.routes,
          files: cluster.files,
          dimensions: cluster.dimensions,
          cbmClusterLabel: cluster.cbmClusterLabel,
          cohesionScore: cluster.cohesionScore,
        },
      });
      created += 1;
    } catch (err) {
      log.warn(
        `Failed to create code_topology_audit todo for cluster "${cluster.name}": ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  return created;
}
