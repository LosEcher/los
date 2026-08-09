/**
 * @los/agent/operator-rules-runtime — Operator Rules prompt inject + hard gate.
 *
 * - Prompt title: ## Operator Rules (distinct from learned procedural memory)
 * - Hard gate: required + severity=block + valid match DSL → broker deny
 * - Broker must only call pure evaluateOperatorRuleGate (no DB on hot path)
 */

import { getLogger } from '@los/infra/logger';
import { filePathFromToolArgs } from './pre-action-gate.js';
import {
  listRules,
  type RuleEnforcementMode,
  type RuleRecord,
  type RuleSeverity,
} from './rules.js';

const log = getLogger('operator-rules-runtime');

const OPERATOR_RULES_PROMPT_TITLE = '## Operator Rules';
const LEARNED_PROCEDURAL_RULES_PROMPT_TITLE = '## Learned Procedural Rules (memory)';

const DEFAULT_MAX_PROMPT_RULES = 20;

export interface OperatorRuleMatchSpec {
  tools?: string[];
  pathGlobs?: string[];
  argRegex?: Record<string, string>;
}

export interface ParsedOperatorRuleMatch {
  ok: boolean;
  machineEnforceable: boolean;
  match: OperatorRuleMatchSpec | null;
  warnings: string[];
}

export interface OperatorRuleGateRule {
  id: string;
  name: string;
  severity: RuleSeverity;
  enforcementMode: RuleEnforcementMode;
  content: string;
  match: OperatorRuleMatchSpec | null;
  machineEnforceable: boolean;
  parseWarnings: string[];
}

export type OperatorRulesGateConfig =
  | { enabled: true; rules: OperatorRuleGateRule[] }
  | { enabled: false };

export interface OperatorRuleGateDecision {
  allowed: boolean;
  action: 'allow' | 'warn' | 'block';
  ruleId?: string;
  ruleName?: string;
  severity?: RuleSeverity;
  enforcementMode?: RuleEnforcementMode;
  reason?: string;
}

export interface OperatorRulesSelection {
  rules: OperatorRuleGateRule[];
  promptBlock: string;
  requiredCount: number;
  blockCount: number;
  machineEnforceableCount: number;
}

/** Extract YAML frontmatter match block from rule content. Body may be free text. */
function parseOperatorRuleMatch(content: string): ParsedOperatorRuleMatch {
  const warnings: string[] = [];
  const trimmed = content.trim();
  if (!trimmed.startsWith('---')) {
    return { ok: true, machineEnforceable: false, match: null, warnings };
  }

  const end = trimmed.indexOf('\n---', 3);
  if (end < 0) {
    warnings.push('frontmatter_unclosed');
    return { ok: false, machineEnforceable: false, match: null, warnings };
  }

  const rawYaml = trimmed.slice(3, end).trim();
  if (!rawYaml) {
    return { ok: true, machineEnforceable: false, match: null, warnings };
  }

  try {
    const matchNode = extractMatchNode(rawYaml);
    const tools = collectYamlList(rawYaml, ['tools', 'match.tools']);
    const pathGlobs = collectYamlList(rawYaml, ['pathGlobs', 'path_globs', 'match.pathGlobs', 'match.path_globs']);
    // Prefer structured extract when collectYamlList is empty but node has values
    const toolsFinal = tools.length > 0 ? tools : asStringList(matchNode.tools);
    const globsFinal = pathGlobs.length > 0 ? pathGlobs : asStringList(matchNode.pathGlobs ?? matchNode.path_globs);
    const argRegex = collectYamlMap(rawYaml, ['argRegex', 'arg_regex', 'match.argRegex', 'match.arg_regex']);

    for (const [key, pattern] of Object.entries(argRegex)) {
      try {
        // eslint-disable-next-line no-new
        new RegExp(pattern);
      } catch {
        warnings.push(`arg_regex_compile_failed:${key}`);
        delete argRegex[key];
      }
    }

    const match: OperatorRuleMatchSpec = {};
    if (toolsFinal.length > 0) match.tools = toolsFinal;
    if (globsFinal.length > 0) match.pathGlobs = globsFinal;
    if (Object.keys(argRegex).length > 0) match.argRegex = argRegex;

    const hasConstraint = Boolean(match.tools?.length || match.pathGlobs?.length || match.argRegex);
    if (!hasConstraint) {
      warnings.push('match_empty');
      return { ok: true, machineEnforceable: false, match: null, warnings };
    }

    // Any invalid arg regex fails closed: do not machine-enforce a partial match
    // (required+block must not hard-deny on broken DSL).
    const regexBroken = warnings.some(w => w.startsWith('arg_regex_compile_failed'));
    return {
      ok: !regexBroken,
      machineEnforceable: !regexBroken,
      match: regexBroken ? null : match,
      warnings,
    };
  } catch (error) {
    warnings.push(`frontmatter_parse_error:${error instanceof Error ? error.message : String(error)}`);
    return { ok: false, machineEnforceable: false, match: null, warnings };
  }
}

function toOperatorRuleGateRule(rule: RuleRecord): OperatorRuleGateRule {
  const parsed = parseOperatorRuleMatch(rule.content);
  // required+block with invalid/unenforceable match: fail closed to non-enforceable
  // so we never hard-block on broken DSL (design §3.3).
  const wantsHard = rule.enforcementMode === 'required' && rule.severity === 'block';
  const machineEnforceable = wantsHard
    ? parsed.machineEnforceable && parsed.ok
    : parsed.machineEnforceable && parsed.ok;

  if (wantsHard && !machineEnforceable) {
    log.warn('operator rule not machine-enforceable', {
      ruleId: rule.id,
      ruleName: rule.name,
      warnings: parsed.warnings,
    });
  }

  return {
    id: rule.id,
    name: rule.name,
    severity: rule.severity,
    enforcementMode: rule.enforcementMode,
    content: stripFrontmatter(rule.content),
    match: parsed.match,
    machineEnforceable,
    parseWarnings: parsed.warnings,
  };
}

export async function listActiveOperatorRules(options: {
  maxRules?: number;
  /** Optional preloaded catalog for tests. */
  catalog?: RuleRecord[];
} = {}): Promise<OperatorRuleGateRule[]> {
  const max = options.maxRules && options.maxRules > 0 ? options.maxRules : DEFAULT_MAX_PROMPT_RULES;
  const source = options.catalog
    ?? await listRules({ status: 'active', archived: false });
  // Prefer project then global ordering is already in listRules severity order;
  // cap for prompt/gate budget.
  return source.slice(0, max).map(toOperatorRuleGateRule);
}

function formatOperatorRulesForPrompt(rules: OperatorRuleGateRule[]): string {
  if (rules.length === 0) return '';
  const lines: string[] = [
    OPERATOR_RULES_PROMPT_TITLE,
    'Operator-defined policy for this workspace. Prefer these over learned memory when they conflict.',
    '',
  ];
  for (const rule of rules) {
    const badge = rule.severity === 'block' ? '🛑'
      : rule.severity === 'error' ? '⚠️'
        : rule.severity === 'warn' ? '⚡'
          : 'ℹ️';
    const enforce = rule.enforcementMode === 'required' ? 'required' : 'advisory';
    lines.push(`### ${badge} ${rule.name} (${rule.severity}/${enforce})`);
    if (rule.machineEnforceable && rule.match) {
      const bits: string[] = [];
      if (rule.match.tools?.length) bits.push(`tools: ${rule.match.tools.join(', ')}`);
      if (rule.match.pathGlobs?.length) bits.push(`paths: ${rule.match.pathGlobs.join(', ')}`);
      if (rule.match.argRegex) bits.push(`args: ${Object.keys(rule.match.argRegex).join(', ')}`);
      if (bits.length) lines.push(`*Match*: ${bits.join(' · ')}`);
    }
    lines.push('');
    lines.push(rule.content.trim() || '_(no body)_');
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

export function selectOperatorRulesForRun(rules: OperatorRuleGateRule[]): OperatorRulesSelection {
  return {
    rules,
    promptBlock: formatOperatorRulesForPrompt(rules),
    requiredCount: rules.filter(r => r.enforcementMode === 'required').length,
    blockCount: rules.filter(r => r.severity === 'block').length,
    machineEnforceableCount: rules.filter(r => r.machineEnforceable).length,
  };
}

export function buildOperatorRulesGateConfig(
  rules: OperatorRuleGateRule[],
  enabled: boolean,
): OperatorRulesGateConfig {
  if (!enabled) return { enabled: false };
  return { enabled: true, rules };
}

/**
 * Pure hot-path gate. Call after evaluateTool / phase policy, before execute.
 * Only required + block + machineEnforceable rules can hard-deny.
 */
export function evaluateOperatorRuleGate(
  toolName: string,
  args: Record<string, unknown>,
  gate: OperatorRulesGateConfig | undefined,
): OperatorRuleGateDecision {
  if (!gate || gate.enabled !== true || gate.rules.length === 0) {
    return { allowed: true, action: 'allow' };
  }

  const path = filePathFromToolArgs(args);
  let warnHit: OperatorRuleGateDecision | null = null;

  for (const rule of gate.rules) {
    if (!rule.machineEnforceable || !rule.match) continue;
    if (!matchesRule(toolName, args, path, rule.match)) continue;

    const reason = `operator rule "${rule.name}" matched`;
    if (rule.enforcementMode === 'required' && rule.severity === 'block') {
      return {
        allowed: false,
        action: 'block',
        ruleId: rule.id,
        ruleName: rule.name,
        severity: rule.severity,
        enforcementMode: rule.enforcementMode,
        reason,
      };
    }

    // Advisory / non-block: surface first warn for callers that emit tool.warned
    if (!warnHit) {
      warnHit = {
        allowed: true,
        action: 'warn',
        ruleId: rule.id,
        ruleName: rule.name,
        severity: rule.severity,
        enforcementMode: rule.enforcementMode,
        reason,
      };
    }
  }

  return warnHit ?? { allowed: true, action: 'allow' };
}

export function injectOperatorRulesIntoSystemPrompt(
  systemPrompt: string,
  promptBlock: string,
): string {
  if (!promptBlock.trim()) return systemPrompt;
  if (systemPrompt.includes(OPERATOR_RULES_PROMPT_TITLE)) return systemPrompt;
  // Place after identity/base: append near front of memory chain by inserting
  // before learned procedural / observations when present; else append.
  const learnedIdx = systemPrompt.indexOf(LEARNED_PROCEDURAL_RULES_PROMPT_TITLE);
  const legacyIdx = systemPrompt.indexOf('## Active Procedural Rules');
  const insertAt = learnedIdx >= 0 ? learnedIdx : legacyIdx;
  if (insertAt >= 0) {
    return `${systemPrompt.slice(0, insertAt).trimEnd()}\n\n${promptBlock}\n\n${systemPrompt.slice(insertAt)}`;
  }
  return `${systemPrompt.trimEnd()}\n\n${promptBlock}`;
}

function matchesRule(
  toolName: string,
  args: Record<string, unknown>,
  path: string | undefined,
  match: OperatorRuleMatchSpec,
): boolean {
  if (match.tools?.length && !match.tools.includes(toolName)) return false;

  if (match.pathGlobs?.length) {
    if (!path) return false;
    if (!match.pathGlobs.some(glob => pathMatchesGlob(path, glob))) return false;
  }

  if (match.argRegex) {
    for (const [key, pattern] of Object.entries(match.argRegex)) {
      const value = args[key];
      const text = typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value);
      if (!new RegExp(pattern).test(text)) return false;
    }
  }

  return true;
}

/** Minimal glob: ** and * only, no brace expansion. */
function pathMatchesGlob(path: string, glob: string): boolean {
  const normalizedPath = path.replace(/\\/g, '/');
  const normalizedGlob = glob.replace(/\\/g, '/');
  const re = globToRegExp(normalizedGlob);
  return re.test(normalizedPath);
}

function globToRegExp(glob: string): RegExp {
  let out = '^';
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i]!;
    if (ch === '*' && glob[i + 1] === '*') {
      out += '.*';
      i += 1;
      if (glob[i + 1] === '/') i += 1;
    } else if (ch === '*') {
      out += '[^/]*';
    } else if (ch === '?') {
      out += '[^/]';
    } else if ('+.^${}()|[]\\'.includes(ch)) {
      out += `\\${ch}`;
    } else {
      out += ch;
    }
  }
  out += '$';
  return new RegExp(out);
}

function stripFrontmatter(content: string): string {
  const trimmed = content.trim();
  if (!trimmed.startsWith('---')) return content.trim();
  const end = trimmed.indexOf('\n---', 3);
  if (end < 0) return content.trim();
  return trimmed.slice(end + 4).trim();
}

function asStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map(v => String(v).trim()).filter(Boolean);
  }
  if (typeof value === 'string') {
    return value.split(/[,\s]+/).map(s => s.trim()).filter(Boolean);
  }
  return [];
}

function stripQuotes(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function extractMatchNode(source: string): Record<string, unknown> {
  // Best-effort: only used as fallback for simple `key: value` pairs.
  const node: Record<string, unknown> = {};
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('-')) continue;
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim();
    const rest = line.slice(colon + 1).trim();
    if (!rest) continue;
    if (rest.startsWith('[') && rest.endsWith(']')) {
      node[key] = rest.slice(1, -1).split(',').map(s => stripQuotes(s.trim())).filter(Boolean);
    } else {
      node[key] = stripQuotes(rest);
    }
  }
  return node;
}

/** Collect a YAML list for a key (supports nested `match.tools` and inline `[a, b]`). */
function collectYamlList(source: string, keys: string[]): string[] {
  const lines = source.split(/\r?\n/);
  for (const key of keys) {
    const leaf = key.includes('.') ? key.split('.').pop()! : key;
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? '';
      const trimmed = line.trim();
      if (!trimmed.startsWith(`${leaf}:`)) continue;
      const rest = trimmed.slice(leaf.length + 1).trim();
      if (rest.startsWith('[') && rest.endsWith(']')) {
        return rest.slice(1, -1).split(',').map(s => stripQuotes(s.trim())).filter(Boolean);
      }
      if (rest) return [stripQuotes(rest)].filter(Boolean);
      // Following indented `- item` lines
      const baseIndent = (line.match(/^\s*/)?.[0].length ?? 0);
      const items: string[] = [];
      for (let j = i + 1; j < lines.length; j += 1) {
        const next = lines[j] ?? '';
        if (!next.trim()) continue;
        const indent = next.match(/^\s*/)?.[0].length ?? 0;
        if (indent <= baseIndent) break;
        const t = next.trim();
        if (t.startsWith('- ')) items.push(stripQuotes(t.slice(2).trim()));
        else if (!t.startsWith('-') && t.includes(':')) break;
      }
      if (items.length > 0) return items;
    }
  }
  return [];
}

function collectYamlMap(source: string, keys: string[]): Record<string, string> {
  const lines = source.split(/\r?\n/);
  for (const key of keys) {
    const leaf = key.includes('.') ? key.split('.').pop()! : key;
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? '';
      const trimmed = line.trim();
      if (!trimmed.startsWith(`${leaf}:`)) continue;
      const rest = trimmed.slice(leaf.length + 1).trim();
      if (rest) continue;
      const baseIndent = (line.match(/^\s*/)?.[0].length ?? 0);
      const map: Record<string, string> = {};
      for (let j = i + 1; j < lines.length; j += 1) {
        const next = lines[j] ?? '';
        if (!next.trim()) continue;
        const indent = next.match(/^\s*/)?.[0].length ?? 0;
        if (indent <= baseIndent) break;
        const t = next.trim();
        const colon = t.indexOf(':');
        if (colon < 0) continue;
        const k = t.slice(0, colon).trim();
        const v = stripQuotes(t.slice(colon + 1).trim());
        if (k && v) map[k] = v;
      }
      if (Object.keys(map).length > 0) return map;
    }
  }
  return {};
}
