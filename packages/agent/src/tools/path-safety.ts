import { isAbsolute, relative, resolve } from 'node:path';

export function safeWorkspacePath(workspaceRoot: string, userPath: string): string {
  // path.resolve handles absolute paths natively: /foo → /foo (not workspaceRoot/foo).
  // Only resolve relative paths against workspaceRoot.
  const resolved = resolve(workspaceRoot, userPath);
  // Security: reject paths that resolve outside the workspace boundary.
  // path.relative returns a path starting with ".." when resolved is outside workspaceRoot.
  const rel = relative(workspaceRoot, resolved);
  if (rel.startsWith('..')) {
    throw new Error(`Path traversal denied: ${userPath}`);
  }
  return resolved;
}
