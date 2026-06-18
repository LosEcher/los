export type RunContractMode = 'audit' | 'execution' | 'closeout' | 'governance' | 'feed-analysis-ingress';

/**
 * Execution mode controls how much human oversight is required.
 *
 * - lightweight: agent auto-executes; plan_approved gate is skipped.
 *                Suitable for simple queries, read-only ops, summarization.
 * - standard:    normal flow with plan_approved gate (default).
 * - heavyweight: all phase transitions with confidence < 0.9 trigger operator_attention.
 *                Suitable for data migrations, production config changes, destructive ops.
 */
export type ExecutionMode = 'lightweight' | 'standard' | 'heavyweight';

/** Execution modes that skip the plan_approved human gate. */
const AUTO_APPROVE_MODES: ReadonlySet<ExecutionMode> = new Set(['lightweight']);

/** Confidence threshold below which heavyweight mode triggers operator_attention. */
export const HEAVYWEIGHT_CONFIDENCE_THRESHOLD = 0.9;

/**
 * Durable run phase — legal lifecycle transitions for a single agent run.
 *
 *   created → discovering → discovery_ready
 *          → planning    → plan_approved
 *          → executing   → verifying
 *          → succeeded | blocked | failed
 *
 * Iteration = create a new plan revision or task attempt with links to the
 * failed verification evidence. Never silently loop inside one opaque agent call.
 */
export type RunPhase =
  | 'created'
  | 'discovering'
  | 'discovery_ready'
  | 'planning'
  | 'plan_approved'
  | 'executing'
  | 'verifying'
  | 'succeeded'
  | 'blocked'
  | 'failed';

/** Terminal phases — no further transitions allowed. */
const TERMINAL_PHASES: ReadonlySet<RunPhase> = new Set(['succeeded', 'failed']);

/** Legal phase transitions. Every transition not in this map is rejected. */
const PHASE_TRANSITIONS: ReadonlyMap<RunPhase, ReadonlySet<RunPhase>> = new Map([
  ['created',         new Set(['discovering', 'planning', 'executing', 'failed'])],
  ['discovering',     new Set(['discovery_ready', 'failed'])],
  ['discovery_ready', new Set(['planning', 'failed'])],
  ['planning',        new Set(['plan_approved', 'failed'])],
  ['plan_approved',   new Set(['executing', 'failed'])],
  ['executing',       new Set(['verifying', 'failed'])],
  ['verifying',       new Set(['succeeded', 'blocked', 'failed'])],
  ['blocked',         new Set(['verifying', 'failed'])],
  ['succeeded',       new Set()],
  ['failed',          new Set()],
]);

/**
 * Plan step — a unit of intended work. Not every plan step is an executable
 * verification command. Use `VerificationRequirement` for checks that map to
 * an actual command, assertion, or structured operator-review gate.
 */
export interface PlanStep {
  id: string;
  title: string;
  description: string;
  dependsOnIds: string[];
  editableSurfaces: string[];
  completionCriteria: string;
}

/**
 * Verification requirement — an executable check, structured assertion, or
 * operator-review gate that must pass before the run can succeed.
 * Only explicitly executable assertions become command-backed
 * `verification_records`.
 */
export interface VerificationRequirement {
  id: string;
  kind: 'command' | 'assertion' | 'operator_review';
  description: string;
  /** Shell command for `command` kind. */
  command?: string;
  /** Structured condition for `assertion` kind. */
  assertion?: string;
  /** Who must approve for `operator_review` kind. */
  reviewer?: string;
}

/**
 * Lifecycle hooks attached to a task/run. Each hook is a shell command or script
 * path executed at the corresponding lifecycle event. Hook failures emit a
 * warning session event but do NOT block the main operation.
 *
 * Pattern inspired by Trellis's config.yaml lifecycle hooks.
 */
export interface TaskLifecycleHooks {
  /** Run after the run spec is created */
  afterCreate?: string[];
  /** Run when the task transitions to in_progress */
  afterStart?: string[];
  /** Run when the task completes (succeeded/failed/cancelled) */
  afterFinish?: string[];
  /** Run when the task is archived */
  afterArchive?: string[];
}

export interface RunContractMetadata {
  mode?: RunContractMode;
  /** Execution mode controls operator oversight level. Default: 'standard'. */
  executionMode?: ExecutionMode;
  goal?: string;
  editableSurfaces: string[];
  ownerLayer?: string;
  workspaceRoot?: string;
  provider?: string;
  model?: string;
  toolMode?: string;
  requiredChecks: string[];
  allowedSkippedChecks: string[];
  stopConditions: string[];
  evidenceRequired: string[];
  commitBoundary?: string;
  externalEvidenceAllowed: string[];
  rawEvidenceProhibited: string[];
  /** Current durable phase. Transitions are validated against PHASE_TRANSITIONS. */
  phase?: RunPhase;
  /** Previous phase (for audit trail). */
  previousPhase?: RunPhase;
  /** Timestamp of the last phase transition (ISO-8601). */
  phaseChangedAt?: string;
  /** Structured plan steps. Distinct from verification requirements. */
  plan?: PlanStep[];
  /** Verification requirements mapped from plan steps that are executable. */
  verifications?: VerificationRequirement[];
  /** Plan revision number. Starts at 1. Incremented on each plan revision. */
  planRevision?: number;
  /** Run spec id of the parent plan (for revision lineage). */
  planParentRunSpecId?: string;
  /**
   * Context files to inject into the agent session, keyed by phase.
   * Each entry maps a repo-relative file path to the reason it's relevant
   * and which phase(s) should receive it.
   *
   * Pattern inspired by Trellis's implement.jsonl / check.jsonl context injection.
   */
  contextFiles?: ContextFileEntry[];
  /** Lifecycle hooks for task automation */
  hooks?: TaskLifecycleHooks;
  /** If false, skip post-execution goal self-check. Defaults true when goal or stopConditions are set. */
  selfCheckEnabled?: boolean;
  /** Result of the last post-execution goal self-check (persisted for audit). */
  selfCheckResult?: Record<string, unknown>;
}

/**
 * A file to inject into the agent's context during a specific workflow phase.
 */
export interface ContextFileEntry {
  /** Repo-relative path (e.g., 'docs/adr/0007-provider-loop.md') */
  path: string;
  /** Why this file is relevant to the task */
  reason: string;
  /** Which phase(s) should receive this file. If omitted, all phases. */
  phases?: RunPhase[];
}

/**
 * Validate a phase transition. Returns `null` if legal, or an error message if
 * the transition is not allowed.
 */
export function validatePhaseTransition(
  from: RunPhase | undefined,
  to: RunPhase,
): string | null {
  if (TERMINAL_PHASES.has(from as RunPhase)) {
    return `Cannot transition from terminal phase '${from}' to '${to}'`;
  }
  const allowed = PHASE_TRANSITIONS.get(from ?? 'created');
  if (!allowed || !allowed.has(to)) {
    return `Illegal phase transition: '${from ?? 'created'}' → '${to}'`;
  }
  return null;
}

/**
 * Check whether execution may start given the current run contract phase.
 * Execution requires `phase = 'plan_approved'` (or no contract with
 * requirePlan = false), unless the execution mode allows auto-approval.
 *
 * Lightweight mode skips the plan_approved human gate entirely —
 * the agent proceeds from planning directly to execution.
 */
export function canStartExecution(contract: RunContractMetadata | undefined): { allowed: boolean; reason?: string } {
  if (!contract || !contract.phase) return { allowed: true };
  if (contract.phase === 'plan_approved' || contract.phase === 'executing') return { allowed: true };
  // Lightweight mode: skip plan_approved gate
  if (contract.phase === 'planning' && shouldSkipPlanApprovalGate(contract)) {
    return { allowed: true };
  }
  return {
    allowed: false,
    reason: `Run is in phase '${contract.phase}'. Execution requires 'plan_approved'.`,
  };
}

/**
 * Whether the execution mode allows skipping the plan_approved human gate.
 * Lightweight mode skips it; standard and heavyweight do not.
 */
export function shouldSkipPlanApprovalGate(contract?: RunContractMetadata): boolean {
  const mode = (contract?.executionMode ?? 'standard') as ExecutionMode;
  return AUTO_APPROVE_MODES.has(mode);
}

/**
 * Whether the execution mode requires heightened operator scrutiny.
 * Heavyweight mode triggers operator_attention when confidence < threshold
 * on any phase transition.
 */
export function isHeavyweightMode(contract?: RunContractMetadata): boolean {
  return (contract?.executionMode ?? 'standard') === 'heavyweight';
}

/**
 * Check whether a run may be marked succeeded given its verification state.
 */
export function canMarkSucceeded(
  contract: RunContractMetadata | undefined,
  verificationStatuses: Array<{ requirementId: string; status: string }>,
): { allowed: boolean; reason?: string } {
  const required = contract?.verifications ?? [];
  if (required.length === 0) return { allowed: true };

  const pending = required.filter(
    (r) => !verificationStatuses.some(
      (s) => s.requirementId === r.id && (s.status === 'succeeded' || s.status === 'skipped'),
    ),
  );

  if (pending.length > 0) {
    return {
      allowed: false,
      reason: `${pending.length} verification(s) still pending or failed: ${pending.map((p) => p.id).join(', ')}`,
    };
  }
  return { allowed: true };
}

/**
 * Validate that run_spec.status and run_contract.phase are consistent.
 *
 * Two independent state machines govern the same run entity. This function
 * checks invariants that prevent silent drift between them:
 *   - Terminal run_spec status requires a compatible (terminal or absent) phase.
 *   - Terminal phase requires a compatible (terminal) run_spec status.
 *
 * Returns null if consistent, or an error string describing the inconsistency.
 */
export function validatePhaseStatusConsistency(
  runSpecStatus: string | undefined,
  contract: RunContractMetadata | undefined,
): string | null {
  const phase = contract?.phase;
  if (!phase) return null;

  const terminalStatuses = new Set(['succeeded', 'failed', 'cancelled']);
  const terminalPhases = new Set(['succeeded', 'failed']);
  const statusIsTerminal = runSpecStatus ? terminalStatuses.has(runSpecStatus) : false;
  const phaseIsTerminal = terminalPhases.has(phase);

  // If phase is terminal but status isn't, that's a drift
  if (phaseIsTerminal && !statusIsTerminal) {
    return `run_contract.phase is '${phase}' but run_spec.status is '${runSpecStatus ?? 'unknown'}' (expected terminal)`;
  }

  // If status is succeeded but phase says we never left executing, that's a drift
  if (runSpecStatus === 'succeeded' && !phaseIsTerminal && phase !== 'verifying') {
    return `run_spec.status is 'succeeded' but run_contract.phase is '${phase}' (expected 'succeeded', 'failed', or 'verifying')`;
  }

  // If status is running but phase is a pre-execution state, that's suspicious
  if (runSpecStatus === 'running' && ['created', 'discovering', 'discovery_ready', 'planning'].includes(phase)) {
    return `run_spec.status is 'running' but run_contract.phase is '${phase}' (expected 'plan_approved' or later)`;
  }

  return null;
}

export type RunContractMetadataInput = Partial<{
  mode: unknown;
  goal: unknown;
  editableSurfaces: unknown;
  ownerLayer: unknown;
  workspaceRoot: unknown;
  provider: unknown;
  model: unknown;
  toolMode: unknown;
  requiredChecks: unknown;
  allowedSkippedChecks: unknown;
  stopConditions: unknown;
  evidenceRequired: unknown;
  commitBoundary: unknown;
  externalEvidenceAllowed: unknown;
  rawEvidenceProhibited: unknown;
  phase: unknown;
  previousPhase: unknown;
  phaseChangedAt: unknown;
  plan: unknown;
  verifications: unknown;
  planRevision: unknown;
  planParentRunSpecId: unknown;
  contextFiles: unknown;
  hooks: unknown;
  selfCheckEnabled: unknown;
  selfCheckResult: unknown;
}>;

const ARRAY_FIELDS: Array<keyof Pick<
  RunContractMetadata,
  | 'editableSurfaces'
  | 'requiredChecks'
  | 'allowedSkippedChecks'
  | 'stopConditions'
  | 'evidenceRequired'
  | 'externalEvidenceAllowed'
  | 'rawEvidenceProhibited'
>> = [
  'editableSurfaces',
  'requiredChecks',
  'allowedSkippedChecks',
  'stopConditions',
  'evidenceRequired',
  'externalEvidenceAllowed',
  'rawEvidenceProhibited',
];

type StringField = keyof Pick<
  RunContractMetadata,
  'goal' | 'ownerLayer' | 'workspaceRoot' | 'provider' | 'model' | 'toolMode' | 'commitBoundary'
>;

export function normalizeRunContractMetadata(input: unknown): RunContractMetadata | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const raw = input as RunContractMetadataInput;
  const out: RunContractMetadata = {
    editableSurfaces: normalizeStringArray(raw.editableSurfaces),
    requiredChecks: normalizeStringArray(raw.requiredChecks),
    allowedSkippedChecks: normalizeStringArray(raw.allowedSkippedChecks),
    stopConditions: normalizeStringArray(raw.stopConditions),
    evidenceRequired: normalizeStringArray(raw.evidenceRequired),
    externalEvidenceAllowed: normalizeStringArray(raw.externalEvidenceAllowed),
    rawEvidenceProhibited: normalizeStringArray(raw.rawEvidenceProhibited),
  };

  const mode = normalizeRunContractMode(raw.mode);
  if (mode) out.mode = mode;

  const phase = normalizeRunPhase(raw.phase);
  if (phase) out.phase = phase;

  const previousPhase = normalizeRunPhase(raw.previousPhase);
  if (previousPhase) out.previousPhase = previousPhase;

  setString(out, 'phaseChangedAt' as any, raw.phaseChangedAt);
  setNumber(out, 'planRevision', raw.planRevision, 1);
  setString(out, 'planParentRunSpecId' as any, raw.planParentRunSpecId);
  setString(out, 'goal', raw.goal);
  setString(out, 'ownerLayer', raw.ownerLayer);
  setString(out, 'workspaceRoot', raw.workspaceRoot);
  setString(out, 'provider', raw.provider);
  setString(out, 'model', raw.model);
  setString(out, 'toolMode', raw.toolMode);
  setString(out, 'commitBoundary', raw.commitBoundary);

  const plan = normalizePlanSteps(raw.plan);
  if (plan) out.plan = plan;
  const verifications = normalizeVerificationRequirements(raw.verifications);
  if (verifications) out.verifications = verifications;

  const contextFiles = normalizeContextFiles(raw.contextFiles);
  if (contextFiles) out.contextFiles = contextFiles;

  const hooks = normalizeLifecycleHooks(raw.hooks);
  if (hooks) out.hooks = hooks;

  const selfCheckEnabled = normalizeBoolean(raw.selfCheckEnabled);
  if (selfCheckEnabled !== undefined) out.selfCheckEnabled = selfCheckEnabled;

  const selfCheckResult = normalizeObject(raw.selfCheckResult);
  if (selfCheckResult) out.selfCheckResult = selfCheckResult;

  if (!hasRunContractValue(out)) return undefined;
  return out;
}

export function mergeRunContractMetadata(
  metadata: Record<string, unknown> | undefined,
  runContract: unknown,
): Record<string, unknown> {
  const normalized = normalizeRunContractMetadata(runContract);
  if (!normalized) return metadata ?? {};
  return {
    ...(metadata ?? {}),
    runContract: normalized,
  };
}

export function readRunContractMetadata(metadata: Record<string, unknown>): RunContractMetadata | undefined {
  return normalizeRunContractMetadata(metadata.runContract);
}

function normalizeRunContractMode(value: unknown): RunContractMode | undefined {
  if (value === 'audit' || value === 'execution' || value === 'closeout' || value === 'governance' || value === 'feed-analysis-ingress') return value;
  return undefined;
}

function setString(target: RunContractMetadata, key: StringField, value: unknown): void {
  const normalized = normalizeString(value);
  if (normalized) target[key] = normalized;
}

function setNumber(target: RunContractMetadata, key: 'planRevision', value: unknown, _fallback: number): void {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    target[key] = Math.max(1, Math.floor(value));
  } else if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) target[key] = Math.max(1, Math.floor(parsed));
  }
}

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}

function normalizeObject(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  return undefined;
}

function normalizeStringArray(value: unknown): string[] {
  const raw = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(',')
      : [];
  return [...new Set(raw.map(normalizeString).filter((item): item is string => Boolean(item)))];
}

function hasRunContractValue(contract: RunContractMetadata): boolean {
  if (contract.mode || contract.goal || contract.ownerLayer || contract.workspaceRoot || contract.provider || contract.model || contract.toolMode || contract.commitBoundary) return true;
  if (contract.phase) return true;
  if (contract.plan && contract.plan.length > 0) return true;
  if (contract.verifications && contract.verifications.length > 0) return true;
  if (contract.contextFiles && contract.contextFiles.length > 0) return true;
  if (contract.hooks && (contract.hooks.afterCreate || contract.hooks.afterStart || contract.hooks.afterFinish || contract.hooks.afterArchive)) return true;
  if (contract.selfCheckEnabled !== undefined) return true;
  if (contract.selfCheckResult) return true;
  return ARRAY_FIELDS.some((field) => contract[field].length > 0);
}

function normalizeRunPhase(value: unknown): RunPhase | undefined {
  if (typeof value !== 'string') return undefined;
  const phases: RunPhase[] = ['created', 'discovering', 'discovery_ready', 'planning', 'plan_approved', 'executing', 'verifying', 'succeeded', 'blocked', 'failed'];
  return phases.includes(value as RunPhase) ? (value as RunPhase) : undefined;
}

function normalizePlanSteps(value: unknown): PlanStep[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const steps: PlanStep[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const raw = item as Record<string, unknown>;
    const id = normalizeString(raw.id) ?? `step-${steps.length + 1}`;
    steps.push({
      id,
      title: normalizeString(raw.title) ?? id,
      description: normalizeString(raw.description) ?? '',
      dependsOnIds: normalizeStringArray(raw.dependsOnIds ?? raw.depends_on_ids),
      editableSurfaces: normalizeStringArray(raw.editableSurfaces ?? raw.editable_surfaces),
      completionCriteria: normalizeString(raw.completionCriteria ?? raw.completion_criteria) ?? '',
    });
  }
  return steps.length > 0 ? steps : undefined;
}

function normalizeVerificationRequirements(value: unknown): VerificationRequirement[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const reqs: VerificationRequirement[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const raw = item as Record<string, unknown>;
    const kind = normalizeString(raw.kind);
    if (kind !== 'command' && kind !== 'assertion' && kind !== 'operator_review') continue;
    reqs.push({
      id: normalizeString(raw.id) ?? `vrf-${reqs.length + 1}`,
      kind,
      description: normalizeString(raw.description) ?? '',
      command: normalizeString(raw.command),
      assertion: normalizeString(raw.assertion),
      reviewer: normalizeString(raw.reviewer),
    });
  }
  return reqs.length > 0 ? reqs : undefined;
}

function normalizeContextFiles(value: unknown): ContextFileEntry[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const entries: ContextFileEntry[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const raw = item as Record<string, unknown>;
    const path = normalizeString(raw.path);
    if (!path) continue;
    const reason = normalizeString(raw.reason) ?? 'no reason provided';
    const phases = normalizeContextFilePhases(raw.phases);
    entries.push({ path, reason, phases });
  }
  return entries.length > 0 ? entries : undefined;
}

function normalizeContextFilePhases(value: unknown): RunPhase[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const phases: RunPhase[] = [];
  const valid = new Set<RunPhase>(['created', 'discovering', 'discovery_ready', 'planning', 'plan_approved', 'executing', 'verifying', 'succeeded', 'blocked', 'failed']);
  for (const item of value) {
    if (typeof item === 'string' && valid.has(item as RunPhase)) {
      phases.push(item as RunPhase);
    }
  }
  return phases.length > 0 ? phases : undefined;
}

/**
 * Filter context file entries for a specific phase.
 * Entries without a `phases` filter apply to all phases.
 */
export function filterContextFilesForPhase(
  entries: ContextFileEntry[] | undefined,
  phase: RunPhase,
): ContextFileEntry[] {
  if (!entries || entries.length === 0) return [];
  return entries.filter(entry => !entry.phases || entry.phases.includes(phase));
}

function normalizeLifecycleHooks(value: unknown): TaskLifecycleHooks | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const hooks: TaskLifecycleHooks = {};
  const keys: Array<keyof TaskLifecycleHooks> = ['afterCreate', 'afterStart', 'afterFinish', 'afterArchive'];
  for (const key of keys) {
    const commands = normalizeStringArray(raw[key]);
    if (commands.length > 0) hooks[key] = commands;
  }
  return (hooks.afterCreate || hooks.afterStart || hooks.afterFinish || hooks.afterArchive) ? hooks : undefined;
}
