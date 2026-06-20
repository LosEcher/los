import { loadConfig } from '@los/infra/config';
import { initDb, getDb } from '@los/infra/db';

// Pre-initialize DB and all agent stores before tests run concurrently.
// This avoids a race where node --test's parallel file execution causes
// two test files to call the same ensure*Store() simultaneously — both
// see _initialized=false, both CREATE TABLE, and a third file tries to
// INSERT before the table exists.

const config = await loadConfig();
await initDb(config.databaseUrl);

// Drop stale governance_jobs from previous partial test runs
await getDb().exec('DROP TABLE IF EXISTS governance_jobs CASCADE').catch(() => undefined);

// Import all ensure*Store functions and call them sequentially.
// Dynamic imports to avoid circular module issues.
const stores = await Promise.all([
  import('./agent-task-graph.js'),
  import('./artifacts.js'),
  import('./cancellation.js'),
  import('./execution-store.js'),
  import('./executor-nodes.js'),
  import('./external-tool-summary.js'),
  import('./mcp-servers.js'),
  import('./node-commands.js'),
  import('./provider-compat-evidence.js'),
  import('./provider-promotion-decisions.js'),
  import('./rules.js'),
  import('./run-evals.js'),
  import('./run-specs.js'),
  import('./scheduler-decision-ledger.js'),
  import('./service-instances.js'),
  import('./session.js'),
  import('./session-events.js'),
  import('./skills.js'),
  import('./stream-checkpoints.js'),
  import('./stream-lease.js'),
  import('./task-runs.js'),
  import('./todos.js'),
  import('./tool-call-states.js'),
  import('./verification-records.js'),
]);

const ensureFns = [
  'ensureAgentTaskGraphStore',
  'ensureArtifactStore',
  'ensureCancellationStore',
  'ensureExecutionStore',
  'ensureExecutorNodeStore',
  'ensureExternalToolSummaryStore',
  'ensureMCPServerStore',
  'ensureNodeCommandStore',
  'ensureProviderCompatEvidenceStore',
  'ensureProviderPromotionDecisionStore',
  'ensureRuleStore',
  'ensureRunEvalStore',
  'ensureRunSpecStore',
  'ensureSchedulerDecisionLedgerStore',
  'ensureServiceInstanceStore',
  'ensureSessionStore',
  'ensureSessionEventStore',
  'ensureSkillStore',
  'ensureStreamCheckpointStore',
  'ensureStreamLeaseStore',
  'ensureTaskRunStore',
  'ensureTodoStore',
  'ensureToolCallStateStore',
  'ensureVerificationRecordStore',
];

for (let i = 0; i < stores.length; i++) {
  const mod = stores[i] as Record<string, Function>;
  const fn = mod[ensureFns[i]];
  if (typeof fn === 'function') await fn();
}
