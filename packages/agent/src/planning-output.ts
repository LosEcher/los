import {
  normalizeRunContractMetadata,
  type PlanStep,
  type RunContractMetadata,
  type VerificationRequirement,
} from './run-contract.js';
import {
  validatePlanForApproval,
  validatePlanScopeForApproval,
  validateVerificationExecutionSupport,
} from './run-plan-validation.js';

export interface PlanningOutput {
  plan: PlanStep[];
  verifications: VerificationRequirement[];
  summary?: string;
}

export type PlanningTransport = 'typed_tool' | 'text_json_legacy';

export const _PLANNING_SUBMISSION_TOOL_NAME = 'submit_run_contract';

export function buildPlanningPrompt(
  goal: string,
  transport: PlanningTransport = 'typed_tool',
  contract?: RunContractMetadata,
): string {
  if (transport === 'text_json_legacy') {
    return buildLegacyPlanningPrompt(goal);
  }
  return [
    goal,
    '',
    ...formatPlanningContract(contract),
    'Planning disposition: inspect the workspace with read-only tools and prepare an execution plan.',
    'Do not edit files, run write commands, or execute the plan.',
    `Submit the plan exactly once with the ${_PLANNING_SUBMISSION_TOOL_NAME} tool.`,
    'The tool accepts summary, plan steps, and command verifications only. Trusted run, task, session, actor, tenant, and project identifiers are injected by LOS and must not be included.',
    'After the tool accepts the plan, provide a short human-readable summary; do not repeat the plan as JSON.',
    'Plan dependencies must be acyclic. Use only command verifications; operator approval will review the result before execution.',
    'Treat the authoritative RunContract as the scope boundary. Do not add editable surfaces outside it, and include its required checks in the submitted verification mapping.',
  ].join('\n');
}

export function parsePlanningOutput(text: string): PlanningOutput {
  return validatePlanningOutputPayload(parseJsonObject(stripMarkdownFence(text)));
}

export function validatePlanningOutputPayload(
  input: unknown,
  contract?: RunContractMetadata,
): PlanningOutput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Invalid planning output: expected object');
  }
  // Strip NUL bytes before validation: PostgreSQL rejects \u0000 in text/jsonb,
  // and NUL in model output carries no plan meaning.
  const raw = stripNulChars(input) as Record<string, unknown>;
  const unexpectedKeys = Object.keys(raw).filter(key => !['summary', 'plan', 'verifications'].includes(key));
  if (unexpectedKeys.length > 0) {
    throw new Error(`Invalid planning output: unexpected fields ${unexpectedKeys.join(', ')}`);
  }
  const normalized = normalizeRunContractMetadata({
    plan: raw.plan,
    verifications: raw.verifications,
  });
  const plan = normalized?.plan;
  const planError = validatePlanForApproval(plan);
  if (planError) throw new Error(`Invalid planning output: ${planError}`);
  const supportError = validateVerificationExecutionSupport({
    verifications: normalized?.verifications,
  });
  if (supportError) throw new Error(`Invalid planning output: ${supportError}`);
  const scopeError = contract
    ? validatePlanScopeForApproval({ editableSurfaces: contract.editableSurfaces, plan })
    : null;
  if (scopeError) throw new Error(`Invalid planning output: ${scopeError}`);
  return {
    plan: plan!,
    verifications: normalized?.verifications ?? [],
    summary: normalizeOptionalString(raw.summary),
  };
}

function stripNulChars(value: unknown): unknown {
  if (typeof value === 'string') return value.replaceAll('\u0000', '');
  if (Array.isArray(value)) return value.map(stripNulChars);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = stripNulChars(item);
    }
    return out;
  }
  return value;
}

function formatPlanningContract(contract: RunContractMetadata | undefined): string[] {
  if (!contract) return [];
  const lines = [
    'Authoritative RunContract:',
    `- Goal: ${contract.goal ?? 'Use the user request above.'}`,
    `- Tool mode: ${contract.toolMode ?? 'read-only'}`,
    `- Editable surfaces: ${contract.editableSurfaces.length > 0 ? contract.editableSurfaces.join(', ') : '(none)'}`,
    `- Required checks: ${contract.requiredChecks.length > 0 ? contract.requiredChecks.join(' | ') : '(none)'}`,
    `- Stop conditions: ${contract.stopConditions.length > 0 ? contract.stopConditions.join(' | ') : '(none)'}`,
    '',
  ];
  return lines;
}

function buildLegacyPlanningPrompt(goal: string): string {
  return [
    goal,
    '',
    'Planning disposition: inspect the workspace with read-only tools and return an execution plan.',
    'Do not edit files, run write commands, or execute the plan.',
    'Legacy planning transport is explicitly enabled. Your final response must be one JSON object with no markdown fence:',
    '{"summary":"...","plan":[{"id":"step-1","title":"...","description":"...","dependsOnIds":[],"editableSurfaces":["path"],"completionCriteria":"..."}],"verifications":[{"id":"check-1","kind":"command","description":"...","command":"..."}]}',
    'Plan dependencies must be acyclic. Use only command verifications; operator approval will review the result before execution.',
  ].join('\n');
}

function stripMarkdownFence(value: string): string {
  const trimmed = value.trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match?.[1]?.trim() ?? trimmed;
}

function parseJsonObject(value: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`Invalid planning output: expected JSON object (${error instanceof Error ? error.message : String(error)})`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Invalid planning output: expected JSON object');
  }
  return parsed as Record<string, unknown>;
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
