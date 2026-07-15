/**
 * los tasks dead-letter — CLI commands for inspecting and managing the dead letter queue.
 *
 * Usage:
 *   los tasks dead-letter ls [--acknowledged] [--reason REASON] [--limit N] [--json]
 *   los tasks dead-letter summary [--json]
 *   los tasks dead-letter ack <id>
 *   los tasks dead-letter retry <id>
 */

import { resolveClientPath } from './client-path.js';

type ParsedArgs = {
  flags: Record<string, string | boolean>;
  positionals: string[];
};

const DEFAULT_GATEWAY = 'http://127.0.0.1:8080';

export async function deadLetterCommand(globalArgs: string[], argv: string[]): Promise<void> {
  const parsed = mergeParsed(parseArgs(globalArgs), parseArgs(argv));
  const [action = 'ls'] = parsed.positionals;
  if (hasFlag(parsed, 'help', 'h')) {
    printDeadLetterHelp();
    return;
  }

  if (action === 'ls' || action === 'list') {
    await listDeadLetter(parsed);
    return;
  }
  if (action === 'ack' || action === 'acknowledge') {
    await ackDeadLetter(parsed);
    return;
  }
  if (action === 'summary' || action === 'stats') {
    await summarizeDeadLetters(parsed);
    return;
  }
  if (action === 'retry' || action === 'requeue') {
    await retryDeadLetter(parsed);
    return;
  }

  throw new Error(`Unknown dead-letter command: ${action}`);
}

async function listDeadLetter(parsed: ParsedArgs): Promise<void> {
  const params = new URLSearchParams();
  if (booleanFlag(parsed, 'acknowledged')) params.set('acknowledged', 'true');
  const reason = stringFlag(parsed, 'reason');
  if (reason) params.set('reason', reason);
  const limit = stringFlag(parsed, 'limit');
  if (limit) params.set('limit', limit);
  const suffix = params.toString() ? `?${params.toString()}` : '';
  const data = await getJson(`${gatewayUrl(parsed)}/tasks/dead-letter${suffix}`, parsed);
  const events = asArray(asRecord(data).events ?? data);
  if (booleanFlag(parsed, 'json')) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  console.log(`Dead letter events: ${events.length}`);
  for (const event of events) {
    const e = asRecord(event);
    const ack = e.acknowledgedAt ? ' [acked]' : '';
    const retry = e.requeuedTaskRunId ? ` requeued=${String(e.requeuedTaskRunId)}` : '';
    console.log(`  ${String(e.id ?? '?')} reason=${String(e.reason ?? '?')} task=${String(e.taskRunId ?? '?')}${retry}${ack}`);
    const err = e.originalError;
    if (err) console.log(`    error: ${String(err).slice(0, 120)}`);
  }
}

async function ackDeadLetter(parsed: ParsedArgs): Promise<void> {
  const [id] = parsed.positionals.slice(1);
  if (!id) throw new Error('dead-letter ack requires an event id');
  const response = await sendJson(`${gatewayUrl(parsed)}/tasks/dead-letter/${id}/ack`, 'POST', null, parsed);
  if (booleanFlag(parsed, 'json')) {
    console.log(JSON.stringify(response, null, 2));
    return;
  }
  const r = asRecord(response);
  console.log(`Acknowledged: ${String(r.id ?? id)}`);
}

async function summarizeDeadLetters(parsed: ParsedArgs): Promise<void> {
  const data = asRecord(await getJson(`${gatewayUrl(parsed)}/tasks/dead-letter/summary`, parsed));
  if (booleanFlag(parsed, 'json')) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  console.log(`Dead letter summary: total=${String(data.total ?? 0)} unacknowledged=${String(data.unacknowledged ?? 0)} acknowledged=${String(data.acknowledged ?? 0)}`);
  console.log(`  retryable=${String(data.requeueEligible ?? 0)} requeued=${String(data.requeued ?? 0)} oldest=${String(data.oldestUnacknowledgedAt ?? 'none')}`);
  const byReason = asRecord(data.byReason);
  for (const reason of ['lease_expired', 'max_attempts', 'unrecoverable_error']) {
    const item = asRecord(byReason[reason]);
    console.log(`  ${reason}: total=${String(item.total ?? 0)} unacknowledged=${String(item.unacknowledged ?? 0)} requeued=${String(item.requeued ?? 0)}`);
  }
}

async function retryDeadLetter(parsed: ParsedArgs): Promise<void> {
  const [id] = parsed.positionals.slice(1);
  if (!id) throw new Error('dead-letter retry requires an event id');
  const response = await sendJson(`${gatewayUrl(parsed)}/tasks/dead-letter/${id}/retry`, 'POST', null, parsed);
  if (booleanFlag(parsed, 'json')) {
    console.log(JSON.stringify(response, null, 2));
    return;
  }
  const result = asRecord(response);
  console.log(`Requeued: event=${id} task=${String(result.taskRunId ?? '?')}`);
}

function printDeadLetterHelp(): void {
  console.log(`los tasks dead-letter

Inspect and manage the dead letter queue.

Usage:
  los tasks dead-letter ls [--acknowledged] [--reason REASON] [--limit N] [--json]
  los tasks dead-letter summary [--json]
  los tasks dead-letter ack <id>
  los tasks dead-letter retry <id> [--operator-token TOKEN]`);
}

// ── HTTP helpers ───────────────────────────────────────────

async function getJson(url: string, parsed: ParsedArgs): Promise<unknown> {
  const headers: Record<string, string> = {};
  const token = authToken(parsed);
  if (token) headers['x-los-auth-token'] = token;
  const operatorToken = stringFlag(parsed, 'operator-token') ?? process.env.LOS_OPERATOR_TOKEN;
  if (operatorToken) headers['x-los-operator-token'] = operatorToken;
  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${await response.text()}`);
  return await response.json() as unknown;
}

async function sendJson(url: string, method: string, payload: unknown, parsed: ParsedArgs): Promise<unknown> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = authToken(parsed);
  if (token) headers['x-los-auth-token'] = token;
  const response = await fetch(url, {
    method,
    headers,
    body: payload ? JSON.stringify(payload) : undefined,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${text}`);
  return text ? JSON.parse(text) as unknown : {};
}

// ── ParsedArgs helpers ─────────────────────────────────────

function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];
  const aliases: Record<string, string> = { g: 'gateway', h: 'help', r: 'reason', n: 'limit', t: 'auth-token' };
  const boolFlags = new Set(['help', 'h', 'json', 'acknowledged']);

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--') { positionals.push(...argv.slice(i + 1)); break; }
    if (token.startsWith('--')) {
      const [key, val] = token.slice(2).split('=', 2);
      if (val !== undefined) { flags[key] = val; continue; }
      if (boolFlags.has(key)) { flags[key] = true; continue; }
      const next = argv[i + 1];
      flags[key] = next !== undefined && !next.startsWith('-') ? (i += 1, next) : true;
      continue;
    }
    if (/^-[a-zA-Z]$/.test(token)) {
      const key = aliases[token.slice(1)] ?? token.slice(1);
      if (boolFlags.has(key)) { flags[key] = true; continue; }
      const next = argv[i + 1];
      flags[key] = next !== undefined && !next.startsWith('-') ? (i += 1, next) : true;
      continue;
    }
    positionals.push(token);
  }
  return { flags, positionals };
}

function mergeParsed(a: ParsedArgs, b: ParsedArgs): ParsedArgs {
  return { flags: { ...a.flags, ...b.flags }, positionals: [...a.positionals, ...b.positionals] };
}

function stringFlag(p: ParsedArgs, key: string) { const v = p.flags[key]; return typeof v === 'string' && v.trim() ? v.trim() : undefined; }
function booleanFlag(p: ParsedArgs, key: string) { return p.flags[key] === true || p.flags[key] === 'true' || p.flags[key] === '1'; }
function hasFlag(p: ParsedArgs, ...keys: string[]) { return keys.some(k => p.flags[k] !== undefined); }
function gatewayUrl(p: ParsedArgs) { const raw = stringFlag(p, 'gateway') ?? stringFlag(p, 'g') ?? DEFAULT_GATEWAY; return raw.replace(/\/+$/, ''); }
function authToken(p: ParsedArgs) { return stringFlag(p, 'auth-token') ?? stringFlag(p, 't') ?? process.env.LOS_AUTH_TOKEN; }
function asRecord(v: unknown) { return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}; }
function asArray(v: unknown) { return Array.isArray(v) ? v : []; }
