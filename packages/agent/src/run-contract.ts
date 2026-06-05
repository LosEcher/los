export type RunContractMode = 'audit' | 'execution' | 'closeout' | 'governance';

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

  setString(out, 'goal', raw.goal);
  setString(out, 'ownerLayer', raw.ownerLayer);
  setString(out, 'workspaceRoot', raw.workspaceRoot);
  setString(out, 'provider', raw.provider);
  setString(out, 'model', raw.model);
  setString(out, 'toolMode', raw.toolMode);
  setString(out, 'commitBoundary', raw.commitBoundary);

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
  return ARRAY_FIELDS.some((field) => contract[field].length > 0);
}
