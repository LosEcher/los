/**
 * los scan — CLI command for running static analysis scans.
 *
 * Usage:
 *   los scan [--project NAME] [--root DIR] [--rules GLOB] [--json] [--gateway URL]
 */

import { resolve } from 'node:path';
import { scanProject, loadRuleFiles, buildStaticAnalysisPayload } from '@los/agent';

type ParsedArgs = {
  flags: Record<string, string | boolean>;
  positionals: string[];
};

const DEFAULT_PROJECT = 'custom';

export async function scanCommand(globalArgs: string[], argv: string[]): Promise<void> {
  const parsed = mergeParsed(parseArgs(globalArgs), parseArgs(argv));
  if (hasFlag(parsed, 'help', 'h')) {
    printScanHelp();
    return;
  }

  const project = stringFlag(parsed, 'project') ?? DEFAULT_PROJECT;
  const rootDir = resolve(stringFlag(parsed, 'root') ?? process.cwd());
  const rulesGlob = stringFlag(parsed, 'rules') ?? undefined;
  const jsonOutput = booleanFlag(parsed, 'json');

  const rules = rulesGlob
    ? await loadRuleFiles([rulesGlob])
    : await loadRuleFiles([]);
  if (rules.length === 0) {
    console.error('No rules loaded. Check --rules glob or ensure rule YAML files exist.');
    process.exit(1);
  }

  const result = await scanProject({
    project,
    rootDir,
    rules,
    deterministic: true,
  });

  if (jsonOutput) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  // Text output
  console.log(`Static analysis: ${project}`);
  console.log(`  Files scanned: ${result.filesScanned}`);
  console.log(`  Findings:      ${result.findings.length}`);
  if (result.parseFailures) {
    const counts = result.parseFailures as Record<string, unknown>;
    const totalFailures = Object.values(counts).reduce((sum: number, v) => {
      if (typeof v === 'number') return sum + v;
      if (Array.isArray(v)) return sum + v.length;
      return sum;
    }, 0);
    console.log(`  Parse failures: ${totalFailures}`);
  }
  console.log('');

  // Rule breakdown
  const payload = buildStaticAnalysisPayload(result, project);
  for (const [ruleId, count] of Object.entries(payload.ruleBreakdown).sort(([, a], [, b]) => b - a)) {
    console.log(`  ${ruleId}: ${count}`);
  }

  // Samples
  if (payload.sampleFindings.length > 0) {
    console.log('\nSample findings:');
    for (const f of payload.sampleFindings) {
      console.log(`  [${f.severity}] ${f.ruleId} — ${f.file}`);
      console.log(`    ${f.message}`);
      if (f.excerpt) console.log(`    >>> ${f.excerpt}`);
    }
  }
}

function printScanHelp(): void {
  console.log(`los scan

Run static analysis (AST-grep rules) against a project directory.

Usage:
  los scan [--project NAME] [--root DIR] [--rules GLOB] [--json]

Options:
  --project NAME   Project label (default: custom)
  --root DIR       Root directory to scan (default: cwd)
  --rules GLOB     Glob pattern for rule YAML files
  --json           Output as JSON`);
}

// ── ParsedArgs helpers (mirrored from index.ts to avoid circular imports) ──

function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];
  const aliases: Record<string, string> = {
    p: 'project',
    r: 'root',
    h: 'help',
  };
  const booleanFlags = new Set(['help', 'h', 'json']);

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (token.startsWith('--')) {
      const [rawKey, inlineValue] = token.slice(2).split('=', 2);
      if (inlineValue !== undefined) {
        flags[rawKey] = inlineValue;
        continue;
      }
      if (booleanFlags.has(rawKey)) {
        flags[rawKey] = true;
        continue;
      }
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        flags[rawKey] = next;
        i += 1;
      } else {
        flags[rawKey] = true;
      }
      continue;
    }
    if (/^-[a-zA-Z]$/.test(token)) {
      const key = aliases[token.slice(1)] ?? token.slice(1);
      if (booleanFlags.has(key)) {
        flags[key] = true;
        continue;
      }
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        flags[key] = next;
        i += 1;
      } else {
        flags[key] = true;
      }
      continue;
    }
    positionals.push(token);
  }

  return { flags, positionals };
}

function mergeParsed(first: ParsedArgs, second: ParsedArgs): ParsedArgs {
  return {
    flags: { ...first.flags, ...second.flags },
    positionals: [...first.positionals, ...second.positionals],
  };
}

function stringFlag(parsed: ParsedArgs, key: string): string | undefined {
  const value = parsed.flags[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function booleanFlag(parsed: ParsedArgs, key: string): boolean {
  return parsed.flags[key] === true || parsed.flags[key] === 'true' || parsed.flags[key] === '1';
}

function hasFlag(parsed: ParsedArgs, ...keys: string[]): boolean {
  return keys.some(key => parsed.flags[key] !== undefined);
}
