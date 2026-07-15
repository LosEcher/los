/**
 * @los/agent/identity-loader — Agent identity resolution and prompt formatting.
 *
 * Resolves agent identity from a three-tier file system (project > user > system)
 * and formats it for system prompt injection. Mirrors the spec-loader.ts pattern.
 *
 * Identity levels:
 *   - none:     No identity injected (empty string)
 *   - minimal:  Role label only ("You are a [role].")
 *   - standard: Name + role + style + values + heartbeat
 *   - full:     Standard + backstory narrative (Phase 3)
 *
 * Resolution order:
 *   1. Project-level: .los/identity/<name>/IDENTITY.md, SOUL.md
 *   2. User-level:    ~/.los/identity/<name>/IDENTITY.md, SOUL.md
 *   3. System-level:  /etc/los/identity/<name>/IDENTITY.md, SOUL.md
 *   4. Built-in default (hardcoded in this module)
 */

import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

// ── Types ──────────────────────────────────────────────────

export type IdentityLevel = 'none' | 'minimal' | 'standard' | 'full';

export type AgentIdentityExecutionPath =
  | 'gateway-chat'
  | 'child-spawned'
  | 'remote-executor'
  | 'scheduler-graph'
  | 'scheduler-verifier'
  | 'self-check-judge'
  | 'pre-execution-phase';

const IDENTITY_LEVEL_BY_EXECUTION_PATH: Readonly<Record<AgentIdentityExecutionPath, IdentityLevel>> = {
  'gateway-chat': 'standard',
  'child-spawned': 'minimal',
  'remote-executor': 'minimal',
  'scheduler-graph': 'standard',
  'scheduler-verifier': 'none',
  'self-check-judge': 'none',
  'pre-execution-phase': 'minimal',
};

export interface AgentIdentity {
  name: string;
  role: string;
  style: string;
  pronouns?: string;
  signature?: string;
  /** SOUL.md values */
  values?: string[];
  temperament?: string;
  boundaries?: string[];
  heartbeat?: string;
  /** SOUL.md raw content for full-level backstory */
  soulContent?: string;
  /** Resolved identity level */
  level: IdentityLevel;
  /** Which sources were resolved */
  resolvedFrom: IdentityResolveSource[];
}

export interface IdentityResolveSource {
  layer: 'system' | 'user' | 'project';
  resolvedName: string;
  found: boolean;
}

interface ParsedIdentityFile {
  name?: string;
  role?: string;
  style?: string;
  pronouns?: string;
  signature?: string;
  rawContent?: string;
}

interface ParsedSoulFile {
  values?: string[];
  temperament?: string;
  boundaries?: string[];
  heartbeat?: string;
  rawContent?: string;
}

// ── Built-in Default Identities ────────────────────────────

const BUILTIN_IDENTITY: ParsedIdentityFile = {
  name: 'los',
  role: 'Agent Execution Platform Operator',
  style: 'direct, evidence-based, precise',
  signature: '— los',
};

const BUILTIN_SOUL: ParsedSoulFile = {
  values: ['precision', 'honesty', 'curiosity', 'restraint'],
  temperament: 'calm, systematic',
  boundaries: [
    'Never execute without operator consent gate',
    'Never claim verification without evidence',
    'Always admit uncertainty',
  ],
  heartbeat: 'Every action leaves an audit trail.',
};

const BUILTIN_CHILD_IDENTITY: ParsedIdentityFile = {
  name: 'los-child',
  role: 'los child agent',
  style: 'focused, concise, single-purpose',
};

const BUILTIN_CHILD_SOUL: ParsedSoulFile = {
  values: ['focus', 'conciseness', 'accuracy'],
  temperament: 'efficient, task-oriented',
  boundaries: [
    'Focus only on the assigned task',
    'Report findings concisely — do not narrate',
    'Do not spawn further agents',
  ],
};

/** Select the right built-in identity based on agent name. */
function getBuiltinIdentity(agentName: string): ParsedIdentityFile {
  if (agentName === 'child') return BUILTIN_CHILD_IDENTITY;
  return BUILTIN_IDENTITY;
}

function getBuiltinSoul(agentName: string): ParsedSoulFile {
  if (agentName === 'child') return BUILTIN_CHILD_SOUL;
  return BUILTIN_SOUL;
}

// ── Frontmatter Parsing ────────────────────────────────────

/**
 * Parse YAML-like frontmatter from a markdown file.
 * Supports simple key: value and key: [array] syntax (enough for identity files).
 * Does NOT handle nested objects or complex YAML — identity frontmatter is flat.
 */
function parseSimpleFrontmatter(content: string): Record<string, unknown> {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return {};

  const result: Record<string, unknown> = {};
  const lines = fmMatch[1].split('\n');
  let currentArrayKey: string | null = null;
  let currentArray: string[] = [];

  for (const line of lines) {
    // Array continuation: "  - value"
    if (currentArrayKey && line.match(/^\s+-\s+(.+)/)) {
      currentArray.push(line.match(/^\s+-\s+(.+)/)![1].trim());
      continue;
    }
    // Flush previous array
    if (currentArrayKey && currentArray.length > 0) {
      result[currentArrayKey] = currentArray;
      currentArrayKey = null;
      currentArray = [];
    }

    // Key: value
    const kvMatch = line.match(/^(\w[\w\s]*?):\s*(.+)/);
    if (kvMatch) {
      const key = kvMatch[1].trim();
      const rawValue = kvMatch[2].trim();

      // Array start: "key: [item1, item2]"
      if (rawValue.startsWith('[') && rawValue.endsWith(']')) {
        const inner = rawValue.slice(1, -1);
        result[key] = inner.split(',').map(s => s.trim()).filter(Boolean);
      } else {
        result[key] = rawValue;
      }
      continue;
    }

    // Array marker: "key:"
    const arrMatch = line.match(/^(\w[\w\s]*?):\s*$/);
    if (arrMatch) {
      currentArrayKey = arrMatch[1].trim();
      currentArray = [];
    }
  }
  // Flush final array
  if (currentArrayKey && currentArray.length > 0) {
    result[currentArrayKey] = currentArray;
  }

  return result;
}

/** Get the body content after frontmatter. */
function bodyAfterFrontmatter(content: string): string {
  const fmMatch = content.match(/^---\n[\s\S]*?\n---\n*/);
  if (!fmMatch) return content;
  return content.slice(fmMatch[0].length).trim();
}

// ── File Loading ───────────────────────────────────────────

function parseIdentityFile(content: string): ParsedIdentityFile {
  const fm = parseSimpleFrontmatter(content);
  return {
    name: typeof fm.name === 'string' ? fm.name : undefined,
    role: typeof fm.role === 'string' ? fm.role : undefined,
    style: typeof fm.style === 'string' ? fm.style : undefined,
    pronouns: typeof fm.pronouns === 'string' ? fm.pronouns : undefined,
    signature: typeof fm.signature === 'string' ? fm.signature : undefined,
    rawContent: bodyAfterFrontmatter(content) || undefined,
  };
}

function parseSoulFile(content: string): ParsedSoulFile {
  const fm = parseSimpleFrontmatter(content);
  const valuesRaw = fm.values;
  const boundariesRaw = fm.boundaries;
  return {
    values: Array.isArray(valuesRaw) ? valuesRaw.map(String) : undefined,
    temperament: typeof fm.temperament === 'string' ? fm.temperament : undefined,
    boundaries: Array.isArray(boundariesRaw) ? boundariesRaw.map(String) : undefined,
    heartbeat: typeof fm.heartbeat === 'string' ? fm.heartbeat : undefined,
    rawContent: bodyAfterFrontmatter(content) || undefined,
  };
}

function loadIdentityFromDir(dir: string): { identity: ParsedIdentityFile | null; soul: ParsedSoulFile | null } {
  const identityPath = join(dir, 'IDENTITY.md');
  const soulPath = join(dir, 'SOUL.md');

  let identity: ParsedIdentityFile | null = null;
  let soul: ParsedSoulFile | null = null;

  if (existsSync(identityPath)) {
    try {
      identity = parseIdentityFile(readFileSync(identityPath, 'utf8'));
    } catch { /* best-effort */ }
  }

  if (existsSync(soulPath)) {
    try {
      soul = parseSoulFile(readFileSync(soulPath, 'utf8'));
    } catch { /* best-effort */ }
  }

  return { identity, soul };
}

// ── Resolution ─────────────────────────────────────────────

/**
 * Resolve agent identity by name.
 *
 * Resolution order:
 *   1. Project-level: <workspaceRoot>/.los/identity/<name>/
 *   2. User-level:    ~/.los/identity/<name>/
 *   3. System-level:  /etc/los/identity/<name>/
 *   4. Built-in default (hardcoded)
 *
 * Each layer partially overrides — a project IDENTITY.md that only sets `style`
 * will inherit `name`, `role`, etc. from lower layers.
 */
export function resolveAgentIdentity(
  agentName: string,
  workspaceRoot: string,
  options?: { level?: IdentityLevel },
): AgentIdentity {
  const resolvedFrom: IdentityResolveSource[] = [];
  const identityDir = agentName === 'default' ? 'default' : agentName;

  // Layer 3: System-level (/etc/los/identity/<name>/)
  const systemDir = join('/etc/los/identity', identityDir);
  const systemLoaded = loadIdentityFromDir(systemDir);
  resolvedFrom.push({
    layer: 'system',
    resolvedName: identityDir,
    found: systemLoaded.identity !== null || systemLoaded.soul !== null,
  });

  // Layer 2: User-level (~/.los/identity/<name>/)
  const userDir = join(homedir(), '.los', 'identity', identityDir);
  const userLoaded = loadIdentityFromDir(userDir);
  resolvedFrom.push({
    layer: 'user',
    resolvedName: identityDir,
    found: userLoaded.identity !== null || userLoaded.soul !== null,
  });

  // Layer 1: Project-level (<workspaceRoot>/.los/identity/<name>/)
  const projectDir = join(workspaceRoot, '.los', 'identity', identityDir);
  const projectLoaded = loadIdentityFromDir(projectDir);
  resolvedFrom.push({
    layer: 'project',
    resolvedName: identityDir,
    found: projectLoaded.identity !== null || projectLoaded.soul !== null,
  });

  // Merge: lower layers provide defaults, higher layers override
  // Chain: built-in → system → user → project (final override)
  const idSources: (ParsedIdentityFile | null)[] = [
    getBuiltinIdentity(agentName),
    systemLoaded.identity,
    userLoaded.identity,
    projectLoaded.identity,
  ];
  const soulSources: (ParsedSoulFile | null)[] = [
    getBuiltinSoul(agentName),
    systemLoaded.soul,
    userLoaded.soul,
    projectLoaded.soul,
  ];

  // Merge identity fields (last non-null wins per field)
  const mergedIdentity = mergeIdentityFiles(idSources);
  const mergedSoul = mergeSoulFiles(soulSources);

  const level = options?.level ?? 'standard';

  return {
    name: mergedIdentity.name ?? 'los',
    role: mergedIdentity.role ?? 'Agent Execution Platform Operator',
    style: mergedIdentity.style ?? 'direct, evidence-based, precise',
    pronouns: mergedIdentity.pronouns,
    signature: mergedIdentity.signature,
    values: mergedSoul.values,
    temperament: mergedSoul.temperament,
    boundaries: mergedSoul.boundaries,
    heartbeat: mergedSoul.heartbeat,
    soulContent: mergedSoul.rawContent,
    level,
    resolvedFrom,
  };
}

function mergeIdentityFiles(sources: (ParsedIdentityFile | null)[]): ParsedIdentityFile {
  const result: ParsedIdentityFile = {};
  for (const src of sources) {
    if (!src) continue;
    if (src.name !== undefined) result.name = src.name;
    if (src.role !== undefined) result.role = src.role;
    if (src.style !== undefined) result.style = src.style;
    if (src.pronouns !== undefined) result.pronouns = src.pronouns;
    if (src.signature !== undefined) result.signature = src.signature;
    if (src.rawContent !== undefined) result.rawContent = src.rawContent;
  }
  return result;
}

function mergeSoulFiles(sources: (ParsedSoulFile | null)[]): ParsedSoulFile {
  const result: ParsedSoulFile = {};
  for (const src of sources) {
    if (!src) continue;
    if (src.values !== undefined) result.values = src.values;
    if (src.temperament !== undefined) result.temperament = src.temperament;
    if (src.boundaries !== undefined) result.boundaries = src.boundaries;
    if (src.heartbeat !== undefined) result.heartbeat = src.heartbeat;
    if (src.rawContent !== undefined) result.rawContent = src.rawContent;
  }
  return result;
}

export function resolveEffectiveIdentityLevel(
  configLevel: IdentityLevel | undefined,
  defaultLevel: IdentityLevel,
): IdentityLevel {
  return configLevel ?? defaultLevel;
}

export function resolveIdentityLevelForExecutionPath(
  path: AgentIdentityExecutionPath,
): IdentityLevel {
  return IDENTITY_LEVEL_BY_EXECUTION_PATH[path];
}

// ── Prompt Formatting ──────────────────────────────────────

/**
 * Format an AgentIdentity as a system prompt block.
 *
 * @param identity — resolved identity
 * @param level — effective level (overrides identity.level for this call)
 * @returns prompt block string (empty string for 'none' level)
 */
export function formatIdentityForPrompt(
  identity: AgentIdentity,
  level?: IdentityLevel,
): string {
  const effectiveLevel = level ?? identity.level ?? 'standard';

  if (effectiveLevel === 'none') return '';

  if (effectiveLevel === 'minimal') {
    return `You are ${identity.role}.${identity.signature ? ` ${identity.signature}` : ''}`;
  }

  // Standard and Full share the core block structure
  const lines: string[] = [
    `## Identity: ${identity.name}`,
    '',
  ];

  if (identity.role) {
    lines.push(`**Role**: ${identity.role}`);
  }
  if (identity.style) {
    lines.push(`**Style**: ${identity.style}`);
  }

  if (identity.values && identity.values.length > 0) {
    lines.push(`**Values**: ${identity.values.join(', ')}`);
  }

  if (identity.temperament) {
    lines.push(`**Temperament**: ${identity.temperament}`);
  }

  if (identity.boundaries && identity.boundaries.length > 0) {
    lines.push('');
    lines.push('**Boundaries**:');
    for (const b of identity.boundaries) {
      lines.push(`- ${b}`);
    }
  }

  if (identity.heartbeat) {
    lines.push('');
    lines.push(`> ${identity.heartbeat}`);
  }

  // Full level: include SOUL.md body as backstory
  if (effectiveLevel === 'full' && identity.soulContent) {
    lines.push('');
    lines.push('## Background');
    lines.push('');
    lines.push(identity.soulContent);
  }

  return lines.join('\n');
}
