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
  tenantId: 'local',
  projectId: 'los',
  prompt: 'Read packages/agent/package.json and report the exact values of the "name" and "version" fields as JSON. Make at most one read_file call. Do not write anything and do not use any other tool.',
  workspaceRoot: '/Users/echerlos/projects/los-workspace/projects/los',
  toolMode: 'read-only',
  allowedTools: ['read_file'],
  maxLoops: 3,
  timeoutMs: 90_000,
  runContract: { mode: 'audit', executionMode: 'heavyweight', phase: 'planning', recoveryPolicy: 'explicit_only' },
});

await persistRunSpecPlan(runSpecId, {
  plan: [
    {
      id: 's1',
      title: 'Read package manifest',
      description: 'Read packages/agent/package.json once and report the name and version fields.',
      dependsOnIds: [],
      editableSurfaces: [],
      completionCriteria: 'name and version reported as JSON',
    },
  ],
  verifications: [
    {
      id: 'v1',
      kind: 'command',
      description: 'package manifest exists',
      command: 'test -f packages/agent/package.json',
    },
  ],
  actor: 'operator',
  summary: 'K4-R2 source plan: bounded single-file read (operator-constructed)',
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
