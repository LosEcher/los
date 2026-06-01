import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { resolveClientPath } from './client-path.js';

type JsonRecord = Record<string, unknown>;

type ParsedArgs = {
  flags: Record<string, string | boolean>;
  positionals: string[];
};

const DEFAULT_GATEWAY = 'http://127.0.0.1:8080';

export async function artifactsCommand(globalArgs: string[], argv: string[]): Promise<void> {
  const parsed = mergeParsed(parseArgs(globalArgs), parseArgs(argv));
  const [action = 'list', ...rest] = parsed.positionals;
  if (hasFlag(parsed, 'help', 'h')) {
    printArtifactsHelp();
    return;
  }

  if (action === 'list' || action === 'ls') {
    await listArtifacts(parsed);
    return;
  }
  if (action === 'put' || action === 'upload') {
    await putArtifact(parsed, rest);
    return;
  }
  if (action === 'get' || action === 'cat' || action === 'download') {
    await getArtifact(parsed, rest);
    return;
  }
  if (action === 'delete' || action === 'rm') {
    await deleteArtifact(parsed, rest);
    return;
  }

  throw new Error(`Unknown artifacts command: ${action}`);
}

async function listArtifacts(parsed: ParsedArgs): Promise<void> {
  const params = new URLSearchParams();
  addQuery(params, 'nodeId', stringFlag(parsed, 'node-id') ?? stringFlag(parsed, 'node'));
  addQuery(params, 'sessionId', stringFlag(parsed, 'session-id') ?? stringFlag(parsed, 'session') ?? stringFlag(parsed, 's'));
  addQuery(params, 'taskRunId', stringFlag(parsed, 'task-run-id') ?? stringFlag(parsed, 'task'));
  addQuery(params, 'limit', stringFlag(parsed, 'limit'));
  if (booleanFlag(parsed, 'include-deleted')) params.set('includeDeleted', 'true');

  const suffix = params.toString() ? `?${params.toString()}` : '';
  const value = await getJson(`${gatewayUrl(parsed)}/artifacts${suffix}`);
  renderArtifactList(value, booleanFlag(parsed, 'json'));
}

async function putArtifact(parsed: ParsedArgs, rest: string[]): Promise<void> {
  const nodeId = stringFlag(parsed, 'node-id') ?? stringFlag(parsed, 'node');
  if (!nodeId) throw new Error('artifacts put requires --node-id');

  const file = stringFlag(parsed, 'file') ?? stringFlag(parsed, 'f');
  const content = stringFlag(parsed, 'content');
  if (!file && content === undefined) {
    throw new Error('artifacts put requires --content or --file');
  }

  const payload: JsonRecord = {
    artifactId: stringFlag(parsed, 'artifact-id') ?? rest[0],
    nodeId,
    sessionId: stringFlag(parsed, 'session-id') ?? stringFlag(parsed, 'session') ?? stringFlag(parsed, 's'),
    taskRunId: stringFlag(parsed, 'task-run-id') ?? stringFlag(parsed, 'task'),
    traceId: stringFlag(parsed, 'trace-id'),
    workspaceRoot: optionalResolvedPath(stringFlag(parsed, 'workspace-root') ?? stringFlag(parsed, 'workspace') ?? stringFlag(parsed, 'w')),
    path: stringFlag(parsed, 'path') ?? file,
    pathPolicy: stringFlag(parsed, 'path-policy'),
    contentType: stringFlag(parsed, 'content-type'),
    metadata: parseMetadata(parsed),
  };

  if (file) {
    const bytes = await readFile(resolveClientPath(file));
    payload.content = bytes.toString('base64');
    payload.encoding = 'base64';
    if (!payload.contentType) payload.contentType = 'application/octet-stream';
  } else {
    payload.content = content ?? '';
    payload.encoding = 'utf8';
    if (!payload.contentType) payload.contentType = 'text/plain';
  }

  removeUndefined(payload);
  const value = await sendJson(`${gatewayUrl(parsed)}/artifacts`, {
    method: 'POST',
    body: payload,
  });
  renderArtifactPut(value, booleanFlag(parsed, 'json'));
}

async function getArtifact(parsed: ParsedArgs, rest: string[]): Promise<void> {
  const artifactId = rest[0];
  if (!artifactId) throw new Error('artifacts get requires an artifact id');

  const output = stringFlag(parsed, 'output') ?? stringFlag(parsed, 'o');
  const json = booleanFlag(parsed, 'json');
  if (json && !output) {
    const value = await getJson(`${gatewayUrl(parsed)}/artifacts/${encodeURIComponent(artifactId)}`);
    console.log(JSON.stringify(value));
    return;
  }

  const response = await fetch(`${gatewayUrl(parsed)}/artifacts/${encodeURIComponent(artifactId)}/content`);
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${await response.text()}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!output) {
    process.stdout.write(bytes);
    return;
  }

  const outputPath = resolveClientPath(output);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, bytes);
  if (json) {
    console.log(JSON.stringify({
      artifactId,
      outputPath,
      sizeBytes: bytes.byteLength,
      checksum: response.headers.get('x-artifact-checksum') ?? undefined,
    }));
    return;
  }
  console.log(`saved ${artifactId} -> ${outputPath} (${bytes.byteLength} bytes)`);
}

async function deleteArtifact(parsed: ParsedArgs, rest: string[]): Promise<void> {
  const artifactId = rest[0];
  if (!artifactId) throw new Error('artifacts delete requires an artifact id');
  const value = await sendJson(`${gatewayUrl(parsed)}/artifacts/${encodeURIComponent(artifactId)}`, {
    method: 'DELETE',
    body: { reason: stringFlag(parsed, 'reason') },
  });
  renderArtifactDelete(value, booleanFlag(parsed, 'json'));
}

async function getJson(url: string): Promise<unknown> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${await response.text()}`);
  }
  return await response.json() as unknown;
}

async function sendJson(url: string, input: { method: string; body: JsonRecord }): Promise<unknown> {
  const response = await fetch(url, {
    method: input.method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input.body),
  });
  const text = await response.text();
  const value = text ? JSON.parse(text) as unknown : {};
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${text}`);
  }
  return value;
}

function renderArtifactList(value: unknown, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(value));
    return;
  }
  const rows = Array.isArray(value) ? value : [];
  if (rows.length === 0) {
    console.log('No artifacts found.');
    return;
  }
  for (const row of rows) {
    const item = asRecord(row);
    const deleted = item.deletedAt ? ` deleted=${String(item.deletedAt)}` : '';
    const session = item.sessionId ? ` session=${String(item.sessionId)}` : '';
    console.log(`${String(item.artifactId)} node=${String(item.nodeId ?? '?')} size=${String(item.sizeBytes ?? '?')} type=${String(item.contentType ?? '?')}${session}${deleted}`);
  }
}

function renderArtifactPut(value: unknown, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(value));
    return;
  }
  const artifact = asRecord(asRecord(value).artifact);
  console.log(`artifact=${String(artifact.artifactId ?? '?')} node=${String(artifact.nodeId ?? '?')} size=${String(artifact.sizeBytes ?? '?')} checksum=${String(artifact.checksum ?? '?')}`);
}

function renderArtifactDelete(value: unknown, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(value));
    return;
  }
  const artifact = asRecord(asRecord(value).artifact);
  console.log(`deleted=${String(artifact.artifactId ?? '?')} node=${String(artifact.nodeId ?? '?')}`);
}

function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];
  const aliases: Record<string, string> = {
    f: 'file',
    g: 'gateway',
    h: 'help',
    o: 'output',
    s: 'session',
    w: 'workspace',
  };
  const booleanFlags = new Set(['help', 'h', 'json', 'include-deleted']);

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

function optionalResolvedPath(value: string | undefined): string | undefined {
  return value ? resolveClientPath(value) : undefined;
}

function parseMetadata(parsed: ParsedArgs): Record<string, unknown> | undefined {
  const raw = stringFlag(parsed, 'metadata-json');
  if (!raw) return undefined;
  const parsedValue = JSON.parse(raw) as unknown;
  if (!parsedValue || typeof parsedValue !== 'object' || Array.isArray(parsedValue)) {
    throw new Error('--metadata-json must be a JSON object');
  }
  return parsedValue as Record<string, unknown>;
}

function addQuery(params: URLSearchParams, key: string, value: string | undefined): void {
  if (value) params.set(key, value);
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

function removeUndefined(value: JsonRecord): void {
  for (const key of Object.keys(value)) {
    if (value[key] === undefined) delete value[key];
  }
}

function printArtifactsHelp(): void {
  console.log(`los artifacts

Usage:
  los artifacts list [--node-id ID] [--session ID] [--task TASK] [--include-deleted] [--json]
  los artifacts put --node-id ID [ARTIFACT_ID] (--content TEXT | --file PATH) [--session ID] [--path PATH]
  los artifacts get ARTIFACT_ID [--output PATH] [--json]
  los artifacts delete ARTIFACT_ID [--reason TEXT] [--json]

Options:
  --gateway, -g URL       Gateway URL, default ${DEFAULT_GATEWAY}
  --node-id ID            Executor node id that owns the artifact
  --session, -s ID        Session id used for artifact session events
  --task TASK             Task run id
  --content TEXT          Inline UTF-8 artifact content
  --file, -f PATH         Read artifact content from a local file
  --output, -o PATH       Write artifact content to a local file
  --content-type TYPE     Content type, default text/plain for --content
  --metadata-json JSON    JSON object stored with the artifact
`);
}
