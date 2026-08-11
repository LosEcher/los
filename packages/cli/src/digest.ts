import { requestCliJson, resolveCliRequestAuth } from './cli-http.js';

type ParsedArgs = {
  flags: Record<string, string | boolean>;
  positionals: string[];
};

const DEFAULT_GATEWAY = 'http://127.0.0.1:8080';

export async function digestCommand(globalArgs: string[], argv: string[]): Promise<void> {
  const parsed = mergeParsed(parseArgs(globalArgs), parseArgs(argv));
  if (hasFlag(parsed, 'help', 'h')) {
    printDigestHelp();
    return;
  }

  const params = new URLSearchParams();
  const day = stringFlag(parsed, 'day') ?? parsed.positionals[0];
  addQuery(params, 'day', day === 'yesterday' ? undefined : day);
  addQuery(params, 'projectId', stringFlag(parsed, 'project') ?? stringFlag(parsed, 'project-id'));
  addQuery(params, 'tenantId', stringFlag(parsed, 'tenant') ?? stringFlag(parsed, 'tenant-id'));

  const suffix = params.toString() ? `?${params.toString()}` : '';
  const base = gatewayUrl(parsed);

  if (booleanFlag(parsed, 'push')) {
    const body: Record<string, string> = {};
    if (day && day !== 'yesterday') body.day = day;
    const projectId = stringFlag(parsed, 'project') ?? stringFlag(parsed, 'project-id');
    const tenantId = stringFlag(parsed, 'tenant') ?? stringFlag(parsed, 'tenant-id');
    if (projectId) body.projectId = projectId;
    if (tenantId) body.tenantId = tenantId;
    const value = await postJson(`${base}/ops/daily-digest/push`, body, parsed);
    if (booleanFlag(parsed, 'json')) {
      console.log(JSON.stringify(value, null, 2));
      return;
    }
    const rec = asRecord(value);
    console.log(
      `digest push day=${String(rec.day ?? '')} eventEmitted=${String(rec.eventEmitted)} `
      + `enabled=${fmtNum(rec.enabledCount)}`,
    );
    if (typeof rec.messagePreview === 'string') {
      console.log(rec.messagePreview);
    }
    return;
  }

  const value = await getJson(`${base}/ops/daily-digest${suffix}`, parsed);
  if (booleanFlag(parsed, 'json')) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }
  renderDigest(value);
}

function renderDigest(value: unknown): void {
  const data = asRecord(value);
  const schedule = asRecord(data.schedule);
  const totals = asRecord(schedule.runTotals);
  const usage = asRecord(asRecord(data.usage).totals);
  console.log(`digest evidence=${String(data.evidenceClass ?? 'los_runtime')} day=${String(data.day ?? '')}`);
  console.log(`  window ${String(data.from ?? '')} → ${String(data.to ?? '')}`);
  for (const line of asArray(data.highlights)) {
    console.log(`  • ${String(line)}`);
  }
  console.log(
    `  schedule enabled=${fmtNum(schedule.enabledCount)} runs=${fmtNum(totals.runCount)} `
    + `ok=${fmtNum(totals.succeeded)} fail=${fmtNum(totals.failed)} cancel=${fmtNum(totals.cancelled)}`,
  );
  console.log(
    `  usage responses=${fmtNum(usage.modelResponseCount)} cost=$${fmtCost(usage.estimatedCostUsd)} `
    + `cache_hit_rate=${fmtRate(usage.cacheHitRate)}`,
  );

  const recs = asArray(data.cadenceRecommendations);
  if (recs.length > 0) {
    console.log('  cadence / policy recommendations:');
    for (const raw of recs) {
      const r = asRecord(raw);
      const recExpr = r.recommendedExpression ? ` → ${String(r.recommendedExpression)}` : '';
      console.log(
        `    [${String(r.severity)}/${String(r.action)}] ${String(r.title)} `
        + `(${String(r.currentExpression)}${recExpr})`,
      );
      console.log(`      ${String(r.rationale)}`);
    }
  }

  const rows = asArray(schedule.bySchedule).slice(0, 12);
  if (rows.length > 0) {
    console.log('  by schedule:');
    for (const raw of rows) {
      const r = asRecord(raw);
      console.log(
        `    ${String(r.title)} [${String(r.status)}] ${String(r.expression)} `
        + `n=${fmtNum(r.runCount)} ok=${fmtNum(r.succeeded)} cancel=${fmtNum(r.cancelled)} `
        + `fail=${fmtNum(r.failed)}`,
      );
    }
  }
}

function printDigestHelp(): void {
  console.log(`los digest

Daily Execution Digest (schedules + usage + quality + cadence recommendations).

Options:
  --day YYYY-MM-DD   UTC day (default: yesterday)
  --project ID       Quality snapshot project (default: los)
  --push             Emit ops.daily_digest for WeChat/SSE channels
  --json             Raw JSON
  --gateway, -g URL  Gateway URL
`);
}

function gatewayUrl(parsed: ParsedArgs): string {
  return stringFlag(parsed, 'gateway')
    ?? stringFlag(parsed, 'g')
    ?? process.env.LOS_GATEWAY_URL
    ?? DEFAULT_GATEWAY;
}

async function getJson(url: string, parsed: ParsedArgs): Promise<unknown> {
  return requestCliJson(url, { auth: resolveCliRequestAuth(parsed.flags) });
}

async function postJson(
  url: string,
  body: Record<string, string>,
  parsed: ParsedArgs,
): Promise<unknown> {
  return requestCliJson(url, {
    method: 'POST',
    auth: resolveCliRequestAuth(parsed.flags),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq > 0) {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1);
        continue;
      }
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('-')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
      continue;
    }
    if (arg.startsWith('-') && arg.length === 2) {
      const key = arg.slice(1);
      const next = argv[i + 1];
      if (next && !next.startsWith('-')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
      continue;
    }
    positionals.push(arg);
  }
  return { flags, positionals };
}

function mergeParsed(a: ParsedArgs, b: ParsedArgs): ParsedArgs {
  return { flags: { ...a.flags, ...b.flags }, positionals: [...a.positionals, ...b.positionals] };
}

function hasFlag(parsed: ParsedArgs, ...names: string[]): boolean {
  return names.some(name => Boolean(parsed.flags[name]));
}

function booleanFlag(parsed: ParsedArgs, name: string): boolean {
  return parsed.flags[name] === true || parsed.flags[name] === 'true';
}

function stringFlag(parsed: ParsedArgs, name: string): string | undefined {
  const value = parsed.flags[name];
  return typeof value === 'string' ? value : undefined;
}

function addQuery(params: URLSearchParams, key: string, value: string | undefined): void {
  if (value) params.set(key, value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function fmtNum(value: unknown): string {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) return '0';
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

function fmtCost(value: unknown): string {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n.toFixed(6) : '0';
}

function fmtRate(value: unknown): string {
  if (value === null || value === undefined) return 'n/a';
  const n = Number(value);
  if (!Number.isFinite(n)) return 'n/a';
  return `${(n * 100).toFixed(1)}%`;
}
