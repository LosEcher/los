import crypto from 'node:crypto';

export function toIsoNow(deterministic = true): string {
  return deterministic ? '1970-01-01T00:00:00.000Z' : new Date().toISOString();
}

export const DEFAULT_EXCERPT_LENGTH = 240;
export const PARSE_FAILURE_SAMPLE_LIMIT = 20;

export function clampExcerpt(text: string, max = DEFAULT_EXCERPT_LENGTH): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

export function renderReplacement(
  template: string,
  node: { getMatch: (name: string) => { text: () => string } | null; getMultipleMatches: (name: string) => Array<{ text: () => string }> },
  joinBy = ', ',
): string {
  return template.replace(
    /\$\$\$([A-Za-z_][A-Za-z0-9_]*)|\$([A-Za-z_][A-Za-z0-9_]*)/g,
    (m, many, single) => {
      if (many) {
        const nodes = node.getMultipleMatches(many) || [];
        return nodes.map((n) => n.text()).join(joinBy);
      }
      if (single) {
        const n = node.getMatch(single);
        return n ? n.text() : m;
      }
      return m;
    },
  );
}

export function passesConstraints(
  node: { text: () => string; getMatch: (name: string) => { text: () => string } | null; getMultipleMatches: (name: string) => Array<{ text: () => string }> },
  constraints: Array<{ name: string; regex: string; flags?: string; mode?: 'any' | 'all' }> | null | undefined,
): boolean {
  if (!constraints || constraints.length === 0) return true;
  for (const c of constraints) {
    const re = new RegExp(c.regex, c.flags || '');
    const mode = c.mode || 'any';
    if (c.name === '.') {
      if (!re.test(node.text())) return false;
      continue;
    }

    const single = node.getMatch(c.name);
    if (single) {
      if (!re.test(single.text())) return false;
      continue;
    }

    const many = node.getMultipleMatches(c.name) || [];
    if (many.length === 0) return false;
    const texts = many.map((n) => n.text());
    if (mode === 'all') {
      if (!texts.every((t) => re.test(t))) return false;
    } else {
      if (!texts.some((t) => re.test(t))) return false;
    }
  }
  return true;
}

export function fingerprintFor({
  ruleId,
  file,
  range,
  proposedReplacement,
  deterministic = false,
}: {
  ruleId: string;
  file: string;
  range: { start: { index: number }; end: { index: number } };
  proposedReplacement: string | null;
  deterministic?: boolean;
}): string {
  const base = [
    String(ruleId),
    String(file),
    `${range.start.index}-${range.end.index}`,
    proposedReplacement == null ? '' : String(proposedReplacement),
  ].join('\n');
  if (deterministic) {
    return crypto.createHash('sha256').update(base).digest('hex').slice(0, 32);
  }
  return crypto.createHash('sha256').update(base).digest('hex');
}

export function deterministicSort(
  a: { file: string; range: { start: { line: number; column: number } } },
  b: { file: string; range: { start: { line: number; column: number } } },
): number {
  if (a.file !== b.file) return a.file.localeCompare(b.file);
  if (a.range.start.line !== b.range.start.line)
    return a.range.start.line - b.range.start.line;
  return a.range.start.column - b.range.start.column;
}

export function summarizeParseFailures(
  parseFailures: Array<{ file: string; language: string; error: string }>,
) {
  if (!Array.isArray(parseFailures) || parseFailures.length === 0) return null;

  const byLanguage: Record<string, number> = {};
  for (const failure of parseFailures) {
    byLanguage[failure.language] = (byLanguage[failure.language] || 0) + 1;
  }

  return {
    count: parseFailures.length,
    sampleLimit: PARSE_FAILURE_SAMPLE_LIMIT,
    truncated: parseFailures.length > PARSE_FAILURE_SAMPLE_LIMIT,
    byLanguage,
    samples: parseFailures.slice(0, PARSE_FAILURE_SAMPLE_LIMIT),
  };
}
