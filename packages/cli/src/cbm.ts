/**
 * CLI command: los cbm
 *
 * Shadow-mode measurement commands for the CBM code graph integration.
 * All commands read from .los/cbm-shadow-log.jsonl (local file, no DB dependency).
 */

import { computeShadowStats, printShadowStats, readShadowLog } from '@los/memory';

type ParsedArgs = {
  flags: Record<string, string | boolean>;
  positionals: string[];
};

const DEFAULT_GATEWAY = 'http://127.0.0.1:8080';

function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];
  for (const arg of argv) {
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq >= 0) {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      } else {
        flags[arg.slice(2)] = true;
      }
    } else if (arg.startsWith('-')) {
      flags[arg.slice(1)] = true;
    } else {
      positionals.push(arg);
    }
  }
  return { flags, positionals };
}

function hasFlag(parsed: ParsedArgs, ...names: string[]): boolean {
  return names.some(n => n in parsed.flags);
}

function getFlag(parsed: ParsedArgs, name: string): string | undefined {
  const v = parsed.flags[name];
  return typeof v === 'string' ? v : undefined;
}

export async function cbmCommand(globalArgs: string[], argv: string[]): Promise<void> {
  const parsed = { ...parseArgs(globalArgs), ...parseArgs(argv) };
  const [action = 'shadow-stats'] = parsed.positionals;

  if (hasFlag(parsed, 'help', 'h')) {
    printHelp();
    return;
  }

  if (action === 'shadow-stats') {
    if (hasFlag(parsed, 'json')) {
      console.log(JSON.stringify(computeShadowStats(), null, 2));
    } else {
      console.log(printShadowStats());
    }
    return;
  }

  if (action === 'shadow-log') {
    const limit = parseInt(getFlag(parsed, 'last') ?? '20', 10);
    const entries = readShadowLog();
    const recent = entries.slice(-limit);
    for (const e of recent) {
      console.log(
        `[${e.timestamp}] ${e.success ? 'OK' : 'FAIL'} ` +
        `session=${e.sessionId.slice(0, 8)}... ` +
        `files=${e.targetFiles.length} symbols=${e.symbolCount} ` +
        `latency=${e.latencyMs}ms` +
        (e.error ? ` error="${e.error}"` : ''),
      );
    }
    console.log(`\n(${recent.length} of ${entries.length} total entries)`);
    return;
  }

  console.error(`Unknown cbm subcommand: ${action}`);
  printHelp();
  process.exit(1);
}

function printHelp(): void {
  console.log([
    'los cbm <command> [options]',
    '',
    'Code graph (codebase-memory-mcp) shadow-mode and measurement tools.',
    '',
    'Commands:',
    '  shadow-stats       Show aggregated shadow-mode statistics',
    '  shadow-log         Show recent shadow-mode log entries',
    '',
    'Options:',
    '  --json             Machine-readable output (shadow-stats only)',
    '  --last N           Show last N entries (shadow-log, default 20)',
    '  -h, --help         Show this help',
    '',
    'Data source: .los/cbm-shadow-log.jsonl',
  ].join('\n'));
}
