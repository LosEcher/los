/**
 * Spec loader — resolves and loads relevant `.los/spec/` files based on the
 * editable surfaces and packages involved in a task.
 *
 * Pattern inspired by Trellis's context injection: per-package specs are
 * organized under `.los/spec/<package>/<layer>/index.md`. The loader maps
 * file paths (from editableSurfaces or workspace files) to spec layers,
 * then loads the matching spec content for context injection.
 */

import { readFileSync, existsSync } from 'node:fs';
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

const WORKSPACE_ROOT = resolve(import.meta.dirname ?? __dirname, '..', '..', '..');

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
export function resolveSpecLayer(filePath: string): SpecLayer | null {
  const normalized = filePath.replace(/\\/g, '/');

  if (normalized.includes('packages/infra/')) {
    return { pkg: 'infra', path: specPath('infra') };
  }

  if (normalized.includes('packages/agent/')) {
    if (normalized.includes('/providers/') || normalized.includes('/provider')) {
      return { pkg: 'agent', layer: 'provider', path: specPath('agent', 'provider') };
    }
    if (normalized.includes('/tools/') || normalized.includes('/tool-')) {
      return { pkg: 'agent', layer: 'tool', path: specPath('agent', 'tool') };
    }
    // Default agent layer is loop (covers loop.ts, scheduler/, execution-*, run-*, task-*)
    return { pkg: 'agent', layer: 'loop', path: specPath('agent', 'loop') };
  }

  if (normalized.includes('packages/memory/')) {
    return { pkg: 'memory', path: specPath('memory') };
  }

  if (normalized.includes('packages/gateway/src/routes/')) {
    return { pkg: 'gateway', layer: 'route', path: specPath('gateway', 'route') };
  }
  if (normalized.includes('packages/gateway/') || normalized.includes('packages/web/')) {
    return { pkg: 'gateway', layer: 'web', path: specPath('gateway', 'web') };
  }

  if (normalized.includes('packages/executor/')) {
    return { pkg: 'executor', path: specPath('executor') };
  }

  return null;
}

/**
 * Load specs relevant to the given editable surfaces or file paths.
 *
 * Deduplicates by spec path — each spec is loaded at most once.
 * Returns specs sorted by package name for stable context injection.
 */
export function loadSpecsForFiles(filePaths: string[]): LoadedSpec[] {
  const seen = new Set<string>();
  const loaded: LoadedSpec[] = [];

  for (const filePath of filePaths) {
    const layer = resolveSpecLayer(filePath);
    if (!layer || seen.has(layer.path)) continue;
    seen.add(layer.path);

    if (!existsSync(layer.path)) continue;

    try {
      const content = readFileSync(layer.path, 'utf8');
      const relativePath = relative(WORKSPACE_ROOT, layer.path);
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
export function loadAllSpecs(): LoadedSpec[] {
  const specDir = resolve(WORKSPACE_ROOT, '.los', 'spec');
  if (!existsSync(specDir)) return [];

  const loaded: LoadedSpec[] = [];
  const layers = [
    ['infra'],
    ['agent', 'loop'],
    ['agent', 'provider'],
    ['agent', 'tool'],
    ['memory'],
    ['gateway', 'route'],
    ['gateway', 'web'],
    ['executor'],
  ];

  for (const parts of layers) {
    const path = specPath(...(parts as [string, ...string[]]));
    if (!existsSync(path)) continue;
    try {
      loaded.push({
        pkg: parts[0],
        layer: parts.length > 1 ? parts[1] : undefined,
        specPath: relative(WORKSPACE_ROOT, path),
        content: readFileSync(path, 'utf8'),
      });
    } catch {
      // skip
    }
  }

  return loaded;
}

function specPath(pkg: string, layer?: string): string {
  const parts = [WORKSPACE_ROOT, '.los', 'spec', pkg];
  if (layer) parts.push(layer);
  parts.push('index.md');
  return resolve(...parts);
}
