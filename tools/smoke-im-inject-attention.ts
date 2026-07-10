/**
 * Inject a planning run_spec + run.operator_attention_required for IM smoke.
 *
 *   pnpm --filter @los/agent exec tsx ../../tools/smoke-im-inject-attention.ts
 *   pnpm --filter @los/agent exec tsx ../../tools/smoke-im-inject-attention.ts --approve
 */
import { loadConfig } from '@los/infra/config';
import { initDb, closeDb } from '@los/infra/db';
import {
  approveRunSpecPhase,
  createRunSpec,
  ensureRunSpecStore,
  loadRunSpec,
} from '../packages/agent/src/run-specs.ts';
import { ensureSessionEventStore, appendSessionEvent } from '../packages/agent/src/session-events.ts';
import { ensureSessionStore, saveSession } from '../packages/agent/src/session.ts';

async function main(): Promise<void> {
  const doApprove = process.argv.includes('--approve');
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  await ensureSessionStore();
  await ensureRunSpecStore();
  await ensureSessionEventStore();

  const suffix = Date.now().toString(16);
  const sessionId = `session-smoke-im-${suffix}`;
  const runId = `run-smoke-im-${suffix}`;

  await saveSession({
    id: sessionId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    messages: [],
    turns: [],
    metadata: { smoke: true, purpose: 'im-run-approval' },
  });

  await createRunSpec({
    id: runId,
    sessionId,
    prompt: 'SMOKE IM run approval — planning phase',
    workspaceRoot: process.cwd(),
    toolMode: 'read-only',
    runContract: {
      mode: 'execution',
      goal: 'smoke im approve-phase',
      editableSurfaces: ['docs/'],
      phase: 'planning',
      requiredChecks: [],
    },
  });

  await appendSessionEvent({
    sessionId,
    type: 'run.operator_attention_required',
    source: 'operator',
    payload: {
      runSpecId: runId,
      reason: 'smoke: waiting for #approve-phase',
      phase: 'planning',
    },
  });

  if (doApprove) {
    await approveRunSpecPhase(runId, {
      actor: 'smoke-script',
      reason: 'smoke simulated #approve-phase',
    });
  }

  const loaded = await loadRunSpec(runId);
  console.log(JSON.stringify({
    sessionId,
    runId,
    phase: loaded?.runContract?.phase ?? null,
    imCommands: {
      approvePhase: `#approve-phase ${runId} smoke ok`,
      verifyRun: `#verify-run ${runId}`,
      status: `#status ${sessionId}`,
    },
  }, null, 2));

  await closeDb().catch(() => undefined);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
