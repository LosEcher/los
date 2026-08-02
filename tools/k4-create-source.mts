// K4 canary — construct the source run spec with a persisted plan (AP2).
// Run from repo root: node --import tsx tools/k4-create-source.mts
import { loadConfig } from '../packages/infra/src/config.ts';
import { initDb, closeDb } from '../packages/infra/src/db.ts';
import { createRunSpec, approveRunSpecPhase, loadRunSpec } from '../packages/agent/src/run-specs.ts';
import { persistRunSpecPlan } from '../packages/agent/src/run-spec-plans.ts';

const config = await loadConfig();
await initDb(config.databaseUrl);

const runSpecId = `run-k4-source-${Date.now()}`;
const sessionId = `session-k4-source-${Date.now()}`;

await createRunSpec({
  id: runSpecId,
  sessionId,
  prompt: 'K4 canary source run (audit, read-only). Baseline run for the Pi K4 execution-kernel experiment.',
  workspaceRoot: '/Users/echerlos/projects/los-workspace/projects/los',
  toolMode: 'read-only',
  runContract: { mode: 'audit', executionMode: 'heavyweight', phase: 'planning' },
});

await persistRunSpecPlan(runSpecId, {
  plan: [
    {
      id: 's1',
      title: 'Inspect P1 queue document',
      description: 'Read docs/governance/2026-07-16-current-p0-p1-queue.md and list the open P1 items with their state.',
      dependsOnIds: [],
      editableSurfaces: ['docs/governance/2026-07-16-current-p0-p1-queue.md'],
      completionCriteria: 'Open P1 items listed with their queue-document state',
    },
    {
      id: 's2',
      title: 'Summarize remaining gaps',
      description: 'Produce a short summary of the open P1 gaps and the next operator action for each.',
      dependsOnIds: ['s1'],
      editableSurfaces: [],
      completionCriteria: 'Gap summary produced with next actions',
    },
  ],
  verifications: [
    {
      id: 'v1',
      kind: 'command',
      description: 'queue document exists',
      command: 'test -f docs/governance/2026-07-16-current-p0-p1-queue.md',
    },
  ],
  actor: 'operator',
  summary: 'K4 canary source plan (operator-constructed)',
});

await approveRunSpecPhase(runSpecId, {
  actor: 'operator',
  reason: 'K4 canary source run — operator authorized 2026-07-31 (docs/governance/2026-07-16-current-p0-p1-queue.md addendum)',
});

const record = await loadRunSpec(runSpecId);
console.log(JSON.stringify({
  runSpecId,
  sessionId,
  phase: record?.runContract?.phase,
  planSteps: record?.runContract?.plan?.length,
  status: record?.status,
}));

await closeDb();
