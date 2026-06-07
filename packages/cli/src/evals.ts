type ParsedArgs = {
  flags: Record<string, string | boolean>;
  positionals: string[];
};

const DEFAULT_GATEWAY = 'http://127.0.0.1:8080';

export async function evalsCommand(globalArgs: string[], argv: string[]): Promise<void> {
  const parsed = mergeParsed(parseArgs(globalArgs), parseArgs(argv));
  const [action = 'list'] = parsed.positionals;
  if (hasFlag(parsed, 'help', 'h')) {
    printEvalsHelp();
    return;
  }

  if (action === 'list' || action === 'ls') {
    await listEvals(parsed);
    return;
  }
  if (action === 'record' || action === 'add') {
    await recordEval(parsed);
    return;
  }

  throw new Error(`Unknown evals command: ${action}`);
}

async function listEvals(parsed: ParsedArgs): Promise<void> {
  const params = new URLSearchParams();
  addQuery(params, 'runSpecId', stringFlag(parsed, 'run-spec-id') ?? stringFlag(parsed, 'run'));
  addQuery(params, 'sessionId', stringFlag(parsed, 'session-id') ?? stringFlag(parsed, 'session'));
  addQuery(params, 'taskRunId', stringFlag(parsed, 'task-run-id') ?? stringFlag(parsed, 'task'));
  addQuery(params, 'provider', stringFlag(parsed, 'provider'));
  addQuery(params, 'model', stringFlag(parsed, 'model'));
  addQuery(params, 'success', stringFlag(parsed, 'success'));
  addQuery(params, 'verificationStatus', stringFlag(parsed, 'verification-status'));
  addQuery(params, 'failureClass', stringFlag(parsed, 'failure-class'));
  addQuery(params, 'limit', stringFlag(parsed, 'limit'));
  const suffix = params.toString() ? `?${params.toString()}` : '';
  const value = await getJson(`${gatewayUrl(parsed)}/run-evals${suffix}`);
  renderEvalList(value, booleanFlag(parsed, 'json'));
}

async function recordEval(parsed: ParsedArgs): Promise<void> {
  const runSpecId = stringFlag(parsed, 'run-spec-id') ?? stringFlag(parsed, 'run');
  if (!runSpecId) throw new Error('evals record requires --run or --run-spec-id');
  const success = parseBooleanFlag(parsed, 'success');
  if (success === undefined) throw new Error('evals record requires --success true|false');
  const payload: Record<string, unknown> = {
    id: stringFlag(parsed, 'id'),
    runSpecId,
    sessionId: stringFlag(parsed, 'session-id') ?? stringFlag(parsed, 'session'),
    taskRunId: stringFlag(parsed, 'task-run-id') ?? stringFlag(parsed, 'task'),
    provider: stringFlag(parsed, 'provider'),
    model: stringFlag(parsed, 'model'),
    success,
    latencyMs: numberFlag(parsed, 'latency-ms'),
    retryCount: numberFlag(parsed, 'retry-count'),
    toolErrorCount: numberFlag(parsed, 'tool-error-count'),
    verificationStatus: stringFlag(parsed, 'verification-status'),
    modelCost: numberFlag(parsed, 'model-cost'),
    userFeedback: stringFlag(parsed, 'user-feedback'),
    failureClass: stringFlag(parsed, 'failure-class'),
    summary: jsonFlag(parsed, 'summary-json'),
  };
  removeUndefined(payload);
  const value = await sendJson(`${gatewayUrl(parsed)}/run-evals`, payload);
  renderEvalRecord(value, booleanFlag(parsed, 'json'));
}

async function getJson(url: string): Promise<unknown> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${await response.text()}`);
  return await response.json() as unknown;
}

async function sendJson(url: string, payload: Record<string, unknown>): Promise<unknown> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${text}`);
  return text ? JSON.parse(text) as unknown : {};
}

function renderEvalList(value: unknown, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(value));
    return;
  }
  const evals = asArray(asRecord(value).evals);
  console.log(`Run evals: ${evals.length}`);
  for (const item of evals) {
    const record = asRecord(item);
    const provider = record.provider ? ` provider=${String(record.provider)}${record.model ? `:${String(record.model)}` : ''}` : '';
    const failure = record.failureClass ? ` failure=${String(record.failureClass)}` : '';
    console.log(`  ${String(record.id ?? '?')} run=${String(record.runSpecId ?? '?')} success=${String(record.success ?? '?')} verification=${String(record.verificationStatus ?? '?')}${provider}${failure}`);
  }
}

function renderEvalRecord(value: unknown, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(value));
    return;
  }
  const record = asRecord(asRecord(value).eval);
  console.log(`run_eval=${String(record.id ?? '?')} run=${String(record.runSpecId ?? '?')} success=${String(record.success ?? '?')} verification=${String(record.verificationStatus ?? '?')}`);
  console.log(`retry_count=${String(record.retryCount ?? 0)} tool_error_count=${String(record.toolErrorCount ?? 0)} failure_class=${String(record.failureClass ?? '')}`);
}

function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];
  const aliases: Record<string, string> = {
    g: 'gateway',
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

function parseBooleanFlag(parsed: ParsedArgs, key: string): boolean | undefined {
  const value = parsed.flags[key];
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return undefined;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  return undefined;
}

function numberFlag(parsed: ParsedArgs, key: string): number | undefined {
  const value = stringFlag(parsed, key);
  if (value === undefined) return undefined;
  const parsedNumber = Number(value);
  if (!Number.isFinite(parsedNumber)) return undefined;
  return parsedNumber;
}

function jsonFlag(parsed: ParsedArgs, key: string): Record<string, unknown> | undefined {
  const value = stringFlag(parsed, key);
  if (!value) return undefined;
  const parsedValue = JSON.parse(value) as unknown;
  return asRecord(parsedValue);
}

function hasFlag(parsed: ParsedArgs, ...keys: string[]): boolean {
  return keys.some(key => parsed.flags[key] !== undefined);
}

function addQuery(params: URLSearchParams, key: string, value: string | undefined): void {
  if (value) params.set(key, value);
}

function removeUndefined(value: Record<string, unknown>): void {
  for (const key of Object.keys(value)) {
    if (value[key] === undefined) delete value[key];
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function printEvalsHelp(): void {
  console.log(`los evals

Record and list run quality evals.

Usage:
  los evals list [--run RUN_ID] [--session SESSION_ID] [--success true|false] [--json]
  los evals record --run RUN_ID --success true|false [options]

Record options:
  --id ID
  --session SESSION_ID
  --task TASK_RUN_ID
  --provider NAME
  --model NAME
  --latency-ms N
  --retry-count N
  --tool-error-count N
  --verification-status unknown|not_required|pending|succeeded|failed|skipped
  --model-cost N
  --user-feedback TEXT
  --failure-class CLASS
  --summary-json JSON
`);
}
