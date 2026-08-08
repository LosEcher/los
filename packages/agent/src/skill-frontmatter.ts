/**
 * @los/agent/skill-frontmatter — Parse skill markdown frontmatter.
 *
 * Accepts kebab-case Claude-style keys and camelCase aliases.
 * Kept out of skills.ts to stay under module-size gates.
 */

import type { SkillRunMode } from './skills.js';

export interface ParsedSkillFrontmatter {
  name: string;
  enabled: boolean;
  category?: string;
  description?: string;
  runMode?: SkillRunMode;
  content: string;
  metadata: Record<string, unknown>;
  tags?: string[];
}

const KEY_ALIASES: Record<string, string> = {
  'disable-model-invocation': 'disableModelInvocation',
  'disablemodelinvocation': 'disableModelInvocation',
  'allowed-tools': 'allowedTools',
  allowedtools: 'allowedTools',
  'user-invocable': 'userInvocable',
  userinvocable: 'userInvocable',
  'run-mode': 'runMode',
  runmode: 'runMode',
  'source-path': 'sourcePath',
  sourcepath: 'sourcePath',
};

/**
 * Parse optional YAML-like frontmatter from a skill markdown body.
 * Returns null only when a frontmatter block exists but lacks a valid name.
 * Files without frontmatter yield a synthetic name from `filename`.
 */
export function parseSkillFrontmatter(raw: string, filename: string): ParsedSkillFrontmatter | null {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) {
    const name = filename.replace(/\.md$/i, '');
    if (!name) return null;
    return { name, content: raw, metadata: {}, enabled: true };
  }

  const frontmatter = match[1]!;
  const content = match[2]!.trim();
  const metadata: Record<string, unknown> = {};
  let name = '';
  let enabled = true;
  let category: string | undefined;
  let description: string | undefined;
  let runMode: SkillRunMode | undefined;
  let tags: string[] | undefined;

  for (const line of frontmatter.split(/\r?\n/)) {
    const kv = line.match(/^([\w-]+):\s*(.*)$/);
    if (!kv) continue;
    const rawKey = kv[1]!;
    const trimmed = kv[2]!.trim();
    const key = normalizeFrontmatterKey(rawKey);

    if (key === 'name') name = trimmed;
    else if (key === 'enabled') enabled = trimmed !== 'false' && trimmed !== '0';
    else if (key === 'category') category = trimmed;
    else if (key === 'description') description = trimmed;
    else if (key === 'runMode' && (trimmed === 'auto' || trimmed === 'manual')) runMode = trimmed;
    else if (key === 'tags') tags = parseStringList(trimmed);
    else if (key === 'allowedTools') metadata.allowedTools = parseStringList(trimmed);
    else if (key === 'paths') metadata.paths = parseStringList(trimmed);
    else if (key === 'disableModelInvocation') metadata.disableModelInvocation = parseBool(trimmed);
    else if (key === 'userInvocable') metadata.userInvocable = parseBool(trimmed);
    else metadata[key] = coerceScalar(trimmed);
  }

  if (!name) return null;
  return { name, category, description, runMode, content, metadata, enabled, tags };
}

function normalizeFrontmatterKey(rawKey: string): string {
  const lower = rawKey.toLowerCase();
  if (KEY_ALIASES[lower]) return KEY_ALIASES[lower]!;
  if (KEY_ALIASES[rawKey]) return KEY_ALIASES[rawKey]!;
  // camelCase passthrough for known fields
  if (
    rawKey === 'disableModelInvocation'
    || rawKey === 'allowedTools'
    || rawKey === 'userInvocable'
    || rawKey === 'runMode'
    || rawKey === 'sourcePath'
  ) {
    return rawKey;
  }
  return rawKey;
}

function parseStringList(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (Array.isArray(parsed)) {
        return [...new Set(parsed.map(item => String(item).trim()).filter(Boolean))];
      }
    } catch {
      // fall through to CSV
    }
  }
  return [...new Set(trimmed.split(',').map(part => part.trim()).filter(Boolean))];
}

function parseBool(value: string): boolean {
  const v = value.trim().toLowerCase();
  return v === 'true' || v === '1' || v === 'yes';
}

function coerceScalar(value: string): string | boolean | number {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return value;
}
