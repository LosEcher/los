import { requestCliJson, resolveCliRequestAuth } from './cli-http.js';

type ParsedArgs = {
  flags: Record<string, string | boolean>;
  positionals: string[];
};

const DEFAULT_GATEWAY = 'http://127.0.0.1:8080';

export async function usageCommand(globalArgs: string[], argv: string[]): Promise<void> {
  const parsed = mergeParsed(parseArgs(globalArgs), parseArgs(argv));
  if (hasFlag(parsed, 'help', 'h')) {
    printUsageHelp();
    return;
  }

  const params = new URLSearchParams();
  addQuery(params, 'from', stringFlag(parsed, 'from'));
  addQuery(params, 'to', stringFlag(parsed, 'to'));
  addQuery(params, 'provider', stringFlag(parsed, 'provider') ?? stringFlag(parsed, 'p'));
  addQuery(params, 'model', stringFlag(parsed, 'model'));
  // Convenience: --days N → from = now - N days
  const days = numberFlag(parsed, 'days');
  if (days !== undefined && !stringFlag(parsed, 'from')) {
    const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    params.set('from', from);
  }

  const suffix = params.toString() ? `?${params.toString()}` : '';
  const value = await getJson(`${gatewayUrl(parsed)}/usage/summary${suffix}`, parsed);
  if (booleanFlag(parsed, 'json')) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }
  renderUsageSummary(value);
}

function renderUsageSummary(value: unknown): void {
  const data = asRecord(value);
  const totals = asRecord(data.totals);
  console.log(`usage evidence=${String(data.evidenceClass ?? 'los_runtime')}`);
  console.log(`  window ${String(data.from ?? '')} → ${String(data.to ?? '')}`);
  console.log(
    `  responses=${fmtNum(totals.modelResponseCount)} sessions=${fmtNum(totals.sessionCount)} ` +
    `prompt=${fmtNum(totals.promptTokens)} completion=${fmtNum(totals.completionTokens)} ` +
    `cache_hit=${fmtNum(totals.cacheHitTokens)} cache_miss=${fmtNum(totals.cacheMissTokens)}`,
  );
  console.log(
    `  cost_usd=${fmtCost(totals.estimatedCostUsd)} cache_savings_usd=${fmtCost(totals.cacheSavingsUsd)} ` +
    `cache_hit_rate=${fmtRate(totals.cacheHitRate)}`,
  );

  const byProviderModel = asArray(data.byProviderModel);
  if (byProviderModel.length > 0) {
    console.log('  by provider/model:');
    for (const row of byProviderModel.slice(0, 20)) {
      const r = asRecord(row);
      console.log(
        `    ${String(r.provider)}:${String(r.model)} ` +
        `n=${fmtNum(r.modelResponseCount)} cost=$${fmtCost(r.estimatedCostUsd)} ` +
        `prompt=${fmtNum(r.promptTokens)} completion=${fmtNum(r.completionTokens)} ` +
        `cache_hit=${fmtNum(r.cacheHitTokens)}`,
      );
    }
  }

  const callTelemetry = asArray(data.callTelemetry);
  if (callTelemetry.length > 0) {
    console.log('  call telemetry (latency / usage fill):');
    for (const row of callTelemetry.slice(0, 15)) {
      const r = asRecord(row);
      console.log(
        `    ${String(r.provider)}:${String(r.model)} ` +
        `calls=${fmtNum(r.callCount)} errors=${fmtNum(r.errorCount)} ` +
        `avg_ms=${fmtNum(r.avgDurationMs)} usage_fill=${fmtRate(r.usageFillRate)}`,
      );
    }
  }
}

function printUsageHelp(): void {
  console.log(`los usage

Show L1 runtime usage cube (los-owned model.response + provider_call_telemetry).
Does not include external Claude Code / Codex local history.

Options:
  --days N           Look back N days (default gateway window is 7d)
  --from ISO         Inclusive lower bound
  --to ISO           Exclusive upper bound
  --provider, -p     Filter provider
  --model            Filter model
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
  return {
    flags: { ...a.flags, ...b.flags },
    positionals: [...a.positionals, ...b.positionals],
  };
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

function numberFlag(parsed: ParsedArgs, name: string): number | undefined {
  const raw = stringFlag(parsed, name);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
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
  if (!Number.isFinite(n)) return '0';
  return n.toFixed(6);
}

function fmtRate(value: unknown): string {
  if (value === null || value === undefined) return 'n/a';
  const n = Number(value);
  if (!Number.isFinite(n)) return 'n/a';
  return `${(n * 100).toFixed(1)}%`;
}
