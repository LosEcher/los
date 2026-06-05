import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REQUIRED_CASE_FIELDS = [
  'Trigger:',
  'Bad pattern:',
  'Required evidence:',
  'Passing pattern:',
  'Owner surface:',
] as const;

const FIRST_PROMOTION_CASES = ['E01', 'E02', 'E03', 'E04', 'E05', 'E06'] as const;

test('agent eval backlog wires first high-risk cases into a runnable check', async () => {
  const backlog = await readEvalBacklog();
  const sections = parseCaseSections(backlog);

  for (const caseId of FIRST_PROMOTION_CASES) {
    const section = sections.get(caseId);
    assert.ok(section, `${caseId} is missing from eval backlog`);
    for (const field of REQUIRED_CASE_FIELDS) {
      assert.match(section, new RegExp(`^${escapeRegExp(field)}`, 'm'), `${caseId} is missing ${field}`);
    }
  }

  const promotionOrder = sectionAfterHeading(backlog, '## Promotion Order');
  const firstOrderLine = promotionOrder.split('\n').find(line => line.trim().startsWith('1.'));
  assert.ok(firstOrderLine, 'Promotion Order is missing the first priority line');
  for (const caseId of FIRST_PROMOTION_CASES) {
    assert.match(firstOrderLine, new RegExp(`\\b${caseId}\\b`), `${caseId} is missing from first promotion order`);
  }
});

async function readEvalBacklog(): Promise<string> {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  return await readFile(join(currentDir, '../../../docs/governance/eval-backlog.md'), 'utf8');
}

function parseCaseSections(markdown: string): Map<string, string> {
  const out = new Map<string, string>();
  const matches = [...markdown.matchAll(/^### (E\d{2})\b.*$/gm)];
  for (let index = 0; index < matches.length; index++) {
    const match = matches[index]!;
    const next = matches[index + 1];
    out.set(match[1]!, markdown.slice(match.index, next?.index ?? markdown.length));
  }
  return out;
}

function sectionAfterHeading(markdown: string, heading: string): string {
  const start = markdown.indexOf(heading);
  assert.notEqual(start, -1, `${heading} is missing`);
  const next = markdown.indexOf('\n## ', start + heading.length);
  return markdown.slice(start, next === -1 ? markdown.length : next);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
