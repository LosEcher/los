import { randomUUID } from 'node:crypto';
import { getLogger } from '@los/infra/logger';
import {
  listDueGovernanceJobs,
  recordGovernanceJobRun,
  type GovernanceJobRecord,
  type GovernanceJobType,
} from './governance-jobs.js';
import { scanProject, loadRuleFiles } from './static-analysis/index.js';

const log = getLogger('governance-sweeper');

export interface SweeperOptions {
  /** Specific job types to run. If empty, runs all due jobs. */
  jobTypes?: GovernanceJobType[];
  /** Workspace root for file scanning. */
  workspaceRoot?: string;
  /** Limit the number of jobs run in a single sweep. */
  limit?: number;
}

export interface SweeperResult {
  ran: number;
  skipped: number;
  errors: string[];
  jobResults: Array<{
    jobId: string;
    jobType: GovernanceJobType;
    status: 'pass' | 'fail' | 'action_required';
    findings?: number;
    error?: string;
  }>;
}

/**
 * Run due governance jobs. This is the entry point for both operator-triggered
 * ("pnpm run govern") and scheduled automation.
 */
export async function runGovernanceSweep(options: SweeperOptions = {}): Promise<SweeperResult> {
  const dueJobs = await listDueGovernanceJobs({
    jobType: options.jobTypes?.[0],
  });

  const jobsToRun = dueJobs.slice(0, options.limit ?? 10);
  if (jobsToRun.length === 0) {
    return { ran: 0, skipped: 0, errors: [], jobResults: [] };
  }

  const workspaceRoot = options.workspaceRoot ?? process.cwd();
  const result: SweeperResult = { ran: 0, skipped: dueJobs.length - jobsToRun.length, errors: [], jobResults: [] };

  for (const job of jobsToRun) {
    try {
      const jobResult = await executeGovernanceJob(job, workspaceRoot);
      result.jobResults.push(jobResult);
      result.ran += 1;

      const taskRunId = `sweep-${job.id}-${Date.now()}`;
      await recordGovernanceJobRun(job.id, taskRunId, {
        status: jobResult.status,
        counts: { findings: jobResult.findings ?? 0 },
        findings: jobResult.findings,
        errors: jobResult.error ? [jobResult.error] : undefined,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(`${job.jobType}/${job.id}: ${msg}`);
      result.jobResults.push({ jobId: job.id, jobType: job.jobType, status: 'fail', error: msg });
    }
  }

  return result;
}

async function executeGovernanceJob(
  job: GovernanceJobRecord,
  workspaceRoot: string,
): Promise<{ jobId: string; jobType: GovernanceJobType; status: 'pass' | 'fail' | 'action_required'; findings?: number; error?: string }> {
  switch (job.jobType) {
    case 'consistency_audit':
      return runConsistencyAudit(job, workspaceRoot);
    case 'hotspot':
      return runHotspotDetection(job, workspaceRoot);
    case 'architecture_drift':
      return runArchitectureDrift(job, workspaceRoot);
    case 'tool_drift':
      return { jobId: job.id, jobType: 'tool_drift', status: 'pass', findings: 0 };
    case 'provider_surveillance':
      return { jobId: job.id, jobType: 'provider_surveillance', status: 'pass', findings: 0 };
    default:
      return { jobId: job.id, jobType: job.jobType, status: 'pass', findings: 0 };
  }
}

async function runConsistencyAudit(
  job: GovernanceJobRecord,
  workspaceRoot: string,
): Promise<{ jobId: string; jobType: GovernanceJobType; status: 'pass' | 'fail' | 'action_required'; findings?: number; error?: string }> {
  const rules = job.config.rules as string[] | undefined;
  if (!rules || rules.length === 0) {
    return { jobId: job.id, jobType: 'consistency_audit', status: 'pass', findings: 0 };
  }

  try {
    const loadedRules = await loadRuleFiles([
      `${workspaceRoot}/packages/agent/src/static-analysis/rules/projects/los/*.yml`,
      `${workspaceRoot}/packages/agent/src/static-analysis/rules/languages/typescript/*.yml`,
    ]);

    const relevantRules = loadedRules.filter(r => (rules as string[]).includes(r.id));
    if (relevantRules.length === 0) {
      return { jobId: job.id, jobType: 'consistency_audit', status: 'pass', findings: 0 };
    }

    const result = await scanProject({
      project: `governance-${job.id}`,
      rootDir: workspaceRoot,
      include: ['packages/**/*.ts', 'packages/**/*.tsx'],
      ignore: ['**/node_modules/**', '**/dist/**', '**/*.test.ts', '**/*.test.tsx'],
      rules: relevantRules,
    });

    const status = result.findings.length > 0 ? 'action_required' : 'pass';
    return { jobId: job.id, jobType: 'consistency_audit', status, findings: result.findings.length };
  } catch (err) {
    return {
      jobId: job.id,
      jobType: 'consistency_audit',
      status: 'fail',
      findings: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function runHotspotDetection(
  job: GovernanceJobRecord,
  workspaceRoot: string,
): Promise<{ jobId: string; jobType: GovernanceJobType; status: 'pass' | 'fail' | 'action_required'; findings?: number; error?: string }> {
  const sizeThreshold = (job.config.sizeThreshold as number) ?? 400;

  try {
    const rules = await loadRuleFiles([
      `${workspaceRoot}/packages/agent/src/static-analysis/rules/projects/los/file-size-gate.yml`,
    ]);
    const result = await scanProject({
      project: `hotspot-${job.id}`,
      rootDir: workspaceRoot,
      include: ['packages/**/*.ts', 'packages/**/*.tsx'],
      ignore: ['**/node_modules/**', '**/dist/**', '**/*.test.ts', '**/*.test.tsx', '**/static-analysis/**'],
      rules,
    });

    // file-size-gate matches every file once (kind:program). Count files.
    const status = result.filesScanned > sizeThreshold ? 'action_required' : 'pass';
    return { jobId: job.id, jobType: 'hotspot', status, findings: result.filesScanned };
  } catch (err) {
    return {
      jobId: job.id, jobType: 'hotspot', status: 'fail', findings: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function runArchitectureDrift(
  job: GovernanceJobRecord,
  workspaceRoot: string,
): Promise<{ jobId: string; jobType: GovernanceJobType; status: 'pass' | 'fail' | 'action_required'; findings?: number; error?: string }> {
  const rules = (job.config.rules as string[]) ?? ['los.direct-infra-import', 'los.no-package-local-agents'];

  try {
    const loadedRules = await loadRuleFiles([
      `${workspaceRoot}/packages/agent/src/static-analysis/rules/projects/los/*.yml`,
    ]);
    const relevantRules = loadedRules.filter(r => rules.includes(r.id));

    const result = await scanProject({
      project: `arch-drift-${job.id}`,
      rootDir: workspaceRoot,
      include: ['packages/**/*.ts', 'packages/**/*.tsx'],
      ignore: ['**/node_modules/**', '**/dist/**', '**/*.test.ts', '**/*.test.tsx', '**/static-analysis/**'],
      rules: relevantRules,
    });

    const status = result.findings.length > 0 ? 'action_required' : 'pass';
    return { jobId: job.id, jobType: 'architecture_drift', status, findings: result.findings.length };
  } catch (err) {
    return {
      jobId: job.id, jobType: 'architecture_drift', status: 'fail', findings: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
