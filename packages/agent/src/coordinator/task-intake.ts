import { isAbsolute, relative, resolve, sep } from 'node:path';

export type ProjectOwnerResolutionReason =
  | 'explicit_project'
  | 'workspace_binding'
  | 'configured_default'
  | 'unknown_explicit_project'
  | 'project_workspace_conflict'
  | 'ambiguous_workspace'
  | 'unbound_workspace'
  | 'unknown_default_project'
  | 'owner_unresolved';

export interface ProjectOwnerBinding {
  projectId: string;
  workspacePath: string;
}

export interface ResolveProjectOwnerInput {
  bindings: readonly ProjectOwnerBinding[];
  requestedProjectId?: string;
  workspaceRoot?: string;
  defaultProjectId?: string;
}

export interface ProjectOwnerResolution {
  status: 'resolved' | 'blocked';
  ownerRepo?: string;
  workspaceRoot?: string;
  reason: ProjectOwnerResolutionReason;
  blocker?: string;
}

export function resolveProjectOwner(input: ResolveProjectOwnerInput): ProjectOwnerResolution {
  const bindings = normalizeBindings(input.bindings);
  const requestedProjectId = normalizeOptionalString(input.requestedProjectId);
  const workspaceRoot = normalizeOptionalPath(input.workspaceRoot);
  const defaultProjectId = normalizeOptionalString(input.defaultProjectId);

  if (requestedProjectId) {
    const binding = bindings.find(item => item.projectId === requestedProjectId);
    if (!binding) {
      return blocked('unknown_explicit_project', `Project is not bound: ${requestedProjectId}`);
    }
    if (workspaceRoot && !isPathWithin(binding.workspacePath, workspaceRoot)) {
      return blocked(
        'project_workspace_conflict',
        `Workspace is outside the requested project: ${requestedProjectId}`,
      );
    }
    return resolved('explicit_project', binding, workspaceRoot ?? binding.workspacePath);
  }

  if (workspaceRoot) {
    const matches = bindings
      .filter(item => isPathWithin(item.workspacePath, workspaceRoot))
      .sort((left, right) => right.workspacePath.length - left.workspacePath.length);
    const binding = matches[0];
    if (!binding) {
      return blocked('unbound_workspace', `Workspace is not bound to a project: ${workspaceRoot}`);
    }
    if (matches.some(item => item.projectId !== binding.projectId
      && item.workspacePath === binding.workspacePath)) {
      return blocked('ambiguous_workspace', `Workspace has multiple project bindings: ${binding.workspacePath}`);
    }
    return resolved('workspace_binding', binding, workspaceRoot);
  }

  if (defaultProjectId) {
    const binding = bindings.find(item => item.projectId === defaultProjectId);
    if (!binding) {
      return blocked('unknown_default_project', `Default project is not bound: ${defaultProjectId}`);
    }
    return resolved('configured_default', binding, binding.workspacePath);
  }

  return blocked('owner_unresolved', 'No project or workspace ownership evidence was provided');
}

function normalizeBindings(bindings: readonly ProjectOwnerBinding[]): ProjectOwnerBinding[] {
  const normalized = new Map<string, ProjectOwnerBinding>();
  for (const binding of bindings) {
    const projectId = normalizeOptionalString(binding.projectId);
    const workspacePath = normalizeOptionalPath(binding.workspacePath);
    if (!projectId || !workspacePath) continue;
    normalized.set(projectId, { projectId, workspacePath });
  }
  return [...normalized.values()];
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

function normalizeOptionalPath(value: string | undefined): string | undefined {
  const normalized = normalizeOptionalString(value);
  return normalized ? resolve(normalized) : undefined;
}

function isPathWithin(workspacePath: string, candidatePath: string): boolean {
  const pathFromWorkspace = relative(workspacePath, candidatePath);
  return pathFromWorkspace === ''
    || (pathFromWorkspace !== '..'
      && !pathFromWorkspace.startsWith(`..${sep}`)
      && !isAbsolute(pathFromWorkspace));
}

function resolved(
  reason: ProjectOwnerResolutionReason,
  binding: ProjectOwnerBinding,
  workspaceRoot: string,
): ProjectOwnerResolution {
  return {
    status: 'resolved',
    ownerRepo: binding.projectId,
    workspaceRoot,
    reason,
  };
}

function blocked(reason: ProjectOwnerResolutionReason, blocker: string): ProjectOwnerResolution {
  return { status: 'blocked', reason, blocker };
}
