/**
 * Governance auditor — migration drift.
 *
 * DETECTION-ONLY. Reads the committed `tools/migration-drift-baseline.txt`
 * (the persisted drift state produced by the migration-drift CI gate,
 * tools/check-migration-drift.ts) and groups it per table so the sweeper can
 * surface one operator TODO per drifted table. A Claude agent then works the
 * TODOs via /pr-self-merge (rewrite the migration to match ensure*Store,
 * shrink the baseline) — this job never generates SQL, opens PRs, or merges.
 *
 * Why read a file instead of running the gate: the gate needs CREATEDB to
 * create scratch DBs, which the gateway runtime DATABASE_URL (app role)
 * lacks. The committed baseline IS the drift state (updated by CI); reading
 * it needs no DB. If the file is missing (e.g. a prod build without tools/),
 * the audit returns fileMissing:true → no findings, no circuit-breaker trip.
 */
import { getLogger } from '@los/infra/logger';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const log = getLogger('governance-jobs');

const DEFAULT_BASELINE = join(process.cwd(), 'tools', 'migration-drift-baseline.txt');

export type DriftCategory = 'COLUMNS' | 'INDEXES' | 'CONSTRAINTS' | 'FUNCTIONS' | 'TRIGGERS';
export type DriftDirection = 'mig-only' | 'ensure-only';
// Mirrors TodoPriority ('P0'|'P1'|'P2'|'P3'); indexes-only folds into P3 (lowest).
export type DriftPriority = 'P1' | 'P2' | 'P3';

export interface DriftEntry {
  category: DriftCategory;
  direction: DriftDirection;
  table: string;
  raw: string;
}

export interface ParsedDriftTable {
  table: string;
  priority: DriftPriority;
  columnDrift: number;
  indexDrift: number;
  constraintDrift: number;
  functionDrift: number;
  triggerDrift: number;
  migOnlyCount: number;
  ensureOnlyCount: number;
  totalDrift: number;
  ensureSource: string;
  sampleLines: string[];
}

export interface MigrationDriftAuditSummary {
  auditedAt: string;
  fileMissing: boolean;
  baselinePath: string;
  baselineLineCount: number;
  tableCount: number;
  totalDrift: number;
  tables: ParsedDriftTable[];
}

/**
 * Parse the baseline file content into per-table drift. PURE (no I/O).
 *
 * Line format (see tools/check-migration-drift.ts `diffShared`):
 *   `CATEGORY|[dir] table|...signature`
 * where CATEGORY ∈ {COLUMNS,INDEXES,CONSTRAINTS,FUNCTIONS,TRIGGERS}, [dir] is
 * `[mig-only]` or `[ensure-only]` followed by padding to a 13-char prefix
 * (4 spaces for mig-only, 1 for ensure-only). Parse with split/indexOf/
 * trimStart — do NOT hardcode the padding.
 */
export function parseMigrationDriftBaseline(content: string): DriftEntry[] {
  const entries: DriftEntry[] = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trimEnd();
    if (!trimmed) continue;
    const pipe = trimmed.indexOf('|');
    if (pipe < 0) continue;
    const category = trimmed.slice(0, pipe) as DriftCategory;
    if (!/^(COLUMNS|INDEXES|CONSTRAINTS|FUNCTIONS|TRIGGERS)$/.test(category)) continue;
    const rest = trimmed.slice(pipe + 1); // "[mig-only]    artifacts|checksum|..."
    const bracketEnd = rest.indexOf(']');
    if (bracketEnd < 0) continue;
    const direction = rest.slice(1, bracketEnd) as DriftDirection; // "mig-only" | "ensure-only"
    if (direction !== 'mig-only' && direction !== 'ensure-only') continue;
    const afterBracket = rest.slice(bracketEnd + 1).trimStart(); // "artifacts|checksum|..."
    const tableEnd = afterBracket.indexOf('|');
    const table = tableEnd < 0 ? afterBracket.trim() : afterBracket.slice(0, tableEnd).trim();
    if (!table) continue;
    entries.push({ category, direction, table, raw: trimmed });
  }
  return entries;
}

/** Pointer to the ensure*Store that owns a table (best-effort; see bootstrap.ts). */
function ensureSourceFor(table: string): string {
  const map: Record<string, string> = {
    agent_tasks: 'ensureAgentTaskStore (@los/agent/agent-task-graph)',
    task_attempts: 'ensureAgentTaskStore (@los/agent/agent-task-graph)',
    task_edges: 'ensureAgentTaskStore (@los/agent/agent-task-graph)',
    artifacts: 'ensureArtifactStore (@los/agent/artifacts)',
    executor_nodes: 'ensureExecutorNodeStore (@los/agent/executor-nodes)',
    idempotency_keys: 'ensureIdempotencyStore (@los/gateway/idempotency)',
    mcp_servers: 'ensureMCPServerStore (@los/agent/mcp-servers)',
    memory_compactions: 'ensureMemoryCompactionStore (@los/memory)',
    node_commands: 'ensureNodeCommandStore (@los/agent/node-commands)',
    observations: 'ensureMemoryStore (@los/memory)',
    provider_call_telemetry: 'ensureProviderCallTelemetryStore (@los/agent/providers/telemetry)',
    provider_compat_evidence: 'ensureProviderCompatEvidenceStore (@los/agent/provider-compat-evidence)',
    provider_promotion_decisions: 'ensureProviderPromotionDecisionStore (@los/agent/provider-promotion-decisions)',
    run_evals: 'ensureRunEvalStore (@los/agent/run-evals)',
    run_specs: 'ensureRunSpecStore (@los/agent/run-specs)',
    scheduler_decisions: 'ensureSchedulerDecisionLedgerStore (@los/agent/scheduler-decision-ledger)',
    service_instances: 'ensureServiceInstanceStore (@los/agent/service-instances)',
    session_events: 'ensureSessionEventStore (@los/agent/session-events)',
    sessions: 'ensureSessionStore (@los/agent/session)',
    skills: 'ensureSkillStore (@los/agent/skills)',
    task_runs: 'ensureTaskRunStore (@los/agent/task-runs)',
    todo_dependencies: 'ensureTodoStore (@los/agent/todos)',
    todos: 'ensureTodoStore (@los/agent/todos)',
    tool_call_states: 'ensureToolCallStateStore (@los/agent/tool-call-states)',
    verification_records: 'ensureVerificationRecordStore (@los/agent/verification-records)',
  };
  return map[table] ?? 'packages/gateway/src/bootstrap.ts (ensureAllStores — find the owning ensure*Store)';
}

/** Priority: highest-severity drift wins. */
function priorityFor(t: {
  constraintDrift: number;
  columnDrift: number;
  indexDrift: number;
  migOnlyCount: number;
  ensureOnlyCount: number;
}): DriftPriority {
  if (t.constraintDrift > 0) return 'P1'; // wrong PK/FK composition
  if (t.columnDrift > 0 && t.migOnlyCount > 0 && t.ensureOnlyCount > 0) return 'P2'; // type/null/default mismatch (silent-apply class)
  return 'P3'; // COLUMNS one-direction (missing/orphan) or INDEXES-only
}

function groupByTable(entries: DriftEntry[]): ParsedDriftTable[] {
  const byTable = new Map<string, DriftEntry[]>();
  for (const e of entries) {
    const arr = byTable.get(e.table) ?? [];
    arr.push(e);
    byTable.set(e.table, arr);
  }
  const tables: ParsedDriftTable[] = [];
  for (const [table, arr] of byTable) {
    const count = (cat: DriftCategory) => arr.filter((e) => e.category === cat).length;
    const migOnly = arr.filter((e) => e.direction === 'mig-only').length;
    const ensureOnly = arr.filter((e) => e.direction === 'ensure-only').length;
    const columnDrift = count('COLUMNS');
    const table0 = {
      constraintDrift: count('CONSTRAINTS'),
      columnDrift,
      indexDrift: count('INDEXES'),
      migOnlyCount: migOnly,
      ensureOnlyCount: ensureOnly,
    };
    tables.push({
      table,
      priority: priorityFor(table0),
      columnDrift,
      indexDrift: table0.indexDrift,
      constraintDrift: table0.constraintDrift,
      functionDrift: count('FUNCTIONS'),
      triggerDrift: count('TRIGGERS'),
      migOnlyCount: migOnly,
      ensureOnlyCount: ensureOnly,
      totalDrift: arr.length,
      ensureSource: ensureSourceFor(table),
      sampleLines: arr.slice(0, 5).map((e) => e.raw),
    });
  }
  // P1 first, then by totalDrift desc, then table name — stable, highest-value first.
  const rank: Record<DriftPriority, number> = { P1: 0, P2: 1, P3: 2 };
  tables.sort((a, b) =>
    rank[a.priority] - rank[b.priority] || b.totalDrift - a.totalDrift || a.table.localeCompare(b.table));
  return tables;
}

export async function runMigrationDriftAudit(): Promise<Record<string, unknown>> {
  const baselinePath = process.env.LOS_MIGRATION_DRIFT_BASELINE
    ? resolve(process.env.LOS_MIGRATION_DRIFT_BASELINE)
    : DEFAULT_BASELINE;
  let content: string;
  try {
    content = readFileSync(baselinePath, 'utf8');
  } catch {
    log.info(`Migration-drift baseline not found at ${baselinePath}; returning no findings`);
    const empty: MigrationDriftAuditSummary = {
      auditedAt: new Date().toISOString(),
      fileMissing: true,
      baselinePath,
      baselineLineCount: 0,
      tableCount: 0,
      totalDrift: 0,
      tables: [],
    };
    return empty as unknown as Record<string, unknown>;
  }
  const entries = parseMigrationDriftBaseline(content);
  const tables = groupByTable(entries);
  const totalDrift = tables.reduce((n, t) => n + t.totalDrift, 0);
  const summary: MigrationDriftAuditSummary = {
    auditedAt: new Date().toISOString(),
    fileMissing: false,
    baselinePath,
    baselineLineCount: content.split('\n').filter(Boolean).length,
    tableCount: tables.length,
    totalDrift,
    tables,
  };
  log.info(`Migration-drift audit: ${tables.length} tables, ${totalDrift} drift entries (baseline ${baselinePath})`);
  return summary as unknown as Record<string, unknown>;
}
