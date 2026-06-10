import { recordRunEval, type RecordRunEvalInput } from './run-evals.js';

export interface EvalBacklogCase {
  caseId: string;
  name: string;
  hasProbe: boolean;
  probeFile?: string;
}

const BACKLOG_CASES: EvalBacklogCase[] = [
  { caseId: 'E01', name: 'Dirty Worktree Formatter', hasProbe: false },
  { caseId: 'E02', name: 'Runtime Truth From Config', hasProbe: true, probeFile: 'eval-probes.test.ts' },
  { caseId: 'E03', name: 'Provider Readiness As Compatibility', hasProbe: true, probeFile: 'eval-probes.test.ts' },
  { caseId: 'E04', name: 'External Transcript As Replay Evidence', hasProbe: false },
  { caseId: 'E05', name: 'Git Detached Head In A jj Repo', hasProbe: false },
  { caseId: 'E06', name: 'Todo Done Without Execution Evidence', hasProbe: false },
  { caseId: 'E07', name: 'Legacy Repo As Active Target', hasProbe: false },
  { caseId: 'E08', name: 'ADR Repeated Without Source Check', hasProbe: true, probeFile: 'eval-probes.test.ts' },
  { caseId: 'E09', name: 'Operation Smoke Not Promoted', hasProbe: false },
  { caseId: 'E10', name: 'Flattened Provider Truth', hasProbe: false },
  { caseId: 'E11', name: 'Scope Drift In Long Autonomy', hasProbe: false },
  { caseId: 'E12', name: 'Missing Stop Condition', hasProbe: false },
  { caseId: 'E13', name: 'Tool Permission Mismatch', hasProbe: false },
  { caseId: 'E14', name: 'Run Spec Missing Operator Contract', hasProbe: false },
  { caseId: 'E15', name: 'Tool Event Without Recoverable State', hasProbe: false },
  { caseId: 'E16', name: 'Verification Claim Without State', hasProbe: false },
  { caseId: 'E17', name: 'External Adapter Before Redaction', hasProbe: false },
  { caseId: 'E18', name: 'Planner DAG Before State', hasProbe: false },
  { caseId: 'E19', name: 'Commit Without Boundary', hasProbe: false },
  { caseId: 'E20', name: 'Live UI As Sole Proof', hasProbe: false },
];

/**
 * Record the current state of the eval backlog into run_evals.
 * Each case gets a row with its probe coverage status and a timestamp.
 * Automated probes (E02, E03, E08) are marked as monitored;
 * manual-only cases are marked as document-backed.
 */
export async function recordEvalBacklogSnapshot(input: {
  probeResults?: Array<{ caseId: string; passed: boolean; durationMs?: number }>;
  triggeredBy?: string;
}): Promise<{ recorded: number; automated: number; manual: number }> {
  const snapshotId = `eval-backlog-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const now = new Date().toISOString();
  const probeMap = new Map((input.probeResults ?? []).map(p => [p.caseId, p]));

  let automated = 0;
  let manual = 0;

  for (const c of BACKLOG_CASES) {
    const probeResult = probeMap.get(c.caseId);
    const passed = probeResult?.passed;

    const evalInput: RecordRunEvalInput = {
      id: `eval-backlog/${c.caseId}/${snapshotId}`,
      runSpecId: 'eval-backlog',
      provider: 'backlog',
      model: c.hasProbe ? 'automated-probe' : 'document-only',
      success: c.hasProbe ? (passed ?? false) : false,
      latencyMs: probeResult?.durationMs,
      verificationStatus: c.hasProbe ? (passed ? 'succeeded' : 'failed') : 'not_required',
      failureClass: c.hasProbe && !passed ? 'eval_backlog_probe_failed' : undefined,
      summary: {
        kind: 'eval_backlog_snapshot',
        caseId: c.caseId,
        name: c.name,
        hasProbe: c.hasProbe,
        probeFile: c.probeFile ?? null,
        passed: passed ?? null,
        recordedAt: now,
        triggeredBy: input.triggeredBy ?? null,
      },
    };

    await recordRunEval(evalInput).catch(() => undefined);

    if (c.hasProbe) {
      automated++;
    } else {
      manual++;
    }
  }

  return { recorded: automated + manual, automated, manual };
}

export function getEvalBacklogCases(): EvalBacklogCase[] {
  return BACKLOG_CASES;
}
