import type { PlanStep, RunContractMetadata, RunPhase } from './run-contract.js';

const REVISION_PHASES: ReadonlySet<RunPhase> = new Set(['planning', 'plan_approved', 'blocked']);

export function validatePlanForApproval(plan: PlanStep[] | undefined): string | null {
  if (!Array.isArray(plan) || plan.length === 0) {
    return 'Plan approval requires at least one structured plan step';
  }

  const ids = new Set<string>();
  for (const [index, step] of plan.entries()) {
    const prefix = `Plan step ${index + 1}`;
    if (!step || typeof step !== 'object') return `${prefix} must be an object`;
    if (typeof step.id !== 'string' || !step.id.trim()) return `${prefix} requires a non-empty id`;
    const normalizedId = step.id.trim();
    if (ids.has(normalizedId)) return `Plan step id '${normalizedId}' is duplicated`;
    ids.add(normalizedId);
    if (typeof step.title !== 'string' || !step.title.trim()) return `Plan step '${step.id}' requires a non-empty title`;
    if (typeof step.description !== 'string' || !step.description.trim()) return `Plan step '${step.id}' requires a non-empty description`;
    if (typeof step.completionCriteria !== 'string' || !step.completionCriteria.trim()) return `Plan step '${step.id}' requires non-empty completion criteria`;
    if (!Array.isArray(step.dependsOnIds) || step.dependsOnIds.some((id) => typeof id !== 'string' || !id.trim())) {
      return `Plan step '${step.id}' requires valid dependsOnIds`;
    }
    if (!Array.isArray(step.editableSurfaces) || step.editableSurfaces.some((surface) => typeof surface !== 'string' || !surface.trim())) {
      return `Plan step '${step.id}' requires valid editableSurfaces`;
    }
  }

  const dependencies = new Map(plan.map((step) => [step.id.trim(), step.dependsOnIds.map((id) => id.trim())]));
  for (const step of plan) {
    const stepId = step.id.trim();
    for (const dependencyId of step.dependsOnIds.map((id) => id.trim())) {
      if (!ids.has(dependencyId)) return `Plan step '${step.id}' depends on unknown step '${dependencyId}'`;
      if (dependencyId === stepId) return `Plan step '${step.id}' cannot depend on itself`;
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const hasCycle = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const dependencyId of dependencies.get(id) ?? []) {
      if (hasCycle(dependencyId)) return true;
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  };

  return plan.some((step) => hasCycle(step.id.trim()))
    ? 'Plan step dependencies must not contain cycles'
    : null;
}

export function normalizePlanForPersistence(plan: PlanStep[]): PlanStep[] {
  return plan.map((step) => ({
    id: step.id.trim(),
    title: step.title.trim(),
    description: step.description.trim(),
    dependsOnIds: [...new Set(step.dependsOnIds.map((id) => id.trim()))],
    editableSurfaces: [...new Set(step.editableSurfaces.map((surface) => surface.trim()))],
    completionCriteria: step.completionCriteria.trim(),
  }));
}

export function validateVerificationMappingForApproval(
  contract: Pick<RunContractMetadata, 'requiredChecks' | 'verifications'>,
): string | null {
  const requiredChecks = contract.requiredChecks.filter((check) => check.trim());
  const verifications = (contract.verifications ?? []).filter((requirement) => requirement.id.trim());
  return requiredChecks.length > 0 || verifications.length > 0
    ? null
    : 'Plan approval requires at least one required check or verification requirement';
}

export function validateVerificationExecutionSupport(
  contract: Pick<RunContractMetadata, 'verifications'>,
): string | null {
  const unsupported = contract.verifications?.find((requirement) => requirement.kind !== 'command');
  return unsupported
    ? `Verification requirement '${unsupported.id}' uses unsupported approval kind '${unsupported.kind}'`
    : null;
}

export function validatePlanRevisionPhase(phase: RunPhase | undefined): string | null {
  return phase && REVISION_PHASES.has(phase)
    ? null
    : `Plan revision is not allowed from phase '${phase ?? 'created'}'`;
}
