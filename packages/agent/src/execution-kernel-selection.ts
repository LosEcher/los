export interface ExecutionKernelSelectionIdentity {
  kind: string;
  version: string;
  protocolVersion: string;
}

export type ExecutionKernelCandidateDisposition = 'planning' | 'inspection';

export interface ExecutionKernelSelectionHistoryEntry {
  action: 'selected' | 'rollback';
  from?: ExecutionKernelSelectionIdentity;
  to: ExecutionKernelSelectionIdentity;
  actor: string;
  at: string;
  reason?: string;
}

export interface ExecutionKernelSelection {
  selectionMode: 'explicit';
  experimentId: string;
  disposition: ExecutionKernelCandidateDisposition;
  requested: ExecutionKernelSelectionIdentity;
  selected: ExecutionKernelSelectionIdentity;
  rollback: {
    target: ExecutionKernelSelectionIdentity;
    status: 'available' | 'applied';
    appliedAt?: string;
    appliedBy?: string;
    reason?: string;
  };
  canaryAuthorization: {
    status: 'not_granted' | 'granted';
    grantedAt?: string;
    grantedBy?: string;
  };
  history: ExecutionKernelSelectionHistoryEntry[];
}

const LOS_KERNEL_IDENTITY: ExecutionKernelSelectionIdentity = Object.freeze({
  kind: 'los',
  version: '0.1.0',
  protocolVersion: '0.1.0',
});

const PI_K4_KERNEL_IDENTITY: ExecutionKernelSelectionIdentity = Object.freeze({
  kind: 'pi',
  version: '0.81.1+los.3',
  protocolVersion: '0.1.0',
});

export function getLosKernelSelectionIdentity(): ExecutionKernelSelectionIdentity {
  return { ...LOS_KERNEL_IDENTITY };
}

export function getPiK4KernelSelectionIdentity(): ExecutionKernelSelectionIdentity {
  return { ...PI_K4_KERNEL_IDENTITY };
}

export function createK4ExecutionKernelSelection(input: {
  experimentId: string;
  disposition: ExecutionKernelCandidateDisposition;
  actor: string;
  now?: Date;
}): ExecutionKernelSelection {
  const at = (input.now ?? new Date()).toISOString();
  return {
    selectionMode: 'explicit',
    experimentId: input.experimentId,
    disposition: input.disposition,
    requested: { ...PI_K4_KERNEL_IDENTITY },
    selected: { ...PI_K4_KERNEL_IDENTITY },
    rollback: {
      target: { ...LOS_KERNEL_IDENTITY },
      status: 'available',
    },
    canaryAuthorization: { status: 'not_granted' },
    history: [{
      action: 'selected',
      from: { ...LOS_KERNEL_IDENTITY },
      to: { ...PI_K4_KERNEL_IDENTITY },
      actor: input.actor,
      at,
    }],
  };
}

export function grantK4CanaryAuthorization(
  selection: ExecutionKernelSelection,
  actor: string,
  now = new Date(),
): ExecutionKernelSelection {
  const error = validateK4ExecutionKernelSelection(selection, { requireCanaryAuthorization: false });
  if (error) throw new Error(error);
  if (!executionKernelIdentitiesEqual(selection.selected, PI_K4_KERNEL_IDENTITY)) {
    throw new Error('Pi K4 canary authorization requires Pi to remain selected');
  }
  return {
    ...selection,
    canaryAuthorization: {
      status: 'granted',
      grantedAt: now.toISOString(),
      grantedBy: actor,
    },
  };
}

export function applyK4ExecutionKernelRollback(
  selection: ExecutionKernelSelection,
  actor: string,
  reason: string | undefined,
  now = new Date(),
): ExecutionKernelSelection {
  const error = validateK4ExecutionKernelSelection(selection, { requireCanaryAuthorization: false });
  if (error) throw new Error(error);
  if (selection.rollback.status === 'applied') return selection;
  const at = now.toISOString();
  return {
    ...selection,
    selected: { ...LOS_KERNEL_IDENTITY },
    rollback: {
      target: { ...LOS_KERNEL_IDENTITY },
      status: 'applied',
      appliedAt: at,
      appliedBy: actor,
      ...(reason ? { reason } : {}),
    },
    canaryAuthorization: { status: 'not_granted' },
    history: [...selection.history, {
      action: 'rollback',
      from: { ...selection.selected },
      to: { ...LOS_KERNEL_IDENTITY },
      actor,
      at,
      ...(reason ? { reason } : {}),
    }],
  };
}

export function normalizeExecutionKernelSelection(value: unknown): ExecutionKernelSelection | undefined {
  const raw = objectValue(value);
  if (!raw || raw.selectionMode !== 'explicit') return undefined;
  const experimentId = stringValue(raw.experimentId);
  const disposition = raw.disposition === 'planning' || raw.disposition === 'inspection'
    ? raw.disposition
    : undefined;
  const requested = normalizeIdentity(raw.requested);
  const selected = normalizeIdentity(raw.selected);
  const rollbackRaw = objectValue(raw.rollback);
  const rollbackTarget = normalizeIdentity(rollbackRaw?.target);
  const rollbackStatus = rollbackRaw?.status === 'available' || rollbackRaw?.status === 'applied'
    ? rollbackRaw.status
    : undefined;
  const authorizationRaw = objectValue(raw.canaryAuthorization);
  const authorizationStatus = authorizationRaw?.status === 'not_granted' || authorizationRaw?.status === 'granted'
    ? authorizationRaw.status
    : undefined;
  const history = normalizeHistory(raw.history);
  if (!experimentId || !disposition || !requested || !selected || !rollbackTarget || !rollbackStatus || !authorizationStatus || history.length === 0) {
    return undefined;
  }
  return {
    selectionMode: 'explicit',
    experimentId,
    disposition,
    requested,
    selected,
    rollback: {
      target: rollbackTarget,
      status: rollbackStatus,
      ...optionalStringFields(rollbackRaw, ['appliedAt', 'appliedBy', 'reason']),
    },
    canaryAuthorization: {
      status: authorizationStatus,
      ...optionalStringFields(authorizationRaw, ['grantedAt', 'grantedBy']),
    },
    history,
  };
}

export function validateK4ExecutionKernelSelection(
  selection: ExecutionKernelSelection | undefined,
  context: {
    runContractMode?: string;
    toolMode?: string;
    executorEnabled?: boolean;
    requireCanaryAuthorization: boolean;
  },
): string | null {
  if (!selection) return 'Pi K4 requires a persisted explicit execution-kernel selection';
  if (!executionKernelIdentitiesEqual(selection.requested, PI_K4_KERNEL_IDENTITY)) return 'Pi K4 requested identity is not the accepted candidate';
  if (!executionKernelIdentitiesEqual(selection.rollback.target, LOS_KERNEL_IDENTITY)) return 'Pi K4 rollback target is not the accepted LOS adapter';
  if (context.runContractMode !== undefined && context.runContractMode !== 'audit') return 'Pi K4 requires runContract.mode=audit';
  if (context.toolMode !== undefined && context.toolMode !== 'read-only') return 'Pi K4 requires toolMode=read-only';
  if (context.executorEnabled) return 'Pi K4 does not allow remote executor selection';
  const selectedPi = executionKernelIdentitiesEqual(selection.selected, PI_K4_KERNEL_IDENTITY);
  const selectedLos = executionKernelIdentitiesEqual(selection.selected, LOS_KERNEL_IDENTITY);
  if (!selectedPi && !selectedLos) return 'Pi K4 selected identity is neither the candidate nor rollback adapter';
  if (selectedPi && selection.rollback.status !== 'available') return 'Pi K4 candidate selection has an inconsistent rollback state';
  if (selectedLos && selection.rollback.status !== 'applied') return 'Pi K4 LOS selection requires an applied rollback record';
  if (selectedLos && selection.canaryAuthorization.status !== 'not_granted') return 'Pi K4 rollback must revoke canary authorization';
  if (context.requireCanaryAuthorization && selectedPi && selection.canaryAuthorization.status !== 'granted') {
    return 'Pi K4 provider canary authorization is not granted';
  }
  return null;
}

export function executionKernelIdentitiesEqual(
  left: ExecutionKernelSelectionIdentity | undefined,
  right: ExecutionKernelSelectionIdentity | undefined,
): boolean {
  return Boolean(left && right
    && left.kind === right.kind
    && left.version === right.version
    && left.protocolVersion === right.protocolVersion);
}

function normalizeIdentity(value: unknown): ExecutionKernelSelectionIdentity | undefined {
  const raw = objectValue(value);
  const kind = stringValue(raw?.kind);
  const version = stringValue(raw?.version);
  const protocolVersion = stringValue(raw?.protocolVersion);
  return kind && version && protocolVersion ? { kind, version, protocolVersion } : undefined;
}

function normalizeHistory(value: unknown): ExecutionKernelSelectionHistoryEntry[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(item => {
    const raw = objectValue(item);
    const action = raw?.action === 'selected' || raw?.action === 'rollback' ? raw.action : undefined;
    const to = normalizeIdentity(raw?.to);
    const actor = stringValue(raw?.actor);
    const at = stringValue(raw?.at);
    if (!action || !to || !actor || !at) return [];
    const from = normalizeIdentity(raw?.from);
    const reason = stringValue(raw?.reason);
    return [{ action, to, actor, at, ...(from ? { from } : {}), ...(reason ? { reason } : {}) }];
  });
}

function optionalStringFields<T extends readonly string[]>(
  raw: Record<string, unknown> | undefined,
  fields: T,
): Partial<Record<T[number], string>> {
  const result: Partial<Record<T[number], string>> = {};
  for (const field of fields) {
    const value = stringValue(raw?.[field]);
    if (value) result[field as T[number]] = value;
  }
  return result;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
