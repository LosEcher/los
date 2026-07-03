/**
 * ensureAllAgentStores — single entry point for all agent-owned store tables.
 *
 * Call this once before tests (sequentially, to avoid parallel CREATE TABLE
 * races in node --test) or at bootstrap before any request is served.
 *
 * This is the canonical list of agent-owned ensure*Store functions.
 * When adding a new store, add its ensure*Store() here.
 *
 * Uses dynamic imports to avoid circular module issues when called from
 * within the @los/agent package itself (e.g. test-setup.ts).
 */
export async function ensureAllAgentStores(): Promise<void> {
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
    import('./dead-letter.js'),
    import('./governance-jobs.js'),
    import('./static-graph-baselines.js'),
    import('./worker-messages.js'),
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
    'ensureDeadLetterStore',
    'ensureGovernanceJobStore',
    'ensureStaticGraphBaselineStore',
    'ensureWorkerMessageStore',
  ];

  for (let i = 0; i < stores.length; i++) {
    const mod = stores[i] as Record<string, Function>;
    const fn = mod[ensureFns[i]];
    if (typeof fn === 'function') await fn();
  }
}
