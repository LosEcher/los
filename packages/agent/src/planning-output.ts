import {
  normalizeRunContractMetadata,
  type PlanStep,
  type VerificationRequirement,
} from './run-contract.js';
import {
  validatePlanForApproval,
  validateVerificationExecutionSupport,
} from './run-plan-validation.js';

export interface PlanningOutput {
  plan: PlanStep[];
  verifications: VerificationRequirement[];
  summary?: string;
}

export function buildPlanningPrompt(goal: string): string {
  return [
    goal,
    '',
    'Planning disposition: inspect the workspace with read-only tools and return an execution plan.',
    'Do not edit files, run write commands, or execute the plan.',
    'Your final response must be one JSON object with no markdown fence:',
    '{"summary":"...","plan":[{"id":"step-1","title":"...","description":"...","dependsOnIds":[],"editableSurfaces":["path"],"completionCriteria":"..."}],"verifications":[{"id":"check-1","kind":"command","description":"...","command":"..."}]}',
    'Plan dependencies must be acyclic. Use only command verifications; operator approval will review the result before execution.',
  ].join('\n');
}

export function parsePlanningOutput(text: string): PlanningOutput {
  const raw = parseJsonObject(stripMarkdownFence(text));
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
  return {
    plan: plan!,
    verifications: normalized?.verifications ?? [],
    summary: normalizeOptionalString(raw.summary),
  };
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
