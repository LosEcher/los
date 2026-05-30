import {
  createCompatibilityRunSpecs,
  parseCompatibilityTargets,
  selectCompatibilityProbes,
  summarizeCompatibilityEvents,
  type CompatibilityRunSpec,
  type CompatibilityRunSummary,
  type CompatibilitySseEvent,
} from '@los/agent/compat-harness';

type JsonRecord = Record<string, unknown>;

type ParsedArgs = {
  flags: Record<string, string | boolean>;
  positionals: string[];
};

const DEFAULT_GATEWAY = 'http://127.0.0.1:8080';

export async function compatCommand(globalArgs: string[], argv: string[]): Promise<void> {
  const parsed = mergeParsed(parseArgs(globalArgs), parseArgs(argv));
  if (hasFlag(parsed, 'help', 'h')) {
    printCompatHelp();
    return;
  }

  const targetValues = [
    ...csvFlag(parsed, 'target'),
    ...parsed.positionals.flatMap(splitCsv),
  ];
  const probeValues = [
    ...csvFlag(parsed, 'probe'),
    ...csvFlag(parsed, 'probes'),
  ];
  const targets = parseCompatibilityTargets(targetValues);
  const probes = selectCompatibilityProbes(probeValues);
  const specs = createCompatibilityRunSpecs({
    targets,
    probes,
    workspaceRoot: stringFlag(parsed, 'workspace-root') ?? stringFlag(parsed, 'workspace') ?? stringFlag(parsed, 'w'),
    tracePrefix: stringFlag(parsed, 'trace-prefix'),
    dedupePrefix: stringFlag(parsed, 'dedupe-prefix'),
    maxLoops: numberFlag(parsed, 'max-loops'),
  });
  const json = booleanFlag(parsed, 'json');
  const execute = booleanFlag(parsed, 'execute');
  const timeoutMs = numberFlag(parsed, 'timeout-ms');

  if (!execute) {
    renderCompatibilityPlan(specs, json);
    return;
  }

  const gateway = gatewayUrl(parsed);
  if (!json) {
    console.error(`los compat -> ${gateway}`);
    console.error(`runs=${specs.length}`);
  }

  const summaries: CompatibilityRunSummary[] = [];
  for (const spec of specs) {
    if (!json) console.log(`[compat:start] ${spec.id}`);
    const summary = await executeCompatibilitySpec(gateway, spec, timeoutMs);
    summaries.push(summary);
    renderCompatibilitySummary(summary, json);
  }

  if (json) {
    console.log(JSON.stringify({ event: 'compat.summary', data: { summaries } }));
  }
}

async function executeCompatibilitySpec(
  gateway: string,
  spec: CompatibilityRunSpec,
  timeoutMs: number | undefined,
): Promise<CompatibilityRunSummary> {
  const payload: JsonRecord = {
    ...spec.request,
    timeoutMs,
  };
  removeUndefined(payload);

  const response = await fetch(`${gateway}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok || !response.body) {
    throw new Error(`${spec.id}: ${response.status} ${response.statusText}: ${await response.text()}`);
  }

  const events: CompatibilitySseEvent[] = [];
  await readSse(response.body, (event, data) => {
    events.push({ event, data });
  });

  return summarizeCompatibilityEvents(spec, events);
}

function renderCompatibilityPlan(specs: CompatibilityRunSpec[], json: boolean): void {
  if (json) {
    console.log(JSON.stringify({ execute: false, specs }, null, 2));
    return;
  }
  console.log(`Compatibility plan: ${specs.length} run(s)`);
  for (const spec of specs) {
    const model = spec.request.model ? ` model=${spec.request.model}` : '';
    const workspace = spec.request.workspaceRoot ? ` workspace=${spec.request.workspaceRoot}` : '';
    console.log(`${spec.id} provider=${spec.request.provider}${model} probe=${spec.probe.id} toolMode=${spec.request.toolMode} maxLoops=${spec.request.maxLoops}${workspace}`);
  }
  console.log('Add --execute to run these probes through the gateway.');
}

function renderCompatibilitySummary(summary: CompatibilityRunSummary, json: boolean): void {
  if (json) {
    console.log(JSON.stringify({ event: 'compat.result', data: summary }));
    return;
  }
  const model = summary.effectiveModel ?? summary.model ?? '?';
  const status = summary.error ? 'error' : summary.cancelled ? 'cancelled' : summary.completed ? 'completed' : 'incomplete';
  console.log(`[compat:${status}] ${summary.specId} ${summary.provider}/${model} tokens=${summary.totalTokens} tools=${summary.toolCalls.join(',') || 'none'} failedTools=${summary.failedToolResultCount}`);
  if (summary.error) console.log(indent(summary.error));
}

async function readSse(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: string, data: JsonRecord) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let eventName = 'message';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      if (line.startsWith('event: ')) {
        eventName = line.slice(7).trim();
        continue;
      }
      if (!line.startsWith('data: ')) continue;
      const data = parseJsonRecord(line.slice(6));
      onEvent(eventName, data);
      eventName = 'message';
    }
  }
}

function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];
  const aliases: Record<string, string> = {
    g: 'gateway',
    h: 'help',
    w: 'workspace',
  };
  const booleanFlags = new Set(['help', 'h', 'json', 'execute']);

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
  const raw = stringFlag(parsed, 'gateway')
    ?? stringFlag(parsed, 'g')
    ?? process.env.LOS_GATEWAY_URL
    ?? process.env.LOS_SERVER_URL
    ?? envServerUrl()
    ?? DEFAULT_GATEWAY;
  return raw.replace(/\/+$/, '');
}

function envServerUrl(): string | undefined {
  if (!process.env.SERVER_HOST && !process.env.SERVER_PORT) return undefined;
  return `http://${process.env.SERVER_HOST ?? '127.0.0.1'}:${process.env.SERVER_PORT ?? '8080'}`;
}

function hasFlag(parsed: ParsedArgs, ...keys: string[]): boolean {
  return keys.some(key => parsed.flags[key] !== undefined);
}

function booleanFlag(parsed: ParsedArgs, key: string): boolean {
  return parsed.flags[key] === true || parsed.flags[key] === 'true' || parsed.flags[key] === '1';
}

function stringFlag(parsed: ParsedArgs, key: string): string | undefined {
  const value = parsed.flags[key];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function numberFlag(parsed: ParsedArgs, key: string): number | undefined {
  const value = stringFlag(parsed, key);
  if (!value) return undefined;
  const parsedNumber = Number(value);
  if (!Number.isFinite(parsedNumber)) return undefined;
  return parsedNumber;
}

function csvFlag(parsed: ParsedArgs, key: string): string[] {
  const value = stringFlag(parsed, key);
  return value ? splitCsv(value) : [];
}

function splitCsv(value: string): string[] {
  return value.split(',').map(item => item.trim()).filter(Boolean);
}

function parseJsonRecord(raw: string): JsonRecord {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return asRecord(parsed);
  } catch {
    return { raw };
  }
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

function removeUndefined(value: JsonRecord): void {
  for (const key of Object.keys(value)) {
    if (value[key] === undefined) delete value[key];
  }
}

function indent(value: string): string {
  return value.split('\n').map(line => `  ${line}`).join('\n');
}

function printCompatHelp(): void {
  console.log(`los compat

Dry-run planned compatibility probes:
  los compat
  los compat deepseek:deepseek-reasoner openai:gpt-4o
  los compat --target deepseek:deepseek-chat,packycode:gpt-5.5 --probe read-context

Execute probes through the gateway:
  los compat --execute --workspace . deepseek:deepseek-reasoner

Options:
  --gateway, -g URL       Gateway URL, default ${DEFAULT_GATEWAY}
  --target NAME[:MODEL]   Provider/model target
  --probe ID              read-context or patch-preview
  --workspace, -w PATH    Workspace root for tools
  --max-loops N           Override probe loop limit
  --timeout-ms N          Per-run task timeout
  --execute               Run probes instead of printing the plan
  --json                  Emit JSON
`);
}
