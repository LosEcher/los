/**
 * Spec loader — resolves and loads relevant `.los/spec/` files based on the
 * editable surfaces and packages involved in a task.
 *
 * Also covers the project-level `SKILL.md` and `docs/` governance surfaces —
 * loaded as additional governance layers alongside per-package specs.
 *
 * Pattern inspired by Trellis's context injection: per-package specs are
 * organized under `.los/spec/<package>/<layer>/index.md`. The loader maps
 * file paths (from editableSurfaces or workspace files) to spec layers,
 * then loads the matching spec content for context injection.
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, relative, dirname } from 'node:path';

export interface SpecLayer {
  /** Package name (e.g., 'agent', 'gateway', 'infra') */
  pkg: string;
  /** Layer within the package (e.g., 'loop', 'provider', 'tool') */
  layer?: string;
  /** Absolute path to the spec index.md */
  path: string;
}

export interface LoadedSpec {
  pkg: string;
  layer?: string;
  /** Relative path from workspace root (e.g., '.los/spec/agent/loop/index.md') */
  specPath: string;
  /** Full markdown content */
  content: string;
}

function defaultWorkspaceRoot(): string {
  // Resolve from LOS_DEFAULT_WORKSPACE_ROOT env var first, then fall back
  // to the build-time relative path (los monorepo root).
  if (process.env.LOS_DEFAULT_WORKSPACE_ROOT) {
    return resolve(process.env.LOS_DEFAULT_WORKSPACE_ROOT);
  }
  return resolve(import.meta.dirname ?? __dirname, '..', '..', '..');
}

/**
 * Map a source file path to the spec layer(s) it belongs to.
 *
 * Resolution rules:
 *   packages/infra/**       → {pkg: 'infra'}
 *   packages/agent/src/loop.ts, scheduler/** → {pkg: 'agent', layer: 'loop'}
 *   packages/agent/src/providers/**           → {pkg: 'agent', layer: 'provider'}
 *   packages/agent/src/tools/**               → {pkg: 'agent', layer: 'tool'}
 *   packages/agent/src/**   → {pkg: 'agent', layer: 'loop'} (default)
 *   packages/memory/**      → {pkg: 'memory'}
 *   packages/gateway/src/routes/** → {pkg: 'gateway', layer: 'route'}
 *   packages/gateway/src/** or packages/web/** → {pkg: 'gateway', layer: 'web'}
 *   packages/executor/**     → {pkg: 'executor'}
 */
export function resolveSpecLayer(filePath: string, workspaceRoot?: string): SpecLayer | null {
  const wsRoot = workspaceRoot ?? defaultWorkspaceRoot();
  const normalized = filePath.replace(/\\/g, '/');

  if (normalized.includes('packages/infra/')) {
    return { pkg: 'infra', path: specPath('infra', undefined, wsRoot) };
  }

  if (normalized.includes('packages/agent/')) {
    if (normalized.includes('/providers/') || normalized.includes('/provider')) {
      return { pkg: 'agent', layer: 'provider', path: specPath('agent', 'provider', wsRoot) };
    }
    if (normalized.includes('/tools/') || normalized.includes('/tool-')) {
      return { pkg: 'agent', layer: 'tool', path: specPath('agent', 'tool', wsRoot) };
    }
    // Default agent layer is loop (covers loop.ts, scheduler/, execution-*, run-*, task-*)
    return { pkg: 'agent', layer: 'loop', path: specPath('agent', 'loop', wsRoot) };
  }

  if (normalized.includes('packages/memory/')) {
    return { pkg: 'memory', path: specPath('memory', undefined, wsRoot) };
  }

  if (normalized.includes('packages/gateway/src/routes/')) {
    return { pkg: 'gateway', layer: 'route', path: specPath('gateway', 'route', wsRoot) };
  }
  if (normalized.includes('packages/gateway/') || normalized.includes('packages/web/')) {
    return { pkg: 'gateway', layer: 'web', path: specPath('gateway', 'web', wsRoot) };
  }

  if (normalized.includes('packages/executor/')) {
    return { pkg: 'executor', path: specPath('executor', undefined, wsRoot) };
  }

  return null;
}

/**
 * Load specs relevant to the given editable surfaces or file paths.
 *
 * Deduplicates by spec path — each spec is loaded at most once.
 * Returns specs sorted by package name for stable context injection.
 */
export function loadSpecsForFiles(filePaths: string[], workspaceRoot?: string): LoadedSpec[] {
  const wsRoot = workspaceRoot ?? defaultWorkspaceRoot();
  const seen = new Set<string>();
  const loaded: LoadedSpec[] = [];

  for (const filePath of filePaths) {
    const layer = resolveSpecLayer(filePath, wsRoot);
    if (!layer || seen.has(layer.path)) continue;
    seen.add(layer.path);

    if (!existsSync(layer.path)) continue;

    try {
      const content = readFileSync(layer.path, 'utf8');
      const relativePath = relative(wsRoot, layer.path);
      loaded.push({
        pkg: layer.pkg,
        layer: layer.layer,
        specPath: relativePath,
        content,
      });
    } catch {
      // Spec file missing or unreadable — skip gracefully
    }
  }

  loaded.sort((a, b) => a.specPath.localeCompare(b.specPath));
  return loaded;
}

/**
 * Load ALL available specs. Use for governance/audit contexts where the full
 * rule set should be available.
 */
export function loadAllSpecs(workspaceRoot?: string): LoadedSpec[] {
  const wsRoot = workspaceRoot ?? defaultWorkspaceRoot();
  const specDir = resolve(wsRoot, '.los', 'spec');
  if (!existsSync(specDir)) return [];

  const loaded: LoadedSpec[] = [];

  // Load SKILL.md governance surfaces (project-level + workspace-level)
  for (const candidate of [
    resolve(wsRoot, 'SKILL.md'),
    resolve(wsRoot, '..', 'AGENTS.md'),
  ]) {
    if (!existsSync(candidate)) continue;
    try {
      const content = readFileSync(candidate, 'utf8');
      const relPath = relative(wsRoot, candidate);
      loaded.push({
        pkg: 'governance',
        layer: relPath.replace(/\.md$/, '').replace(/[\\/]/g, '-'),
        specPath: relPath,
        content: `## Governance Surface: ${relPath}\n\n${content.slice(0, 8000)}`,
      });
    } catch { /* skip */ }
  }

  // Load ADR documents from docs/adr/ (last 5, governance-relevant)
  const adrDir = resolve(wsRoot, 'docs', 'adr');
  if (existsSync(adrDir)) {
    try {
      const adrFiles = readdirSync(adrDir)
        .filter(f => f.endsWith('.md'))
        .sort()
        .slice(-5); // latest 5 ADRs
      for (const adrFile of adrFiles) {
        const adrPath = resolve(adrDir, adrFile);
        try {
          const content = readFileSync(adrPath, 'utf8');
          loaded.push({
            pkg: 'governance',
            layer: `adr-${adrFile.replace(/\.md$/, '')}`,
            specPath: relative(wsRoot, adrPath),
            content: `## ADR: ${adrFile.replace(/^\d+-/, '').replace(/\.md$/, '')}\n\n${content.slice(0, 6000)}`,
          });
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
  }

  // Discover specs: first try the canonical los-style per-package layout,
  // then fall back to a generic flat scan for non-los projects.
  const losLayers = [
    ['infra'],
    ['agent', 'loop'],
    ['agent', 'provider'],
    ['agent', 'tool'],
    ['memory'],
    ['gateway', 'route'],
    ['gateway', 'web'],
    ['executor'],
  ];

  let foundInLosLayout = false;
  for (const parts of losLayers) {
    const path = specPath(parts[0], parts.length > 1 ? parts[1] : undefined, wsRoot);
    if (!existsSync(path)) continue;
    foundInLosLayout = true;
    try {
      loaded.push({
        pkg: parts[0],
        layer: parts.length > 1 ? parts[1] : undefined,
        specPath: relative(wsRoot, path),
        content: readFileSync(path, 'utf8'),
      });
    } catch {
      // skip
    }
  }

  // Generic fallback: if no los-style packages were found, walk .los/spec/
  // and load every .md file, mapping dir hierarchy to pkg/layer.
  if (!foundInLosLayout) {
    const discovered = walkSpecDir(specDir, wsRoot);
    loaded.push(...discovered);
  }

  return loaded;
}

/**
 * Walk a generic .los/spec/ directory and load all .md files.
 * Non-los projects use a flat or relaxed hierarchy — every subdirectory
 * is a "pkg" and every .md inside is a "layer".
 */
function walkSpecDir(specDir: string, wsRoot: string): LoadedSpec[] {
  const loaded: LoadedSpec[] = [];
  try {
    const entries = readdirSync(specDir, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = resolve(specDir, entry.name);
      if (entry.isDirectory()) {
        // Directory = pkg
        try {
          const pkgFiles = readdirSync(entryPath, { withFileTypes: true });
          for (const pf of pkgFiles) {
            if (pf.isFile() && pf.name.endsWith('.md')) {
              const p = resolve(entryPath, pf.name);
              try {
                loaded.push({
                  pkg: entry.name,
                  layer: pf.name.replace(/\.md$/, ''),
                  specPath: relative(wsRoot, p),
                  content: readFileSync(p, 'utf8'),
                });
              } catch { /* skip */ }
            }
          }
        } catch { /* skip */ }
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        // Top-level .md = overview
        try {
          loaded.push({
            pkg: 'project',
            layer: entry.name.replace(/\.md$/, ''),
            specPath: relative(wsRoot, entryPath),
            content: readFileSync(entryPath, 'utf8'),
          });
        } catch { /* skip */ }
      }
    }
  } catch { /* skip */ }
  loaded.sort((a, b) => a.specPath.localeCompare(b.specPath));
  return loaded;
}

function specPath(pkg: string, layer: string | undefined, wsRoot: string): string {
  const parts = [wsRoot, '.los', 'spec', pkg];
  if (layer) parts.push(layer);
  parts.push('index.md');
  return resolve(...parts);
}
