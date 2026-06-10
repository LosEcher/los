/**
 * Project binding store — file-based persistence at ~/.los/projects.json.
 *
 * Schema:
 * {
 *   "projects": {
 *     "project-id": {
 *       "displayName": "My Project",
 *       "workspacePath": "/absolute/path",
 *       "createdAt": "ISO",
 *       "lastUsed": "ISO"
 *     }
 *   },
 *   "defaultProjectId": "los"
 * }
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { getLogger } from '@los/infra/logger';

const log = getLogger('project-store');

export interface ProjectBinding {
  projectId: string;
  displayName: string;
  workspacePath: string;
  createdAt: string;
  lastUsed: string;
}

interface ProjectsFile {
  projects: Record<string, Omit<ProjectBinding, 'projectId'>>;
  defaultProjectId?: string;
}

const PROJECTS_DIR = join(homedir(), '.los');
const PROJECTS_PATH = join(PROJECTS_DIR, 'projects.json');

function readProjectsFile(): ProjectsFile {
  if (!existsSync(PROJECTS_PATH)) {
    return { projects: {} };
  }
  try {
    const raw = readFileSync(PROJECTS_PATH, 'utf-8');
    return JSON.parse(raw) as ProjectsFile;
  } catch (e: any) {
    log.warn(`Failed to parse projects.json: ${e.message}`);
    return { projects: {} };
  }
}

function writeProjectsFile(data: ProjectsFile): void {
  if (!existsSync(PROJECTS_DIR)) {
    mkdirSync(PROJECTS_DIR, { recursive: true });
  }
  writeFileSync(PROJECTS_PATH, JSON.stringify(data, null, 2), 'utf-8');
}

export function listProjects(): ProjectBinding[] {
  const data = readProjectsFile();
  return Object.entries(data.projects).map(([projectId, info]) => ({
    projectId,
    ...info,
  }));
}

export function getProject(projectId: string): ProjectBinding | null {
  const data = readProjectsFile();
  const entry = data.projects[projectId];
  if (!entry) return null;
  return { projectId, ...entry };
}

export function bindProject(params: {
  projectId: string;
  displayName: string;
  workspacePath: string;
}): ProjectBinding {
  const data = readProjectsFile();
  const now = new Date().toISOString();
  const existing = data.projects[params.projectId];

  const binding: Omit<ProjectBinding, 'projectId'> = {
    displayName: params.displayName,
    workspacePath: params.workspacePath,
    createdAt: existing?.createdAt ?? now,
    lastUsed: now,
  };

  data.projects[params.projectId] = binding;
  writeProjectsFile(data);

  return { projectId: params.projectId, ...binding };
}

export function unbindProject(projectId: string): boolean {
  const data = readProjectsFile();
  if (!data.projects[projectId]) return false;
  delete data.projects[projectId];
  if (data.defaultProjectId === projectId) {
    data.defaultProjectId = undefined;
  }
  writeProjectsFile(data);
  return true;
}

export function touchProject(projectId: string): boolean {
  const data = readProjectsFile();
  const entry = data.projects[projectId];
  if (!entry) return false;
  entry.lastUsed = new Date().toISOString();
  writeProjectsFile(data);
  return true;
}

export function getDefaultProjectId(): string | undefined {
  const data = readProjectsFile();
  return data.defaultProjectId;
}

export function setDefaultProjectId(projectId: string): void {
  const data = readProjectsFile();
  data.defaultProjectId = projectId;
  writeProjectsFile(data);
}

export function validateProjectPath(workspacePath: string): { valid: boolean; error?: string } {
  try {
    const stat = statSync(workspacePath);
    if (!stat.isDirectory()) {
      return { valid: false, error: 'Path exists but is not a directory' };
    }
    return { valid: true };
  } catch (e: any) {
    if (e.code === 'ENOENT') {
      return { valid: false, error: 'Directory does not exist' };
    }
    return { valid: false, error: `Cannot access path: ${e.message}` };
  }
}
