/**
 * Inject a smoke run spec for the interrupted-run recovery drill (G1).
 *
 *   ./packages/gateway/node_modules/.bin/tsx tools/smoke-interrupted-run-inject.ts \
 *     --phase plan_approved --suffix <suffix>
 *
 *   --phase plan_approved  simulate "approved but dispatch never persisted"
 *                          (kill gateway before dispatch; restart must auto-resume)
 *   --phase planning       create in planning phase; approve via POST /runs/:id/approve
 *
 * Prints { sessionId, runId, phase } for the orchestration script.
 */
import { loadConfig } from '../packages/infra/src/config.ts';
import { initDb, closeDb } from '../packages/infra/src/db.ts';
import { createRunSpec, loadRunSpec } from '../packages/agent/src/run-specs.ts';
import { ensureRunSpecStore } from '../packages/agent/src/run-specs.ts';
import { ensureSessionStore, saveSession } from '../packages/agent/src/session.ts';
import type { PlanStep } from '../packages/agent/src/run-plan-types.ts';

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const PLAN_STEPS: PlanStep[] = [{
  id: 'step-1',
  title: 'Reply with the smoke marker',
  description: 'Reply exactly with the text: los interrupted-run recovery smoke ok',
  dependsOnIds: [],
  editableSurfaces: ['docs/'],
  completionCriteria: 'Reply text equals "los interrupted-run recovery smoke ok"',
}];

async function main(): Promise<void> {
  const phase = argValue('phase') ?? 'planning';
  const suffix = argValue('suffix') ?? Date.now().toString(16);
  const prompt = argValue('prompt') ?? 'Reply exactly: los interrupted-run recovery smoke ok';
  if (phase !== 'planning' && phase !== 'plan_approved') {
    throw new Error(`invalid --phase ${phase}; expected planning|plan_approved`);
  }

  const config = await loadConfig();
  await initDb(config.databaseUrl);
  await ensureSessionStore();
  await ensureRunSpecStore();

  const sessionId = `session-smoke-interrupted-${suffix}`;
  const runId = `run-smoke-interrupted-${suffix}`;

  await saveSession({
    id: sessionId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    messages: [],
    turns: [],
    metadata: { smoke: true, purpose: 'interrupted-run-recovery' },
  });

  await createRunSpec({
    id: runId,
    sessionId,
    prompt,
    workspaceRoot: process.cwd(),
    toolMode: 'read-only',
    maxLoops: 5,
    timeoutMs: 120_000,
    runContract: {
      mode: 'execution',
      executionMode: 'standard',
      phase,
      planRevision: 1,
      plan: PLAN_STEPS,
      requiredChecks: ['echo los-interrupted-run-recovery-smoke-ok'],
    },
  });

  const loaded = await loadRunSpec(runId);
  console.log(JSON.stringify({
    sessionId,
    runId,
    phase: loaded?.runContract?.phase ?? null,
    status: loaded?.status ?? null,
  }, null, 2));

  await closeDb().catch(() => undefined);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
