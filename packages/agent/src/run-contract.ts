export type RunContractMode = 'audit' | 'execution' | 'closeout' | 'governance';

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

export interface RunContractMetadata {
  mode?: RunContractMode;
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
 * requirePlan = false).
 */
export function canStartExecution(contract: RunContractMetadata | undefined): { allowed: boolean; reason?: string } {
  if (!contract || !contract.phase) return { allowed: true };
  if (contract.phase === 'plan_approved' || contract.phase === 'executing') return { allowed: true };
  return {
    allowed: false,
    reason: `Run is in phase '${contract.phase}'. Execution requires 'plan_approved'.`,
  };
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
  if (value === 'audit' || value === 'execution' || value === 'closeout' || value === 'governance') return value;
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
