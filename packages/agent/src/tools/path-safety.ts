import { isAbsolute, relative, resolve } from 'node:path';

export function safeWorkspacePath(workspaceRoot: string, userPath: string): string {
  const resolved = resolve(workspaceRoot, userPath.replace(/^\/+/, ''));
  const rel = relative(workspaceRoot, resolved);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Path traversal denied: ${userPath}`);
  }
  return resolved;
}
