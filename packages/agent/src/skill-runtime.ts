/**
 * @los/agent/skill-runtime — Select and format skills for a run.
 *
 * Placement: user-turn attachment (NOT system prompt prefix) for AP11 cache safety.
 * Manual skills first; auto only when explicitly enabled; budget truncates excess.
 */

import { getLogger } from '@los/infra/logger';
import {
  incrementSkillUsage,
  listSkills,
  type SkillRecord,
  type SkillScope,
} from './skills.js';

const log = getLogger('skill-runtime');

export interface SkillSelectionInput {
  prompt: string;
  workspaceRoot?: string;
  projectId?: string;
  tenantId?: string;
  /** Explicit skill names or scoped ids (`project:name` / `global:name`). */
  manualSkillIds?: string[];
  /** When false, skip all skill selection. Default true. */
  runtimeEnabled?: boolean;
  /** When true, also pick auto skills by description overlap. Default false. */
  autoEnabled?: boolean;
  maxAutoSkills?: number;
  maxSkillTokens?: number;
  /** Optional preloaded catalog (tests). */
  catalog?: SkillRecord[];
}

export interface SelectedSkill {
  id: string;
  name: string;
  scope: SkillScope;
  mode: 'manual' | 'auto';
  versionHash: string;
  tokenEstimate: number;
  allowedTools?: string[];
  content: string;
}

export interface SkillSelectionResult {
  selected: SelectedSkill[];
  skipped: Array<{ name: string; reason: string }>;
  /** User-turn attachment text (NOT system prefix). Empty when nothing selected. */
  userAttachment: string;
  /** Merged skill allowlist restriction; undefined = no extra restriction from skills. */
  skillAllowedTools?: string[];
  /** Prompt with leading `/skill` directives stripped. */
  cleanedPrompt: string;
  /** Prompt ready for the agent: attachment + cleaned user text. */
  effectivePrompt: string;
}

const DEFAULT_MAX_AUTO = 3;
const DEFAULT_MAX_TOKENS = 2500;

/** Advisory estimate only — ceil(utf8Bytes / 4). Same for manual + auto. */
function estimateSkillTokens(content: string): number {
  return Math.ceil(Buffer.byteLength(content, 'utf8') / 4);
}

/**
 * Parse `/skill name` or `/skill name1,name2` directives from the start of a prompt.
 * Returns remaining prompt and skill name tokens.
 */
function parseSkillDirectives(prompt: string): { cleanedPrompt: string; skillNames: string[] } {
  const names: string[] = [];
  let rest = prompt;
  // Allow multiple leading /skill lines or inline first-line directives
  const lineRe = /^\/skill(?:s)?\s+([^\n]+)\n?/i;
  let match = rest.match(lineRe);
  while (match) {
    for (const part of match[1]!.split(/[,\s]+/)) {
      const name = part.trim();
      if (name) names.push(name);
    }
    rest = rest.slice(match[0].length);
    match = rest.match(lineRe);
  }
  // Also support `/skill foo` as the entire first token of a single-line prompt
  const inline = rest.match(/^\/skill(?:s)?\s+(\S+)(?:\s+([\s\S]*))?$/i);
  if (inline && names.length === 0) {
    names.push(inline[1]!);
    rest = (inline[2] ?? '').trimStart();
  }
  return { cleanedPrompt: rest.trimStart(), skillNames: [...new Set(names)] };
}

function skillScopeOf(skill: SkillRecord): SkillScope {
  return skill.metadata?.scope === 'global' ? 'global' : 'project';
}

function skillAllowedToolsOf(skill: SkillRecord): string[] | undefined {
  const raw = skill.metadata?.allowedTools;
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const tools = raw.map(item => String(item).trim()).filter(Boolean);
  return tools.length > 0 ? tools : undefined;
}

function skillDisableModelInvocation(skill: SkillRecord): boolean {
  return skill.metadata?.disableModelInvocation === true
    || skill.metadata?.['disable-model-invocation'] === true;
}

function skillUserInvocable(skill: SkillRecord): boolean {
  if (skill.metadata?.userInvocable === false) return false;
  if (skill.metadata?.['user-invocable'] === false) return false;
  return true;
}

function skillPathsOf(skill: SkillRecord): string[] {
  const raw = skill.metadata?.paths;
  if (!Array.isArray(raw)) return [];
  return raw.map(item => String(item).trim()).filter(Boolean);
}

/**
 * Intersect session allowlist with skill-declared allowlists.
 * Empty skill lists do not restrict. Multiple skill lists take the tightest intersection.
 */
export function mergeSkillAllowedTools(
  sessionAllow: readonly string[] | undefined,
  skillLists: Array<readonly string[] | undefined>,
): string[] | undefined {
  const active = skillLists.filter((list): list is readonly string[] => Boolean(list && list.length > 0));
  if (active.length === 0) return sessionAllow ? [...sessionAllow] : undefined;

  let intersection = new Set(active[0]!);
  for (let i = 1; i < active.length; i++) {
    const next = new Set(active[i]!);
    intersection = new Set([...intersection].filter(tool => next.has(tool)));
  }

  if (sessionAllow && sessionAllow.length > 0) {
    const session = new Set(sessionAllow);
    intersection = new Set([...intersection].filter(tool => session.has(tool)));
  }

  return [...intersection].sort();
}

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9_./-]+/)
      .map(t => t.trim())
      .filter(t => t.length >= 3),
  );
}

function scoreSkill(skill: SkillRecord, promptTokens: Set<string>, workspaceRoot?: string): number {
  if (skillDisableModelInvocation(skill)) return 0;
  if (skill.runMode !== 'auto') return 0;

  const paths = skillPathsOf(skill);
  if (paths.length > 0 && workspaceRoot) {
    // Lightweight path filter: require at least one path token to appear in the prompt
    // (full glob against workspace is deferred; avoids false auto inject).
    const pathHit = paths.some(p => {
      const base = p.replace(/\*\*/g, '').replace(/\*/g, '').split('/').filter(Boolean).pop();
      return base ? promptTokens.has(base.toLowerCase()) || [...promptTokens].some(t => t.includes(base.toLowerCase())) : false;
    });
    if (!pathHit) {
      // If paths declared but none hinted in prompt, score 0
      // (strict: auto only when path context is mentioned)
      return 0;
    }
  }

  const haystack = tokenize([
    skill.name,
    skill.description,
    skill.category,
    ...skill.tags,
  ].join(' '));

  let hits = 0;
  for (const token of haystack) {
    if (promptTokens.has(token)) hits += 1;
  }
  return hits;
}

function resolveManual(
  catalog: SkillRecord[],
  ids: string[],
): { found: SkillRecord[]; missing: string[] } {
  const found: SkillRecord[] = [];
  const missing: string[] = [];
  for (const id of ids) {
    const skill = findSkill(catalog, id);
    if (!skill) {
      missing.push(id);
      continue;
    }
    if (!skill.enabled) {
      missing.push(`${id}:disabled`);
      continue;
    }
    if (!skillUserInvocable(skill)) {
      missing.push(`${id}:not-user-invocable`);
      continue;
    }
    found.push(skill);
  }
  return { found, missing };
}

function findSkill(catalog: SkillRecord[], idOrName: string): SkillRecord | undefined {
  const exact = catalog.find(s => s.id === idOrName || s.name === idOrName);
  if (exact) return exact;
  if (idOrName.includes(':')) {
    const [scope, ...rest] = idOrName.split(':');
    const name = rest.join(':');
    return catalog.find(s => s.name === name && skillScopeOf(s) === scope);
  }
  // Prefer project scope when names collide
  const matches = catalog.filter(s => s.name === idOrName);
  return matches.find(s => skillScopeOf(s) === 'project') ?? matches[0];
}

function toSelected(skill: SkillRecord, mode: 'manual' | 'auto', content: string, tokenEstimate: number): SelectedSkill {
  return {
    id: skill.id,
    name: skill.name,
    scope: skillScopeOf(skill),
    mode,
    versionHash: skill.versionHash,
    tokenEstimate,
    allowedTools: skillAllowedToolsOf(skill),
    content,
  };
}

function formatAttachment(selected: SelectedSkill[]): string {
  if (selected.length === 0) return '';
  const lines: string[] = [
    '## Active Skills (operator-selected or auto-matched)',
    'Apply the following skill instructions for this turn only.',
    '',
  ];
  for (const skill of selected) {
    lines.push(`### Skill: ${skill.name} (${skill.mode}, ${skill.scope})`);
    lines.push('');
    lines.push(skill.content);
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

/**
 * Select skills for a run and build the user-turn attachment.
 * Does not write usage counters — call `recordSkillUsage` after a successful selection.
 */
export async function selectSkillsForRun(input: SkillSelectionInput): Promise<SkillSelectionResult> {
  const runtimeEnabled = input.runtimeEnabled !== false;
  const { cleanedPrompt, skillNames: directiveNames } = parseSkillDirectives(input.prompt);
  const manualIds = [...new Set([...(input.manualSkillIds ?? []), ...directiveNames])];

  if (!runtimeEnabled) {
    return {
      selected: [],
      skipped: manualIds.length > 0 ? manualIds.map(name => ({ name, reason: 'runtime_disabled' })) : [],
      userAttachment: '',
      cleanedPrompt,
      effectivePrompt: cleanedPrompt,
    };
  }

  const maxAuto = input.maxAutoSkills ?? DEFAULT_MAX_AUTO;
  const maxTokens = input.maxSkillTokens ?? DEFAULT_MAX_TOKENS;
  const autoEnabled = input.autoEnabled === true;

  const catalog = input.catalog ?? await listSkills({ enabled: true, archived: false });
  const skipped: Array<{ name: string; reason: string }> = [];
  const selected: SelectedSkill[] = [];
  let usedTokens = 0;

  const { found: manuals, missing } = resolveManual(catalog, manualIds);
  for (const id of missing) skipped.push({ name: id, reason: 'not_found_or_unavailable' });

  // Manual first
  for (let i = 0; i < manuals.length; i++) {
    const skill = manuals[i]!;
    const fullTokens = estimateSkillTokens(skill.content);
    if (selected.length === 0 && manuals.length === 1 && fullTokens > maxTokens) {
      // Single oversized manual: truncate content, still inject
      const ratio = maxTokens / Math.max(fullTokens, 1);
      const cut = Math.max(64, Math.floor(skill.content.length * ratio));
      const truncated = `${skill.content.slice(0, cut)}\n\n…[skill truncated to budget]`;
      const tokenEstimate = estimateSkillTokens(truncated);
      selected.push(toSelected(skill, 'manual', truncated, tokenEstimate));
      usedTokens += tokenEstimate;
      skipped.push({ name: skill.name, reason: 'truncated' });
      continue;
    }
    if (usedTokens + fullTokens > maxTokens && selected.length > 0) {
      skipped.push({ name: skill.name, reason: 'budget' });
      continue;
    }
    if (usedTokens + fullTokens > maxTokens && selected.length === 0) {
      // First of several manuals still over budget — truncate like single case
      const ratio = maxTokens / Math.max(fullTokens, 1);
      const cut = Math.max(64, Math.floor(skill.content.length * ratio));
      const truncated = `${skill.content.slice(0, cut)}\n\n…[skill truncated to budget]`;
      const tokenEstimate = estimateSkillTokens(truncated);
      selected.push(toSelected(skill, 'manual', truncated, tokenEstimate));
      usedTokens += tokenEstimate;
      skipped.push({ name: skill.name, reason: 'truncated' });
      continue;
    }
    selected.push(toSelected(skill, 'manual', skill.content, fullTokens));
    usedTokens += fullTokens;
  }

  // Auto fill remaining budget
  if (autoEnabled) {
    const promptTokens = tokenize(cleanedPrompt);
    const already = new Set(selected.map(s => s.id));
    const ranked = catalog
      .filter(s => s.enabled && s.runMode === 'auto' && !already.has(s.id) && !skillDisableModelInvocation(s))
      .map(s => ({ skill: s, score: scoreSkill(s, promptTokens, input.workspaceRoot) }))
      .filter(row => row.score > 0)
      .sort((a, b) => b.score - a.score || b.skill.usageCount - a.skill.usageCount);

    let autoCount = 0;
    for (const row of ranked) {
      if (autoCount >= maxAuto) {
        skipped.push({ name: row.skill.name, reason: 'max_auto' });
        continue;
      }
      const tokens = estimateSkillTokens(row.skill.content);
      if (usedTokens + tokens > maxTokens) {
        skipped.push({ name: row.skill.name, reason: 'budget' });
        continue;
      }
      selected.push(toSelected(row.skill, 'auto', row.skill.content, tokens));
      usedTokens += tokens;
      autoCount += 1;
    }
  }

  const userAttachment = formatAttachment(selected);
  const skillAllowedTools = mergeSkillAllowedTools(
    undefined,
    selected.map(s => s.allowedTools),
  );
  // When skills declare allowlists, skillAllowedTools is the intersection only among skills.
  // Session merge happens in the caller via mergeSkillAllowedTools(session, …).

  const effectivePrompt = userAttachment
    ? `${userAttachment}\n\n---\n\n${cleanedPrompt}`
    : cleanedPrompt;

  if (selected.length > 0) {
    log.info('skills selected for run', {
      count: selected.length,
      names: selected.map(s => s.name),
      modes: selected.map(s => s.mode),
      skipped: skipped.length,
    });
  }

  return {
    selected,
    skipped,
    userAttachment,
    skillAllowedTools,
    cleanedPrompt,
    effectivePrompt,
  };
}

/** Record usage once per skill per run after selection succeeds. */
export async function recordSkillUsage(selected: SelectedSkill[]): Promise<void> {
  for (const skill of selected) {
    try {
      await incrementSkillUsage(skill.name, skill.scope);
    } catch (err) {
      log.warn(`incrementSkillUsage failed for ${skill.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/** Build audit payload for session event type `skill.selected`. */
export function skillSelectedEventPayload(result: SkillSelectionResult): Record<string, unknown> {
  return {
    skills: result.selected.map(s => ({
      name: s.name,
      mode: s.mode,
      versionHash: s.versionHash,
      tokenEstimate: s.tokenEstimate,
      scope: s.scope,
    })),
    skipped: result.skipped,
    placement: 'user_attachment',
  };
}
