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
  if (action === 'summary' || action === 'summarize') {
    await summarizeEvals(parsed);
    return;
  }
  if (action === 'compare') {
    await compareEvals(parsed);
    return;
  }
  if (action === 'record' || action === 'add') {
    await recordEval(parsed);
    return;
  }

  throw new Error(`Unknown evals command: ${action}`);
}

async function listEvals(parsed: ParsedArgs): Promise<void> {
  const params = buildEvalQuery(parsed);
  const suffix = params.toString() ? `?${params.toString()}` : '';
  const value = await getJson(`${gatewayUrl(parsed)}/run-evals${suffix}`);
  renderEvalList(value, booleanFlag(parsed, 'json'));
}

async function summarizeEvals(parsed: ParsedArgs): Promise<void> {
  const params = buildEvalQuery(parsed);
  addQuery(params, 'createdFrom', stringFlag(parsed, 'created-from'));
  addQuery(params, 'createdTo', stringFlag(parsed, 'created-to'));
  const suffix = params.toString() ? `?${params.toString()}` : '';
  const value = await getJson(`${gatewayUrl(parsed)}/run-evals/summary${suffix}`);
  renderEvalSummary(value, booleanFlag(parsed, 'json'));
}

async function compareEvals(parsed: ParsedArgs): Promise<void> {
  const params = buildEvalQuery(parsed);
  const baselineFrom = stringFlag(parsed, 'baseline-from');
  const baselineTo = stringFlag(parsed, 'baseline-to');
  const candidateFrom = stringFlag(parsed, 'candidate-from');
  const candidateTo = stringFlag(parsed, 'candidate-to');
  if (!baselineFrom || !baselineTo || !candidateFrom || !candidateTo) {
    throw new Error('evals compare requires --baseline-from, --baseline-to, --candidate-from, and --candidate-to');
  }
  addQuery(params, 'baselineFrom', baselineFrom);
  addQuery(params, 'baselineTo', baselineTo);
  addQuery(params, 'candidateFrom', candidateFrom);
  addQuery(params, 'candidateTo', candidateTo);
  const suffix = params.toString() ? `?${params.toString()}` : '';
  const value = await getJson(`${gatewayUrl(parsed)}/run-evals/compare${suffix}`);
  renderEvalComparison(value, booleanFlag(parsed, 'json'));
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

function renderEvalSummary(value: unknown, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(value));
    return;
  }
  const summary = asRecord(value);
  const totals = asRecord(summary.totals);
  const count = numberValue(totals.count);
  const successRate = numberValue(totals.successRate);
  console.log(`Run eval summary: count=${count} success_rate=${formatPercent(successRate)} failures=${String(totals.failureCount ?? 0)}`);
  console.log(`  avg_latency_ms=${formatOptionalNumber(totals.averageLatencyMs)} avg_retry_count=${formatOptionalNumber(totals.averageRetryCount)} tool_errors=${String(totals.toolErrorCount ?? 0)} model_cost=${formatOptionalNumber(totals.modelCost)}`);
  printGroups('failure_classes', asArray(summary.byFailureClass));
  printGroups('verification_status', asArray(summary.byVerificationStatus));
  printGroups('provider_models', asArray(summary.byProviderModel));
}

function renderEvalComparison(value: unknown, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(value));
    return;
  }
  const comparison = asRecord(value);
  const baseline = asRecord(asRecord(comparison.baseline).totals);
  const candidate = asRecord(asRecord(comparison.candidate).totals);
  const delta = asRecord(comparison.delta);
  console.log(`Run eval comparison: baseline=${String(baseline.count ?? 0)} candidate=${String(candidate.count ?? 0)}`);
  console.log(`  success_rate ${formatPercent(numberValue(baseline.successRate))} -> ${formatPercent(numberValue(candidate.successRate))} delta=${formatSignedPercent(numberValue(delta.successRate))}`);
  console.log(`  failures ${String(baseline.failureCount ?? 0)} -> ${String(candidate.failureCount ?? 0)} delta=${formatSignedNumber(delta.failureCount)}`);
  console.log(`  avg_latency_ms ${formatOptionalNumber(baseline.averageLatencyMs)} -> ${formatOptionalNumber(candidate.averageLatencyMs)} delta=${formatSignedNumber(delta.averageLatencyMs)}`);
  console.log(`  tool_errors ${String(baseline.toolErrorCount ?? 0)} -> ${String(candidate.toolErrorCount ?? 0)} delta=${formatSignedNumber(delta.toolErrorCount)}`);
}

function printGroups(label: string, groups: unknown[]): void {
  if (groups.length === 0) return;
  console.log(`  ${label}:`);
  for (const item of groups.slice(0, 10)) {
    const group = asRecord(item);
    console.log(`    ${String(group.key ?? '?')} count=${String(group.count ?? 0)} success_rate=${formatPercent(numberValue(group.successRate))}`);
  }
}

function buildEvalQuery(parsed: ParsedArgs): URLSearchParams {
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
  return params;
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

function numberValue(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function formatSignedPercent(value: number): string {
  const sign = value > 0 ? '+' : '';
  return `${sign}${formatPercent(value)}`;
}

function formatOptionalNumber(value: unknown): string {
  if (value === undefined || value === null || value === '') return 'n/a';
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed.toFixed(2).replace(/\.00$/, '') : 'n/a';
}

function formatSignedNumber(value: unknown): string {
  if (value === undefined || value === null || value === '') return 'n/a';
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 'n/a';
  const formatted = parsed.toFixed(2).replace(/\.00$/, '');
  return parsed > 0 ? `+${formatted}` : formatted;
}

function printEvalsHelp(): void {
  console.log(`los evals

Record and list run quality evals.

Usage:
  los evals list [--run RUN_ID] [--session SESSION_ID] [--success true|false] [--json]
  los evals summary [--created-from ISO] [--created-to ISO] [--json]
  los evals compare --baseline-from ISO --baseline-to ISO --candidate-from ISO --candidate-to ISO [--json]
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

Summary options:
  --created-from ISO
  --created-to ISO

Compare options:
  --baseline-from ISO
  --baseline-to ISO
  --candidate-from ISO
  --candidate-to ISO
`);
}
