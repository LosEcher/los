// pairwise-sample-ingest.mts — produce pairwise sample-gate samples from
// execution experiments (deterministic evidence channel).
//
// Usage (from repo root, gateway/executor running for --run-baseline):
//   ./packages/gateway/node_modules/.bin/tsx tools/pairwise-sample-ingest.mts \
//     --experiment experiment-k4-canary-20260803d \
//     [--run-baseline] [--verdict baseline|candidate|tie|inconclusive]
//
// Sample production strategy (2026-08-04, docs/operations/2026-08-04-sample-gate-ingestion.md):
//   - Each execution experiment (source = baseline, candidate = kernel experiment)
//     becomes one pairwise run_eval row.
//   - deterministic channel is auto-extracted from DB evidence; human/judge
//     channels can be added later through POST /run-evals/pairwise.
//   - --run-baseline additionally executes the source prompt through the default
//     LOS kernel so both sides carry execution evidence.
import { loadConfig } from '../packages/infra/src/config.ts';
import { initDb, closeDb } from '../packages/infra/src/db.ts';
import { recordPairwiseRunEval } from '../packages/agent/src/run-evals/pairwise.ts';
import { createRunSpec, approveRunSpecPhase } from '../packages/agent/src/run-specs.ts';
import { persistRunSpecPlan } from '../packages/agent/src/run-spec-plans.ts';

export const K4_PLANNING_RUBRIC = {
  id: 'rubric-k4-kernel-planning',
  revision: 'v1',
  criteria: [
    { id: 'execution_evidence', label: 'Kernel execution evidence', description: 'kernel.started/finished events present and complete', maxScore: 5 },
    { id: 'planning_output', label: 'Planning output substance', description: 'non-empty plan text produced in planning disposition', maxScore: 5 },
    { id: 'token_efficiency', label: 'Token efficiency', description: 'completion tokens used for the planning pass', maxScore: 5 },
    { id: 'loop_stability', label: 'Loop stability', description: 'single pass, no retries or loops beyond one turn', maxScore: 5 },
  ],
} as const;

function extractEvidence(db: Awaited<ReturnType<typeof import('../packages/infra/src/db.ts').initDb>>, rows: Array<Record<string, unknown>>) {
  const kernelStarted = rows.find(row => row.type === 'kernel.started');
  const kernelFinished = rows.find(row => row.type === 'kernel.finished');
  const finished = kernelFinished ? (kernelFinished.payload_json as any) ?? {} : {};
  const tokens = finished.evidence?.totalTokens ?? {};
  return {
    hasKernelEvidence: Boolean(kernelStarted && kernelFinished),
    textLength: finished.evidence?.textLength ?? 0,
    loopCount: finished.evidence?.loopCount ?? 0,
    promptTokens: tokens.prompt ?? 0,
    completionTokens: tokens.completion ?? 0,
  };
}

function deterministicChannel(base: ReturnType<typeof extractEvidence>): {
  source: string;
  verdict: 'baseline' | 'candidate' | 'tie' | 'inconclusive';
  criterionScores: Array<{ criterionId: string; score: number; note?: string }>;
  note: string;
  confidence: number;
  verificationStatus: string;
} {
  const criterionScores = [
    { criterionId: 'execution_evidence', score: base.hasKernelEvidence ? 5 : 0, note: base.hasKernelEvidence ? 'kernel events present' : 'no execution evidence' },
    { criterionId: 'planning_output', score: base.textLength > 100 ? 5 : base.textLength > 0 ? 3 : 0, note: `textLength=${base.textLength}` },
    { criterionId: 'token_efficiency', score: base.completionTokens <= 300 ? 5 : base.completionTokens <= 600 ? 3 : 1, note: `completion=${base.completionTokens}` },
    { criterionId: 'loop_stability', score: base.loopCount <= 1 ? 5 : base.loopCount <= 3 ? 3 : 0, note: `loops=${base.loopCount}` },
  ];
  return {
    source: 'los.sample-gate-ingest',
    verdict: 'inconclusive',
    criterionScores,
    note: 'deterministic extraction from session events',
    confidence: 0.7,
    verificationStatus: 'succeeded',
  };
}

/** Compare two extracted evidences and return the pairwise verdict. */
function compareEvidence(base: ReturnType<typeof extractEvidence>, candidate: ReturnType<typeof extractEvidence>): 'baseline' | 'candidate' | 'tie' | 'inconclusive' {
  if (!base.hasKernelEvidence && !candidate.hasKernelEvidence) return 'inconclusive';
  if (!base.hasKernelEvidence) return 'inconclusive';
  if (!candidate.hasKernelEvidence) return 'inconclusive';
  const score = (evidence: ReturnType<typeof extractEvidence>) =>
    (evidence.hasKernelEvidence ? 5 : 0)
    + (evidence.textLength > 100 ? 5 : evidence.textLength > 0 ? 3 : 0)
    + (evidence.completionTokens <= 300 ? 5 : evidence.completionTokens <= 600 ? 3 : 1)
    + (evidence.loopCount <= 1 ? 5 : evidence.loopCount <= 3 ? 3 : 0);
  const baseScore = score(base);
  const candidateScore = score(candidate);
  if (candidateScore > baseScore) return 'candidate';
  if (baseScore > candidateScore) return 'baseline';
  return 'tie';
}

async function main() {
  const args = process.argv.slice(2);
  const experimentId = args.find((arg, index) => args[index - 1] === '--experiment');
  const runBaseline = args.includes('--run-baseline');
  if (!experimentId) throw new Error('--experiment <id> is required');
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  const { getDb } = await import('../packages/infra/src/db.ts');
  const db = getDb();

  const experimentRows = await db.query<{ source_run_spec_id: string; candidate_run_spec_id: string | null }>(
    'SELECT source_run_spec_id, candidate_run_spec_id FROM execution_experiments WHERE id=$1',
    [experimentId],
  );
  const experiment = experimentRows.rows[0];
  if (!experiment || !experiment.candidate_run_spec_id) throw new Error(`experiment not found or has no candidate: ${experimentId}`);

  const baselineId = experiment.source_run_spec_id;
  const candidateId = experiment.candidate_run_spec_id;

  // Optional: execute the baseline through the default LOS kernel so both sides
  // carry execution evidence.
  if (runBaseline) {
    const sourceRows = await db.query<{ session_id: string; prompt: string; run_contract_json: unknown; workspace_root: string; tool_mode: string }>(
      'SELECT session_id, prompt, run_contract_json, workspace_root, tool_mode FROM run_specs WHERE id=$1',
      [baselineId],
    );
    const source = sourceRows.rows[0];
    if (!source) throw new Error(`source run spec not found: ${baselineId}`);
    const contract = source.run_contract_json as { plan?: unknown[]; verifications?: unknown[] };
    const baselineRunSpecId = `run-baseline-${experimentId}-${Date.now()}`;
    const sessionId = `session-baseline-${experimentId}-${Date.now()}`;
    await createRunSpec({
      id: baselineRunSpecId,
      sessionId,
      tenantId: 'local',
      projectId: 'los',
      prompt: source.prompt,
      workspaceRoot: source.workspace_root,
      toolMode: 'read-only',
      runContract: {
        mode: 'audit',
        executionMode: 'heavyweight',
        phase: 'planning',
        plan: contract.plan as any,
        verifications: contract.verifications as any,
      },
    });
    await persistRunSpecPlan(baselineRunSpecId, {
      plan: contract.plan as any,
      verifications: (contract.verifications as any) ?? [],
      actor: 'sample-gate-ingest',
      summary: 'baseline LOS kernel execution for pairwise sample',
    });
    await approveRunSpecPhase(baselineRunSpecId, { actor: 'operator', reason: 'sample-gate baseline approval' });
    console.log(`baseline run created: ${baselineRunSpecId} (session ${sessionId}) — dispatch through POST /runs/:id/approve flow or scheduler`);
  }

  async function eventsFor(runSpecId: string) {
    const rows = await db.query<{ type: string; payload_json: unknown }>(
      `SELECT se.type, se.payload_json FROM session_events se
       JOIN run_specs rs ON rs.session_id = se.session_id
       WHERE rs.id=$1 AND se.type IN ('kernel.started','kernel.finished') ORDER BY se.id`,
      [runSpecId],
    );
    return rows.rows;
  }

  const baselineEvents = await eventsFor(baselineId);
  const candidateEvents = await eventsFor(candidateId);
  const baselineEvidence = extractEvidence(db, baselineEvents as any);
  const candidateEvidence = extractEvidence(db, candidateEvents as any);

  const baselineChannel = deterministicChannel(baselineEvidence);
  const candidateChannel = deterministicChannel(candidateEvidence);
  const verdict = (args.find((arg, index) => args[index - 1] === '--verdict') as any)
    ?? compareEvidence(baselineEvidence, candidateEvidence);

  // Replace the previous ingest record for this pair when re-running
  // (idempotent sample ingestion).
  await db.query(
    `DELETE FROM run_evals WHERE experiment_id=$1 AND baseline_run_spec_id=$2 AND candidate_run_spec_id=$3 AND rubric_revision=$4`,
    [experimentId, baselineId, candidateId, K4_PLANNING_RUBRIC.revision],
  );

  const record = await recordPairwiseRunEval({
    experimentId,
    baselineRunSpecId: baselineId,
    candidateRunSpecId: candidateId,
    rubricRevision: K4_PLANNING_RUBRIC.revision,
    rubricSnapshot: { id: K4_PLANNING_RUBRIC.id, revision: K4_PLANNING_RUBRIC.revision, criteria: [...K4_PLANNING_RUBRIC.criteria] },
    verdict: verdict as any,
    deterministic: {
      ...candidateChannel,
      verdict,
      criterionScores: candidateChannel.criterionScores,
      note: `deterministic comparison; baseline=${JSON.stringify(baselineEvidence)}`,
    },
    summary: {
      kind: 'pairwise',
      metricSource: 'execution_projection',
      scenarioId: (args.find((arg, index) => args[index - 1] === '--scenario') as string) ?? 'k4-planning',
      baselineEvidence,
      candidateEvidence,
      ingestedBy: 'sample-gate-ingest',
    },
  });
  console.log(JSON.stringify({
    recordId: record.id,
    pairId: record.pairId,
    experimentId,
    verdict: record.pairwiseVerdict,
    baselineEvidence,
    candidateEvidence,
  }, null, 2));
  await closeDb();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
