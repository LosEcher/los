/**
 * @los/agent/tools/edit-ast-helpers — AST/grep helpers for edit tools.
 *
 * Extracted from edit-tools.ts to keep both files under 400 lines.
 */

import { tsx, jsx, type SgNode } from '@ast-grep/napi';

// ── Constants ─────────────────────────────────────────────

export const DELETE_SYMBOL_KINDS: Record<string, string> = {
  function: 'function_declaration',
  class: 'class_declaration',
  method: 'method_definition',
  interface: 'interface_declaration',
  type: 'type_alias_declaration',
};

export const LANG_EXTS: Record<string, 'ts' | 'tsx' | 'js' | 'jsx'> = {
  '.ts': 'ts', '.tsx': 'tsx', '.js': 'js', '.jsx': 'jsx',
  '.mjs': 'js', '.cjs': 'js', '.mts': 'ts', '.cts': 'ts',
};

// ── Types ─────────────────────────────────────────────────

export interface CandidateNode { node: SgNode }

// ── AST Search ────────────────────────────────────────────

export function findSymbolNodes(
  root: SgNode,
  name: string,
  kindFilter: string | null,
  parentFilter: string | null,
): CandidateNode[] {
  const candidates: CandidateNode[] = [];

  const kindNames = kindFilter
    ? [DELETE_SYMBOL_KINDS[kindFilter]].filter(Boolean)
    : Object.values(DELETE_SYMBOL_KINDS);

  for (const astKind of kindNames) {
    try {
      const nodes = root.findAll({ rule: { kind: astKind } });
      for (const node of nodes) {
        const nameNode = node.find({ rule: { kind: 'identifier' } })
          ?? node.find({ rule: { kind: 'property_identifier' } });
        if (!nameNode || nameNode.text() !== name) continue;

        // Check parent filter
        if (parentFilter) {
          const actualParent = findParentName(node);
          if (actualParent !== parentFilter) continue;
        }

        candidates.push({ node });
      }
    } catch { /* kind not in grammar */ }
  }

  return candidates;
}

// ── Symbol Helpers ────────────────────────────────────────

export function normalizeSymbolKind(value: string): string | null {
  return value && DELETE_SYMBOL_KINDS[value] ? value : null;
}

export function findParentName(node: SgNode): string | null {
  let current: SgNode | null = node.parent();
  while (current) {
    const k = current.kind();
    if (k === 'class_declaration' || k === 'module_declaration') {
      const id = current.find({ rule: { kind: 'identifier' } });
      if (id) return id.text();
    }
    current = current.parent();
  }
  return null;
}

// ── Whitespace ────────────────────────────────────────────

export function cleanupWhitespace(before: string, after: string): string {
  // Remove trailing whitespace from before, and leading blank lines from after
  let cleanBefore = before.replace(/\s+$/, '\n');
  let cleanAfter = after.replace(/^\n+/, '');
  // Avoid double blank lines
  if (cleanBefore.endsWith('\n\n') && cleanAfter.startsWith('\n')) {
    cleanBefore = cleanBefore.slice(0, -1);
  }
  return cleanBefore + cleanAfter;
}

// ── Language Parser ───────────────────────────────────────

/** Resolve the appropriate ast-grep language for a file extension. */
export function getLangForExt(ext: string): typeof tsx | null {
  const langKey = LANG_EXTS[ext];
  if (!langKey) return null;
  return LANG_EXTS[ext] === 'tsx' || LANG_EXTS[ext] === 'ts' ? tsx : jsx;
}
