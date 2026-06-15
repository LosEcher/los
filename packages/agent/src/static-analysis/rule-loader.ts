import fs from 'node:fs/promises';
import path from 'node:path';

import fg from 'fast-glob';
import { parse as parseYaml } from 'yaml';

import type { StaticAnalysisRule, StaticAnalysisConstraint } from './types.js';

function normalizeSeverity(raw: unknown): 'error' | 'warning' | 'info' {
  const s = String(raw || 'warning').toLowerCase();
  if (s === 'info' || s === 'warning' || s === 'error') return s;
  return 'warning';
}

function normalizeConstraints(raw: unknown): StaticAnalysisConstraint[] | null {
  if (raw == null) return null;
  if (Array.isArray(raw)) return raw as StaticAnalysisConstraint[];
  if (typeof raw === 'object') return [raw as StaticAnalysisConstraint];
  return null;
}

function normalizeGovernanceDomain(domain: unknown): string[] | null {
  if (!domain) return null;
  if (Array.isArray(domain))
    return domain.filter(Boolean).map((item) => String(item).trim()).filter(Boolean);
  if (typeof domain === 'string' && domain.trim()) return [domain.trim()];
  return null;
}

function normalizeGovernance(governance: unknown): StaticAnalysisRule['governance'] {
  if (!governance || typeof governance !== 'object') return null;
  const g = governance as Record<string, unknown>;

  const normalized: StaticAnalysisRule['governance'] = {
    domain: normalizeGovernanceDomain(g.domain || (g as Record<string, unknown>).domains),
    owner: g.owner ? String(g.owner) : undefined,
    impact: undefined,
    rationale: g.rationale ? String(g.rationale) : undefined,
  };

  if (g.impact) {
    const impact = String(g.impact).toLowerCase();
    if (impact === 'low' || impact === 'medium' || impact === 'high') {
      normalized.impact = impact;
    } else {
      normalized.impact = 'medium';
    }
  }

  if (!normalized.domain && !normalized.owner && !normalized.impact && !normalized.rationale) {
    return null;
  }

  return normalized;
}

function assertRuleShape(rule: Record<string, unknown>): void {
  if (!rule || typeof rule !== 'object') throw new Error('rule must be an object');
  if (!rule.id || typeof rule.id !== 'string') throw new Error('rule.id must be a string');
  if (!rule.language || typeof rule.language !== 'string')
    throw new Error('rule.language must be a string');
  if (!rule.message || typeof rule.message !== 'string')
    throw new Error('rule.message must be a string');
  if (!rule.rule || typeof rule.rule !== 'object') throw new Error('rule.rule must be an object');

  if (rule.constraints != null) {
    if (!Array.isArray(rule.constraints))
      throw new Error('rule.constraints must be an array');
    for (const c of rule.constraints as Array<Record<string, unknown>>) {
      if (!c || typeof c !== 'object')
        throw new Error('rule.constraints item must be an object');
      if (!c.name || typeof c.name !== 'string')
        throw new Error('rule.constraints.name must be a string');
      if (!c.regex || typeof c.regex !== 'string')
        throw new Error('rule.constraints.regex must be a string');
      if (c.flags != null && typeof c.flags !== 'string')
        throw new Error('rule.constraints.flags must be a string');
      if (c.mode != null && c.mode !== 'any' && c.mode !== 'all')
        throw new Error('rule.constraints.mode must be any|all');
    }
  }

  if (rule.fix != null) {
    if (typeof rule.fix !== 'object') throw new Error('rule.fix must be an object');
    const f = rule.fix as Record<string, unknown>;
    if (typeof f.replace !== 'string') throw new Error('rule.fix.replace must be a string');
    if (f.joinBy != null && typeof f.joinBy !== 'string')
      throw new Error('rule.fix.joinBy must be a string');
  }
}

export async function loadRuleFiles(rulePaths: string[]): Promise<StaticAnalysisRule[]> {
  const files = await fg(rulePaths, {
    onlyFiles: true,
    unique: true,
    absolute: true,
  });

  const rules: Array<Record<string, unknown> & { __file: string }> = [];

  for (const file of files) {
    const raw = await fs.readFile(file, 'utf8');
    const doc = parseYaml(raw);
    if (Array.isArray(doc)) {
      for (const item of doc) rules.push({ __file: file, ...(item as Record<string, unknown>) });
    } else {
      rules.push({ __file: file, ...(doc as Record<string, unknown>) });
    }
  }

  const normalized: StaticAnalysisRule[] = rules.map((r) => {
    const rule = { ...r } as unknown as StaticAnalysisRule & { __file?: string };
    rule.severity = normalizeSeverity(r.severity);
    rule.constraints = normalizeConstraints(r.constraints);
    rule.governance = normalizeGovernance(r.governance);
    rule.ruleFile = r.__file;
    delete (rule as unknown as Record<string, unknown>).__file;
    return rule;
  });

  for (const rule of normalized) {
    try {
      assertRuleShape(rule as unknown as Record<string, unknown>);
    } catch (e) {
      const rel = path.relative(process.cwd(), rule.ruleFile || '');
      throw new Error(
        `[static-analysis] invalid rule in ${rel}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  const seen = new Set<string>();
  for (const rule of normalized) {
    if (seen.has(rule.id)) throw new Error(`[static-analysis] duplicated rule id: ${rule.id}`);
    seen.add(rule.id);
  }

  return normalized;
}
