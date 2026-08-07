// K4 canary — execute the source run (LOS kernel, audit/read-only) through the
// single gateway/orchestrator entry (dispatchPersistedRunSpec) and emit the
// event cursor + evidence hash needed for experiment creation.
//
// Exactly-once contract:
//   - dedupeKey = `k4:baseline:<runSpecId>:<planRevision>` (revision-scoped)
//   - run contract must declare recoveryPolicy=explicit_only so a gateway
//     restart can never auto re-run the baseline
//   - execution is forced local (executor disabled) and read-only
//
// Usage: ./packages/gateway/node_modules/.bin/tsx tools/k4-run-source.mts <runSpecId> <sessionId>
import { createHash } from 'node:crypto';
import { loadConfig } from '../packages/infra/src/config.ts';
import { initDb, closeDb, getDb } from '../packages/infra/src/db.ts';
import { loadRunSpec } from '../packages/agent/src/run-specs.ts';
import { dispatchPersistedRunSpec } from '../packages/gateway/src/run-resume-dispatch.ts';

const [runSpecId, sessionId] = process.argv.slice(2);
if (!runSpecId || !sessionId) {
  console.error('usage: tsx tools/k4-run-source.mts <runSpecId> <sessionId>');
  process.exit(2);
}

const config = await loadConfig();
await initDb(config.databaseUrl);

const spec = await loadRunSpec(runSpecId);
if (!spec) throw new Error(`run spec not found: ${runSpecId}`);
if (spec.runContract?.recoveryPolicy !== 'explicit_only') {
  throw new Error(`K4 source run must declare recoveryPolicy=explicit_only (got '${spec.runContract?.recoveryPolicy ?? 'automatic'}'); recreate the run spec`);
}
if ((spec.toolMode ?? 'read-only') !== 'read-only') {
  throw new Error(`K4 source run must be read-only (got toolMode='${spec.toolMode}')`);
}

const planRevision = spec.runContract?.planRevision ?? 1;
const dedupeKey = `k4:baseline:${runSpecId}:${planRevision}`;

const result = await dispatchPersistedRunSpec(runSpecId, 'execution', {
  dedupeKey,
  executor: { enabled: false },
});
if (result.status === 'failed' || !result.taskRunId) {
  throw new Error(`K4 source dispatch failed: ${result.status}${result.error ? `: ${result.error}` : ''}`);
}

// Event cursor: last session event seq for this session.
const rows = await getDb().query<{ id: number; type: string }>(
  `SELECT id, type FROM session_events
   WHERE session_id = $1 ORDER BY id DESC LIMIT 1`,
  [sessionId],
);
const last = rows.rows[0];
const eventCursor = last ? Number(last.id) : 0;
const evidenceHash = createHash('sha256')
  .update(JSON.stringify({ sessionId, runSpecId, eventCursor, lastEventType: last?.type ?? null, taskRunId: result.taskRunId, dedupeKey }))
  .digest('hex')
  .slice(0, 40);

console.log(JSON.stringify({
  runSpecId,
  sessionId,
  taskRunId: result.taskRunId,
  taskRunStatus: result.status,
  dedupeKey,
  recoveryPolicy: spec.runContract?.recoveryPolicy,
  eventCursor,
  lastEventType: last?.type ?? null,
  evidenceHash,
  fingerprint: { prompt: createHash('sha256').update(spec.prompt).digest('hex').slice(0, 16), spec: runSpecId },
}, null, 2));

await closeDb();
