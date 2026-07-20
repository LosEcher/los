import { readFile } from 'node:fs/promises';
import { requestCliJson, resolveCliRequestAuth } from './cli-http.js';
import { resolveClientPath } from './client-path.js';

type ParsedArgs = {
  flags: Record<string, string | boolean>;
  positionals: string[];
};

const DEFAULT_GATEWAY = 'http://127.0.0.1:8080';

export async function externalSummariesCommand(globalArgs: string[], argv: string[]): Promise<void> {
  const parsed = mergeParsed(parseArgs(globalArgs), parseArgs(argv));
  const [action = 'list'] = parsed.positionals;
  if (hasFlag(parsed, 'help', 'h')) {
    printExternalSummariesHelp();
    return;
  }

  if (action === 'list' || action === 'ls') {
    await listExternalSummaries(parsed);
    return;
  }
  if (action === 'import') {
    await importExternalSummary(parsed);
    return;
  }

  throw new Error(`Unknown external-summaries command: ${action}`);
}

async function listExternalSummaries(parsed: ParsedArgs): Promise<void> {
  const params = new URLSearchParams();
  addQuery(params, 'tool', stringFlag(parsed, 'tool'));
  addQuery(params, 'sourceKind', stringFlag(parsed, 'source-kind') ?? stringFlag(parsed, 'sourceKind'));
  addQuery(params, 'limit', stringFlag(parsed, 'limit'));
  if (booleanFlag(parsed, 'include-expired')) params.set('includeExpired', 'true');
  const suffix = params.toString() ? `?${params.toString()}` : '';
  const value = await getJson(`${gatewayUrl(parsed)}/external-summaries${suffix}`, parsed);
  renderExternalSummaryList(value, booleanFlag(parsed, 'json'));
}

async function importExternalSummary(parsed: ParsedArgs): Promise<void> {
  const file = stringFlag(parsed, 'file') ?? stringFlag(parsed, 'f');
  if (!file) throw new Error('external-summaries import requires --file');
  const payload = JSON.parse(await readFile(resolveClientPath(file), 'utf-8')) as Record<string, unknown>;
  const response = await sendJson(`${gatewayUrl(parsed)}/external-summaries`, payload, parsed);
  renderExternalSummaryImport(response, booleanFlag(parsed, 'json'));
}

async function getJson(url: string, parsed: ParsedArgs): Promise<unknown> {
  return await requestCliJson(url, { auth: resolveCliRequestAuth(parsed.flags) });
}

async function sendJson(url: string, payload: Record<string, unknown>, parsed: ParsedArgs): Promise<unknown> {
  return await requestCliJson(url, {
    method: 'POST',
    auth: resolveCliRequestAuth(parsed.flags),
    json: true,
    body: JSON.stringify(payload),
  });
}

function renderExternalSummaryList(value: unknown, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(value));
    return;
  }
  const summaries = asArray(asRecord(value).summaries);
  console.log(`External summaries: ${summaries.length}`);
  for (const item of summaries) {
    const record = asRecord(item);
    const source = asRecord(record.source);
    console.log(`  ${String(record.id ?? '?')} tool=${String(record.tool ?? '?')} source=${String(source.kind ?? '?')}:${String(source.sourceRef ?? '?')}`);
  }
}

function renderExternalSummaryImport(value: unknown, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(value));
    return;
  }
  const summary = asRecord(asRecord(value).summary);
  const source = asRecord(summary.source);
  console.log(`external_summary=${String(summary.id ?? '?')} tool=${String(summary.tool ?? '?')} source=${String(source.kind ?? '?')}:${String(source.sourceRef ?? '?')}`);
  console.log(`redaction=${String(asRecord(summary.redaction).status ?? '?')} replacements=${String(asRecord(summary.redaction).replacements ?? 0)}`);
}

function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];
  const aliases: Record<string, string> = {
    f: 'file',
    g: 'gateway',
    h: 'help',
    t: 'auth-token',
  };
  const booleanFlags = new Set(['help', 'h', 'json', 'include-expired']);

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

function gatewayUrl(parsed: ParsedArgs): string {
  const raw = stringFlag(parsed, 'gateway') ?? stringFlag(parsed, 'g') ?? DEFAULT_GATEWAY;
  return raw.replace(/\/+$/, '');
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

function addQuery(params: URLSearchParams, key: string, value: string | undefined): void {
  if (value) params.set(key, value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function printExternalSummariesHelp(): void {
  console.log(`los external-summaries

Import and list redacted external tool summaries.

Usage:
  los external-summaries list [--tool NAME] [--source-kind KIND] [--json]
  los external-summaries import --file summary.json [--json]

Options:
  --gateway, -g URL
  --auth-token, -t TOKEN  Gateway token, default LOS_AUTH_TOKEN

The import payload must be a bounded summary accepted by the external summary
adapter. Raw prompts, stdout, stderr, transcripts, cookies, tokens, and auth
snapshots are rejected before storage.
`);
}
