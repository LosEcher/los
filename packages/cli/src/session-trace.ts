import { requestCliJson, resolveCliRequestAuth, type CliRequestAuth } from './cli-http.js';

type JsonRecord = Record<string, unknown>;

type ParsedArgs = {
  flags: Record<string, string | boolean>;
  positionals: string[];
};

const DEFAULT_GATEWAY = 'http://127.0.0.1:8080';
const DEFAULT_FOLLOW_INTERVAL_MS = 2000;
const DEFAULT_MAX_IDLE_MS = 60_000;

// ---------------------------------------------------------------------------
// Typed projection types. Mirror contracts/session-trace.yaml (los.session-trace 0.2.0)
// so the CLI renders the same read model the Web console uses instead of
// hand-rolled per-event text.
// ---------------------------------------------------------------------------

export type TraceToolCallStatus = 'running' | 'completed' | 'error' | 'denied';

export type TraceToolCall = {
  callId: string;
  toolName: string;
  status: TraceToolCallStatus;
  argsPreview: string;
  args?: Record<string, unknown>;
  resultPreview?: string;
  errorPreview?: string;
  durationMs?: number;
  attempts?: number;
};

export type TraceMessage = {
  role: 'user' | 'assistant' | 'system' | 'separator';
  content: string;
  meta?: string;
  level?: 'normal' | 'ok' | 'warn' | 'error';
  eventType?: string;
  provider?: string;
  model?: string;
  turnIndex?: number;
  totalTurns?: number;
  reasoning?: string;
  toolCalls: TraceToolCall[];
};

export type TraceResponse = {
  sessionId: string;
  messages: TraceMessage[];
  since: number;
  nextSince: number;
  unchanged?: boolean;
  messageCount?: number;
  turnCount?: number;
};

// ---------------------------------------------------------------------------
// Command entry: los sessions trace|follow <session-id>
// ---------------------------------------------------------------------------

export async function sessionTraceCommand(globalArgs: string[], argv: string[]): Promise<void> {
  const action = argv[0];
  if (action !== 'trace' && action !== 'follow') {
    throw new Error(`Unknown sessions action: ${String(action ?? '')}. Expected trace or follow.`);
  }
  const parsed = mergeParsed(parseArgs(globalArgs), parseArgs(argv.slice(1)));
  if (hasFlag(parsed, 'help', 'h')) {
    printSessionTraceHelp();
    return;
  }
  const sessionId = parsed.positionals[0];
  if (!sessionId) throw new Error(`Session id is required. Usage: los sessions ${action} <session-id>`);

  const gateway = gatewayUrl(parsed);
  const auth = requestAuth(parsed);
  const json = booleanFlag(parsed, 'json');

  if (action === 'trace') {
    const since = numberFlag(parsed, 'since') ?? 0;
    const response = await fetchTraceSince(sessionId, since, auth, gateway);
    renderTraceResponse(response, json);
    return;
  }

  await followTrace(sessionId, {
    gateway,
    auth,
    json: false,
    intervalMs: numberFlag(parsed, 'interval-ms') ?? DEFAULT_FOLLOW_INTERVAL_MS,
    maxIdleMs: numberFlag(parsed, 'max-idle-ms') ?? DEFAULT_MAX_IDLE_MS,
    print: line => console.log(line),
  });
}

// ---------------------------------------------------------------------------
// Rendering. Pure functions return lines so tests assert on stable output.
// ---------------------------------------------------------------------------

function renderTraceResponse(response: TraceResponse, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(response));
    return;
  }
  for (const line of traceResponseLines(response)) console.log(line);
}

function traceResponseLines(response: TraceResponse): string[] {
  const header = `session=${response.sessionId} messages=${response.messages.length}`;
  const lines = [header];
  if (typeof response.turnCount === 'number') lines[0] = `${header} turns=${response.turnCount}`;
  for (const message of response.messages) lines.push(...renderTraceMessageLines(message));
  return lines;
}

function renderTraceMessageLines(message: TraceMessage): string[] {
  const lines: string[] = [];
  if (message.role === 'user') {
    lines.push(`user: ${message.content}`);
    return lines;
  }
  if (message.role === 'system' || message.role === 'separator') {
    const suffix = message.meta ? ` ${message.meta}` : '';
    lines.push(`[${message.role}]${message.level ? ` (${message.level})` : ''} ${message.content}${suffix}`);
    return lines;
  }
  // assistant
  const turn = typeof message.turnIndex === 'number' ? ` [turn ${message.turnIndex}${typeof message.totalTurns === 'number' ? `/${message.totalTurns}` : ''}]` : '';
  const identity = [message.model, message.provider].filter(Boolean).join(' · ');
  lines.push(`assistant${turn}${identity ? ` ${identity}` : ''}`);
  if (message.reasoning) lines.push(`  reasoning: ${truncate(message.reasoning, 400)}`);
  if (message.content) {
    for (const part of message.content.split('\n')) lines.push(`  ${part}`);
  }
  for (const tool of message.toolCalls) lines.push(...renderToolCallLines(tool));
  return lines;
}

function renderToolCallLines(tool: TraceToolCall): string[] {
  const lines: string[] = [];
  const duration = typeof tool.durationMs === 'number' ? ` (${tool.durationMs}ms)` : '';
  lines.push(`  tool:${tool.toolName} ${tool.status}${duration}`);
  if (tool.argsPreview) lines.push(`    args: ${truncate(tool.argsPreview, 200)}`);
  if (tool.resultPreview) lines.push(`    result: ${truncate(tool.resultPreview, 200)}`);
  if (tool.errorPreview) lines.push(`    error: ${truncate(tool.errorPreview, 200)}`);
  return lines;
}

/**
 * Follow-mode incremental render: returns only lines for tool status changes
 * of an already-seen message. Used by followTrace to avoid re-printing whole
 * messages while still surfacing running → completed/error transitions.
 */
function renderTraceUpdateLines(message: TraceMessage, previous: ReadonlyMap<string, TraceToolCallStatus>): string[] {
  const lines: string[] = [];
  for (const tool of message.toolCalls) {
    const before = previous.get(tool.callId);
    if (before && before !== tool.status) {
      lines.push(`  tool:${tool.toolName} -> ${tool.status}${typeof tool.durationMs === 'number' ? ` (${tool.durationMs}ms)` : ''}`);
      if (tool.resultPreview) lines.push(`    result: ${truncate(tool.resultPreview, 200)}`);
      if (tool.errorPreview) lines.push(`    error: ${truncate(tool.errorPreview, 200)}`);
    }
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Follow mode: poll /sessions/:id/trace/since with a high-water cursor and
// print only new or changed messages until idle timeout or Ctrl-C.
// ---------------------------------------------------------------------------

async function followTrace(
  sessionId: string,
  options: {
    gateway: string;
    auth: CliRequestAuth;
    json: boolean;
    intervalMs: number;
    maxIdleMs: number;
    print: (line: string) => void;
  },
): Promise<void> {
  const { gateway, auth, intervalMs, maxIdleMs, print } = options;
  let nextSince = 0;
  let idleMs = 0;
  const seen = new Map<string, Map<string, TraceToolCallStatus>>();

  for (;;) {
    const response = await fetchTraceSince(sessionId, nextSince, auth, gateway);
    if (response.unchanged) {
      idleMs += intervalMs;
      if (idleMs >= maxIdleMs) break;
    } else {
      idleMs = 0;
      for (const message of response.messages) {
        const key = messageKey(message);
        const previous = seen.get(key);
        if (!previous) {
          for (const line of renderTraceMessageLines(message)) print(line);
          seen.set(key, toolStatusMap(message));
        } else {
          for (const line of renderTraceUpdateLines(message, previous)) print(line);
          mergeToolStatus(previous, message);
        }
      }
      if (typeof response.nextSince === 'number') nextSince = response.nextSince;
    }
    await sleep(intervalMs);
  }
}

function messageKey(message: TraceMessage): string {
  return `${message.role}|${message.turnIndex ?? ''}|${message.content}`;
}

function toolStatusMap(message: TraceMessage): Map<string, TraceToolCallStatus> {
  const map = new Map<string, TraceToolCallStatus>();
  for (const tool of message.toolCalls) map.set(tool.callId, tool.status);
  return map;
}

function mergeToolStatus(target: Map<string, TraceToolCallStatus>, message: TraceMessage): void {
  for (const tool of message.toolCalls) target.set(tool.callId, tool.status);
}

// ---------------------------------------------------------------------------
// HTTP + helpers
// ---------------------------------------------------------------------------

async function fetchTraceSince(sessionId: string, since: number, auth: CliRequestAuth, gateway: string): Promise<TraceResponse> {
  const value = await requestCliJson(
    `${gateway}/sessions/${encodeURIComponent(sessionId)}/trace/since?since=${Math.max(0, since)}`,
    { auth },
  );
  return normalizeTraceResponse(value);
}

function normalizeTraceResponse(value: unknown): TraceResponse {
  const root = asRecord(value);
  const rawMessages = Array.isArray(root.messages) ? root.messages : [];
  const messages = rawMessages.map(asTraceMessage);
  return {
    sessionId: String(root.sessionId ?? '?'),
    messages,
    since: typeof root.since === 'number' ? root.since : 0,
    nextSince: typeof root.nextSince === 'number' ? root.nextSince : 0,
    unchanged: typeof root.unchanged === 'boolean' ? root.unchanged : undefined,
    messageCount: typeof root.messageCount === 'number' ? root.messageCount : undefined,
    turnCount: typeof root.turnCount === 'number' ? root.turnCount : undefined,
  };
}

function asTraceMessage(value: unknown): TraceMessage {
  const record = asRecord(value);
  const rawTools = Array.isArray(record.toolCalls) ? record.toolCalls : [];
  const toolCalls: TraceToolCall[] = rawTools.map((tool): TraceToolCall => {
    const t = asRecord(tool);
    return {
      callId: String(t.callId ?? ''),
      toolName: String(t.toolName ?? 'tool'),
      status: normalizeToolStatus(t.status),
      argsPreview: String(t.argsPreview ?? ''),
      args: asRecord(t.args) as Record<string, unknown> | undefined,
      resultPreview: typeof t.resultPreview === 'string' ? t.resultPreview : undefined,
      errorPreview: typeof t.errorPreview === 'string' ? t.errorPreview : undefined,
      durationMs: typeof t.durationMs === 'number' ? t.durationMs : undefined,
      attempts: typeof t.attempts === 'number' ? t.attempts : undefined,
    };
  });
  return {
    role: normalizeRole(record.role),
    content: String(record.content ?? ''),
    meta: typeof record.meta === 'string' ? record.meta : undefined,
    level: record.level === 'ok' || record.level === 'warn' || record.level === 'error' ? record.level : record.level === 'normal' ? 'normal' : undefined,
    eventType: typeof record.eventType === 'string' ? record.eventType : undefined,
    provider: typeof record.provider === 'string' ? record.provider : undefined,
    model: typeof record.model === 'string' ? record.model : undefined,
    turnIndex: typeof record.turnIndex === 'number' ? record.turnIndex : undefined,
    totalTurns: typeof record.totalTurns === 'number' ? record.totalTurns : undefined,
    reasoning: typeof record.reasoning === 'string' ? record.reasoning : undefined,
    toolCalls,
  };
}

function normalizeRole(value: unknown): TraceMessage['role'] {
  if (value === 'assistant' || value === 'system' || value === 'separator') return value;
  return 'user';
}

function normalizeToolStatus(value: unknown): TraceToolCallStatus {
  if (value === 'completed' || value === 'error' || value === 'denied') return value;
  return 'running';
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Argument parsing (mirrors the other CLI modules)
// ---------------------------------------------------------------------------

function requestAuth(parsed: ParsedArgs): CliRequestAuth {
  return resolveCliRequestAuth(parsed.flags);
}

function gatewayUrl(parsed: ParsedArgs): string {
  const raw = stringFlag(parsed, 'gateway')
    ?? stringFlag(parsed, 'g')
    ?? process.env.LOS_GATEWAY_URL
    ?? process.env.LOS_SERVER_URL
    ?? DEFAULT_GATEWAY;
  return raw.replace(/\/+$/, '');
}

function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];
  const aliases: Record<string, string> = { g: 'gateway', h: 'help' };
  const booleanFlags = new Set(['help', 'h', 'json', 'apply', 'skip-failed']);

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

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}...`;
}

function printSessionTraceHelp(): void {
  console.log(`los sessions trace|follow

Examples:
  los sessions trace session-123
  los sessions trace session-123 --since 42 --json
  los sessions follow session-123
  los sessions follow session-123 --interval-ms 500 --max-idle-ms 30000

Options:
  --gateway, -g URL       Gateway URL, default ${DEFAULT_GATEWAY}
  --auth-token, -t TOKEN  Gateway token, default LOS_AUTH_TOKEN
  --since N               Start the trace from event-id cursor N
  --json                  Emit the raw typed projection response
  --interval-ms N         Follow poll interval, default ${DEFAULT_FOLLOW_INTERVAL_MS}
  --max-idle-ms N         Follow exits after N ms without new messages, default ${DEFAULT_MAX_IDLE_MS}
`);
}
