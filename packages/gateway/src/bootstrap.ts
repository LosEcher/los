/**
 * @los/gateway/bootstrap — canonical "create all runtime tables" entrypoint.
 *
 * ensureAllStores() calls every ensure*Store() in the codebase in a
 * dependency-safe order. The gateway calls it once at startup, right after
 * migrateDir, so the runtime schema is fully materialized (and any
 * migration-vs-ensure drift is self-healed) before any request is served —
 * with no "first feature use patches the schema" window.
 *
 * This is the single source of truth for the set of ensure*Store functions.
 * tools/check-migration-drift.ts imports ensureAllStores() from here so the
 * drift gate bootstraps its ensure-only DB with the exact same set.
 *
 * Ordering: only dead_letter_events has an inline FK REFERENCES (→ task_runs,
 * run_specs), so ensureDeadLetterStore runs last. All other ensure*Store have
 * no inline FK and are order-independent.
 */
import {
  ensureAgentTaskGraphStore, ensureArtifactStore, ensureCancellationStore,
  ensureDeadLetterStore, ensureExecutorNodeStore,
  ensureExternalToolSummaryStore, ensureGovernanceJobStore, ensureMCPServerStore,
  ensureNodeCommandStore, ensureProviderCompatEvidenceStore,
  ensureProviderPromotionDecisionStore, ensureRunEvalStore, ensureRunSpecStore,
  ensureSchedulerDecisionLedgerStore, ensureServiceInstanceStore, ensureSessionEventStore,
  ensureSessionStore, ensureSkillStore, ensureStaticGraphBaselineStore,
  ensureStreamCheckpointStore, ensureStreamLeaseStore, ensureTaskRunStore,
  ensureTodoStore, ensureVerificationRecordStore, ensureRuleStore,
} from '@los/agent';
// Not in the @los/agent barrel (intentionally internal) — use subpath exports.
import { ensureExecutionStore } from '@los/agent/execution-store';
import { ensureToolCallStateStore } from '@los/agent/tool-call-states';
import { ensureProviderCallTelemetryStore } from '@los/agent/providers/telemetry';
import { ensureMemoryStore, ensureMemoryCompactionStore, ensureProceduralCandidateStore } from '@los/memory';
import { ensureIdempotencyStore } from './idempotency.js';
import { getLogger } from '@los/infra/logger';

const log = getLogger('bootstrap');

export async function ensureAllStores(): Promise<void> {
  // No-inline-FK stores — order-independent.
  await ensureMemoryStore();
  await ensureMemoryCompactionStore();
  await ensureProceduralCandidateStore();
  await ensureTaskRunStore();
  await ensureRunSpecStore();
  await ensureAgentTaskGraphStore();
  await ensureExecutorNodeStore();
  await ensureServiceInstanceStore();
  await ensureTodoStore();
  await ensureSkillStore();
  await ensureRuleStore();
  await ensureSessionStore();
  await ensureSessionEventStore();
  await ensureSchedulerDecisionLedgerStore();
  await ensureStreamCheckpointStore();
  await ensureStreamLeaseStore();
  await ensureToolCallStateStore();
  await ensureVerificationRecordStore();
  await ensureNodeCommandStore();
  await ensureMCPServerStore();
  await ensureRunEvalStore();
  await ensureExternalToolSummaryStore();
  await ensureProviderCompatEvidenceStore();
  await ensureProviderPromotionDecisionStore();
  await ensureCancellationStore();
  await ensureExecutionStore();
  await ensureStaticGraphBaselineStore();
  await ensureGovernanceJobStore();
  await ensureArtifactStore();
  await ensureProviderCallTelemetryStore();
  await ensureIdempotencyStore();
  // Last: inline FK to task_runs + run_specs (created above).
  await ensureDeadLetterStore();
  log.info('All runtime stores ensured');
}
