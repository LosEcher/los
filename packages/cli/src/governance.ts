import {
  detectRuntimeCleanupWithDefaultDb,
  reconcilePlanningTodosWithDefaultDb,
  type RuntimeCleanupReport,
  type TodoReconciliationReport,
} from '@los/agent';

type ParsedArgs = {
  flags: Record<string, string | boolean>;
  positionals: string[];
};

export async function governanceCommand(globalArgs: string[], argv: string[]): Promise<void> {
  const parsed = mergeParsed(parseArgs(globalArgs), parseArgs(argv));
  const action = parsed.positionals[0] ?? 'todo-reconcile';
  if (hasFlag(parsed, 'help', 'h')) {
    printGovernanceHelp();
    return;
  }

  if (action === 'todo-reconcile' || action === 'todos') {
    await todoReconcile(parsed);
    return;
  }
  if (action === 'runtime-cleanup' || action === 'cleanup') {
    await runtimeCleanup(parsed);
    return;
  }

  throw new Error(`Unknown governance command: ${action}`);
}

async function todoReconcile(parsed: ParsedArgs): Promise<void> {
  if (booleanFlag(parsed, 'apply')) {
    throw new Error('governance todo-reconcile is dry-run only; apply mode is not implemented');
  }

  const report = await reconcilePlanningTodosWithDefaultDb({
    tenantId: stringFlag(parsed, 'tenant-id') ?? stringFlag(parsed, 'tenant'),
    projectId: stringFlag(parsed, 'project-id') ?? stringFlag(parsed, 'project'),
    includeArchived: booleanFlag(parsed, 'include-archived'),
  });
  renderTodoReconciliation(report, booleanFlag(parsed, 'json'));
}

async function runtimeCleanup(parsed: ParsedArgs): Promise<void> {
  if (booleanFlag(parsed, 'apply')) {
    throw new Error('governance runtime-cleanup is dry-run only; apply mode is not implemented');
  }

  const report = await detectRuntimeCleanupWithDefaultDb({
    staleMs: numberFlag(parsed, 'stale-ms') ?? hoursToMs(numberFlag(parsed, 'stale-hours')),
    limit: numberFlag(parsed, 'limit'),
  });
  renderRuntimeCleanup(report, booleanFlag(parsed, 'json'));
}

function renderTodoReconciliation(report: TodoReconciliationReport, json: boolean): void {
  if (json) {
    console.log(JSON.stringify({ dryRun: true, report }, null, 2));
    return;
  }

  console.log(`Governance todo reconciliation: tenant=${report.tenantId} project=${report.projectId} dryRun=true`);
  console.log(`seed=${report.seedCount} db=${report.dbCount} seedOnly=${report.seedOnly.length} dbOnly=${report.dbOnly.length} statusDrift=${report.statusDrift.length}`);
  console.log(`activeCounts backlog=${report.activeCounts.backlog} ready=${report.activeCounts.ready} in_progress=${report.activeCounts.in_progress} blocked=${report.activeCounts.blocked} done=${report.activeCounts.done} cancelled=${report.activeCounts.cancelled}`);
  printItems('Seed only', report.seedOnly.map(item => `${item.id} expected=${item.expectedStatus ?? '?'} ${item.title}`));
  printItems('DB only', report.dbOnly.map(item => `${item.id} status=${item.status ?? '?'}${item.archivedAt ? ' archived=true' : ''} ${item.title}`));
  printItems('Status drift', report.statusDrift.map(item => `${item.id} expected=${item.expectedStatus} actual=${item.actualStatus}${item.archivedAt ? ' archived=true' : ''} ${item.title}`));
  console.log('No changes were applied.');
}

function renderRuntimeCleanup(report: RuntimeCleanupReport, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(`Governance runtime cleanup: dryRun=true staleMs=${report.staleMs} generatedAt=${report.generatedAt}`);
  console.log(`taskRuns scanned=${report.taskRuns.scanned} illegalStatus=${report.taskRuns.illegalStatus.length} staleFixtureCandidates=${report.taskRuns.staleFixtureCandidates.length}`);
  printItems('Illegal task_run statuses', report.taskRuns.illegalStatus.map(item => `${item.record.id} status=${item.record.status} reason=${item.reason}`));
  printItems('Stale fixture task_runs', report.taskRuns.staleFixtureCandidates.map(item => `${item.record.id} status=${item.record.status} ageMs=${item.ageMs ?? 0} reason=${item.reason}`));
  console.log(`runSpecs scanned=${report.runSpecs.scanned} illegalStatus=${report.runSpecs.illegalStatus.length} staleFixtureCandidates=${report.runSpecs.staleFixtureCandidates.length}`);
  printItems('Illegal run_spec statuses', report.runSpecs.illegalStatus.map(item => `${item.record.id} status=${item.record.status} reason=${item.reason}`));
  printItems('Stale fixture run_specs', report.runSpecs.staleFixtureCandidates.map(item => `${item.record.id} status=${item.record.status} ageMs=${item.ageMs ?? 0} reason=${item.reason}`));
  console.log('No changes were applied.');
}

function printItems(title: string, items: string[]): void {
  if (items.length === 0) {
    console.log(`${title}: none`);
    return;
  }
  console.log(`${title}:`);
  for (const item of items.slice(0, 50)) console.log(`  ${item}`);
  if (items.length > 50) console.log(`  ... ${items.length - 50} more`);
}

function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];
  const aliases: Record<string, string> = {
    h: 'help',
  };
  const booleanFlags = new Set(['apply', 'help', 'h', 'include-archived', 'json']);

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

function hasFlag(parsed: ParsedArgs, ...keys: string[]): boolean {
  return keys.some(key => parsed.flags[key] !== undefined);
}

function booleanFlag(parsed: ParsedArgs, key: string): boolean {
  return parsed.flags[key] === true || parsed.flags[key] === 'true' || parsed.flags[key] === '1';
}

function numberFlag(parsed: ParsedArgs, key: string): number | undefined {
  const value = stringFlag(parsed, key);
  if (!value) return undefined;
  const parsedNumber = Number(value);
  if (!Number.isFinite(parsedNumber)) return undefined;
  return parsedNumber;
}

function stringFlag(parsed: ParsedArgs, key: string): string | undefined {
  const value = parsed.flags[key];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function hoursToMs(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  return value * 60 * 60 * 1000;
}

function printGovernanceHelp(): void {
  console.log(`los governance

Usage:
  los governance todo-reconcile [options]
  los governance runtime-cleanup [options]

Options:
  --tenant-id ID          Tenant id, default local
  --project-id ID         Project id, default los
  --include-archived      Include archived todos in db comparison
  --stale-hours N         Runtime cleanup stale threshold in hours, default 24
  --stale-ms N            Runtime cleanup stale threshold in milliseconds
  --limit N               Runtime cleanup scan limit, default 500
  --json                  Emit JSON report

Notes:
  governance commands are dry-run only. They report ledger/runtime drift and apply no changes.
`);
}
