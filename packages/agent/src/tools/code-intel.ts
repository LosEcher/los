/**
 * @los/agent/tools/code-intel — AST-level code intelligence tools.
 *
 * get_symbols: outline a file's top-level + nested symbols via ast-grep.
 * find_in_code: find identifier occurrences, classified by syntactic role.
 *
 * Powered by @ast-grep/napi (Tree-sitter under the hood).
 * Supported languages: TypeScript, TSX, JavaScript, JSX.
 */

import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { tsx, ts, jsx, js, type SgNode } from '@ast-grep/napi';
import type { ToolRegistry } from './registry.js';
import { safeWorkspacePath } from './path-safety.js';
import { getLogger } from '@los/infra/logger';

const log = getLogger('agent');

// ── Types ───────────────────────────────────────────────

export interface SymbolInfo {
  name: string;
  kind: 'function' | 'class' | 'method' | 'interface' | 'type' | 'enum' | 'namespace' | 'variable';
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  parent?: string;
}

export interface CodeMatch {
  line: number;
  column: number;
  kind: 'call' | 'definition' | 'reference';
  snippet: string;
}

// ── Language Selection ──────────────────────────────────

type LangKey = 'ts' | 'tsx' | 'js' | 'jsx';

const LANG_MAP: Record<string, LangKey> = {
  '.ts': 'ts', '.tsx': 'tsx', '.js': 'js', '.jsx': 'jsx',
  '.mjs': 'js', '.cjs': 'js', '.mts': 'ts', '.cts': 'ts',
};

// Lang objects from ast-grep (they're Lang instances, not functions)
const LANGS: Record<LangKey, { parse: (src: string) => { root: () => SgNode } }> = { ts, tsx, js, jsx };

function getLang(filePath: string): LangKey | null {
  return LANG_MAP[extname(filePath).toLowerCase()] ?? null;
}

function parseSource(filePath: string, langKey: LangKey): SgNode {
  const content = readFileSync(filePath, 'utf-8');
  const lang = LANGS[langKey];
  return lang.parse(content).root();
}

// ── get_symbols ─────────────────────────────────────────

const SYMBOL_KINDS: Record<string, SymbolInfo['kind']> = {
  function_declaration: 'function',
  generator_function_declaration: 'function',
  class_declaration: 'class',
  method_definition: 'method',
  interface_declaration: 'interface',
  type_alias_declaration: 'type',
  enum_declaration: 'enum',
  module_declaration: 'namespace',
};

const DECLARATION_KINDS = new Set(Object.keys(SYMBOL_KINDS));

export function registerGetSymbolsTool(
  registry: ToolRegistry,
  options: { workspaceRoot: string },
): void {
  registry.register('get_symbols', async (rawArgs) => {
    const args = rawArgs as Record<string, unknown>;
    const filePath = safeWorkspacePath(options.workspaceRoot, String(args.path ?? ''));

    const langKey = getLang(filePath);
    if (!langKey) {
      return { content: '', error: `Unsupported file type: ${extname(filePath)}. Supported: .ts, .tsx, .js, .jsx` };
    }

    let root: SgNode;
    try {
      root = parseSource(filePath, langKey);
    } catch (err: any) {
      return { content: '', error: `Cannot parse file: ${err?.message ?? String(err)}` };
    }

    const symbols = extractSymbols(root);
    return { content: JSON.stringify({ path: filePath, symbols }, null, 2) };
  }, {
    type: 'function',
    function: {
      name: 'get_symbols',
      description:
        'Outline a single file via AST — returns its top-level + nested symbols ' +
        '(functions, classes, methods, interfaces, types, enums, namespaces) with 1-based line/column. ' +
        'Grammar-aware, ignores names inside comments/strings. ' +
        'Supported: .ts, .tsx, .js, .jsx.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'File path relative to workspace.' } },
        required: ['path'],
      },
    },
  }, {
    riskLevel: 'L0', permissions: ['workspace:read'], timeoutMs: 30_000,
    retryable: true, idempotent: true, costLevel: 'low', sideEffect: false, tags: ['ast', 'read'],
  });
}

function extractSymbols(root: SgNode): SymbolInfo[] {
  const symbols: SymbolInfo[] = [];

  // Find all declaration nodes by kind
  for (const kind of DECLARATION_KINDS) {
    try {
      const nodes = root.findAll({ rule: { kind } });
      for (const node of nodes) {
        const info = nodeToSymbol(node, kind);
        if (info) symbols.push(info);
      }
    } catch { /* kind may not be in grammar */ }
  }

  // Top-level variable declarators
  try {
    const varNodes = root.findAll({ rule: { kind: 'variable_declarator', inside: { kind: 'program' } } });
    for (const node of varNodes) {
      const nameNode = node.find({ rule: { kind: 'identifier' } });
      if (nameNode && !isInvalidName(nameNode.text())) {
        const range = node.range();
        symbols.push({
          name: nameNode.text(), kind: 'variable',
          line: range.start.line + 1, column: range.start.column + 1,
          endLine: range.end.line + 1, endColumn: range.end.column + 1,
        });
      }
    }
  } catch { /* not available */ }

  return symbols;
}

function nodeToSymbol(node: SgNode, _kind: string): SymbolInfo | null {
  // Find the name node (identifier or property_identifier)
  let nameNode = node.find({ rule: { kind: 'identifier' } });
  if (!nameNode) nameNode = node.find({ rule: { kind: 'property_identifier' } });
  if (!nameNode) return null;

  const name = nameNode.text();
  if (isInvalidName(name)) return null;

  const nodeKind = SYMBOL_KINDS[node.kind()] ?? 'function';
  const range = node.range();
  const parent = findParentName(node);

  return {
    name, kind: nodeKind,
    line: range.start.line + 1, column: range.start.column + 1,
    endLine: range.end.line + 1, endColumn: range.end.column + 1,
    parent: parent ?? undefined,
  };
}

function findParentName(node: SgNode): string | null {
  let current: SgNode | null = node.parent();
  while (current) {
    const k = current.kind();
    if (k === 'class_declaration' || k === 'module_declaration') {
      const nameNode = current.find({ rule: { kind: 'identifier' } });
      if (nameNode) return nameNode.text();
    }
    current = current.parent();
  }
  return null;
}

function isInvalidName(name: string): boolean {
  return name.length === 0 || name === 'constructor';
}

// ── find_in_code ────────────────────────────────────────

export function registerFindInCodeTool(
  registry: ToolRegistry,
  options: { workspaceRoot: string },
): void {
  registry.register('find_in_code', async (rawArgs) => {
    const args = rawArgs as Record<string, unknown>;
    const name = String(args.name ?? '').trim();
    if (!name) return { content: '', error: 'name is required' };

    const filePath = safeWorkspacePath(options.workspaceRoot, String(args.path ?? ''));
    const langKey = getLang(filePath);
    if (!langKey) {
      return { content: '', error: `Unsupported file type: ${extname(filePath)}. Supported: .ts, .tsx, .js, .jsx` };
    }

    const kindFilter = normalizeKind(String(args.kind ?? 'any'));

    let root: SgNode;
    try {
      root = parseSource(filePath, langKey);
    } catch (err: any) {
      return { content: '', error: `Cannot parse file: ${err?.message ?? String(err)}` };
    }

    const source = readFileSync(filePath, 'utf-8');
    const matches = findIdentifierMatches(root, name, kindFilter, source);
    return { content: JSON.stringify({ path: filePath, matches }, null, 2) };
  }, {
    type: 'function',
    function: {
      name: 'find_in_code',
      description:
        'Find an identifier in a single file, AST-filtered — skips matches inside comments and strings. ' +
        'Optional kind narrows by syntactic role: call (function call site), definition (declaration name), ' +
        'reference (other uses), any (default). Within-file only. Supported: .ts, .tsx, .js, .jsx.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Exact identifier text to find.' },
          path: { type: 'string', description: 'File path relative to workspace.' },
          kind: { type: 'string', enum: ['any', 'call', 'definition', 'reference'], description: 'Filter by syntactic role. Default: any.' },
        },
        required: ['name', 'path'],
      },
    },
  }, {
    riskLevel: 'L0', permissions: ['workspace:read'], timeoutMs: 30_000,
    retryable: true, idempotent: true, costLevel: 'low', sideEffect: false, tags: ['ast', 'read'],
  });
}

function findIdentifierMatches(
  root: SgNode, name: string, kindFilter: string, source: string,
): CodeMatch[] {
  const allMatches: CodeMatch[] = [];

  // Search for regular identifiers + shorthand property identifiers
  const kinds = ['identifier', 'shorthand_property_identifier'];
  for (const astKind of kinds) {
    let nodes: SgNode[];
    try {
      nodes = root.findAll({ rule: { kind: astKind } });
    } catch { continue; }

    for (const node of nodes) {
      if (node.text() !== name) continue;
      if (isInsideCommentOrString(node)) continue;

      const range = node.range();
      const line = range.start.line;
      const snippet = getSnippet(source, line);
      const role = classifyIdentifierRole(node);

      if (kindFilter !== 'any' && role !== kindFilter) continue;

      allMatches.push({
        line: line + 1,   // 0-based → 1-based
        column: range.start.column + 1,
        kind: role,
        snippet,
      });
    }
  }

  return allMatches;
}

function classifyIdentifierRole(node: SgNode): CodeMatch['kind'] {
  const parent = node.parent();
  if (!parent) return 'reference';

  const parentKind = parent.kind();

  // Call expression: identifier is the callee (not an argument)
  if (parentKind === 'call_expression') {
    // Check if this node is within the function part
    const argsNode = parent.find({ rule: { kind: 'arguments' } });
    if (argsNode) {
      const nodeCol = node.range().start.column;
      const argsCol = argsNode.range().start.column;
      if (nodeCol < argsCol) return 'call';
    }
    return 'reference';
  }

  // Member expression property
  if (parentKind === 'member_expression') {
    const propNode = parent.find({ rule: { kind: 'property_identifier' } });
    if (propNode?.text() === node.text()) {
      const grandParent = parent.parent();
      if (grandParent?.kind() === 'call_expression') return 'call';
      return 'reference';
    }
    return 'reference';
  }

  // Definition: identifier is the name of a declaration
  if (DECLARATION_KINDS.has(String(parentKind))) return 'definition';

  // Variable declarator name
  if (parentKind === 'variable_declarator') {
    const nameNode = parent.find({ rule: { kind: 'identifier' } });
    if (nameNode?.text() === node.text()) return 'definition';
  }

  // Parameter / binding patterns
  if (parentKind === 'required_parameter' || parentKind === 'optional_parameter') {
    return 'definition';
  }

  return 'reference';
}

function isInsideCommentOrString(node: SgNode): boolean {
  let current: SgNode | null = node;
  while (current) {
    const k = current.kind();
    if (k === 'comment' || k === 'string' || k === 'string_fragment' ||
        k === 'template_string' || k === 'template_substitution') {
      return true;
    }
    current = current.parent();
  }
  return false;
}

function getSnippet(source: string, line: number): string {
  const text = source.split('\n')[line] ?? '';
  return text.trim().slice(0, 80);
}

function normalizeKind(value: string): string {
  return ['call', 'definition', 'reference'].includes(value) ? value : 'any';
}

// ── Bulk Registration ───────────────────────────────────

export function registerCodeIntelTools(
  registry: ToolRegistry,
  options: { workspaceRoot: string },
): void {
  registerGetSymbolsTool(registry, options);
  registerFindInCodeTool(registry, options);
}
