import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, relative, resolve } from 'node:path';
import { Ajv2020, type ErrorObject } from 'ajv/dist/2020.js';
import ts from 'typescript';
import YAML from 'yaml';
import { generateContractFiles } from './contract-codegen.js';

type JsonRecord = Record<string, unknown>;

export interface ContractCheckIssue {
  surface: string;
  message: string;
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PILOT_FILES = ['run-spec.yaml', 'run-stream.yaml'] as const;
const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete']);
const EVENT_SOURCE_SUFFIXES = [
  'packages/gateway/src/chat-route.ts',
  'packages/gateway/src/chat-service.ts',
  'packages/gateway/src/chat-live-events.ts',
  'packages/gateway/src/routes/streaming/sse-routes.ts',
];

export async function checkContracts(root = ROOT): Promise<ContractCheckIssue[]> {
  const issues: ContractCheckIssue[] = [];
  const contractDir = resolve(root, 'contracts');
  const names = (await readdir(contractDir))
    .filter(name => name.endsWith('.yaml') && name !== 'meta-schema.yaml')
    .sort();
  const metaSchema = await parseYamlFile(resolve(contractDir, 'meta-schema.yaml'), issues);
  if (!metaSchema) return issues;

  const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: false });
  const validateEnvelope = ajv.compile(metaSchema);
  const contracts = new Map<string, JsonRecord>();
  for (const name of names) {
    const parsed = await parseYamlFile(resolve(contractDir, name), issues);
    if (!parsed) continue;
    if (!validateEnvelope(parsed)) {
      issues.push(...formatAjvIssues(name, validateEnvelope.errors));
      continue;
    }
    contracts.set(name, parsed);
  }

  const runSpec = contracts.get('run-spec.yaml');
  if (runSpec) {
    const schema = pickJsonSchema(runSpec);
    try {
      ajv.compile(schema);
    } catch (error) {
      issues.push({ surface: 'run-spec.yaml', message: `invalid JSON Schema: ${errorMessage(error)}` });
    }
  }

  const sourceFiles = await collectTypeScriptFiles(resolve(root, 'packages/gateway/src'));
  const routeSet = await collectFastifyRoutes(sourceFiles);
  for (const name of PILOT_FILES) {
    const contract = contracts.get(name);
    if (contract) issues.push(...checkRouteCoverage(name, contract, routeSet));
  }

  const runStream = contracts.get('run-stream.yaml');
  if (runStream) {
    const eventFiles = sourceFiles.filter(file => EVENT_SOURCE_SUFFIXES.some(suffix => file.endsWith(suffix)));
    const emitted = await collectLiteralSendEvents(eventFiles);
    issues.push(...checkEventCoverage(runStream, emitted));
  }

  const generated = await generateContractFiles(root);
  for (const [name, expected] of Object.entries({
    'run-spec.ts': generated.runSpec,
    'run-stream.ts': generated.runStream,
  })) {
    const path = resolve(root, 'packages/contracts/src/generated', name);
    const actual = existsSync(path) ? await readFile(path, 'utf8') : '';
    issues.push(...checkGeneratedContent(relative(root, path), expected, actual));
  }

  return issues;
}

export function checkRouteCoverage(
  contractName: string,
  contract: JsonRecord,
  actualRoutes: ReadonlySet<string>,
): ContractCheckIssue[] {
  const declared = new Set<string>();
  collectDeclaredRoutes(contract, declared);
  return [...declared]
    .filter(route => !actualRoutes.has(route))
    .map(route => ({ surface: contractName, message: `declared route has no Fastify registration: ${route}` }));
}

export function checkEventCoverage(
  runStream: JsonRecord,
  emitted: ReadonlySet<string>,
): ContractCheckIssue[] {
  const eventTypes = stringArray(runStream.eventTypes);
  const sseProtocol = stringArray(runStream.sseProtocol);
  const declared = new Set([...eventTypes, ...sseProtocol]);
  const issues: ContractCheckIssue[] = [];
  for (const event of emitted) {
    if (!declared.has(event)) {
      issues.push({ surface: 'run-stream.yaml', message: `literal send event is undeclared: ${event}` });
    }
  }
  for (const event of sseProtocol) {
    if (!emitted.has(event)) {
      issues.push({ surface: 'run-stream.yaml', message: `SSE protocol event has no literal emitter: ${event}` });
    }
  }
  return issues;
}

export function checkGeneratedContent(
  surface: string,
  expected: string,
  actual: string,
): ContractCheckIssue[] {
  return actual === expected
    ? []
    : [{ surface, message: 'generated file is stale; run pnpm contracts:generate' }];
}

async function parseYamlFile(path: string, issues: ContractCheckIssue[]): Promise<JsonRecord | null> {
  const document = YAML.parseDocument(await readFile(path, 'utf8'), { prettyErrors: true });
  if (document.errors.length > 0) {
    for (const error of document.errors) {
      issues.push({ surface: path, message: error.message });
    }
    return null;
  }
  const value = document.toJS();
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    issues.push({ surface: path, message: 'contract document must be an object' });
    return null;
  }
  return value as JsonRecord;
}

function pickJsonSchema(contract: JsonRecord): JsonRecord {
  return {
    $schema: contract.schemaDialect,
    type: contract.type,
    required: contract.required,
    properties: contract.properties,
    additionalProperties: contract.additionalProperties ?? true,
  };
}

function collectDeclaredRoutes(value: unknown, routes: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectDeclaredRoutes(item, routes);
    return;
  }
  if (!value || typeof value !== 'object') return;
  const record = value as JsonRecord;
  if (typeof record.method === 'string' && typeof record.path === 'string') {
    routes.add(normalizeRoute(record.method, record.path));
  }
  for (const child of Object.values(record)) collectDeclaredRoutes(child, routes);
}

async function collectTypeScriptFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collectTypeScriptFiles(path));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) files.push(path);
  }
  return files.sort();
}

async function collectFastifyRoutes(files: string[]): Promise<Set<string>> {
  const routes = new Set<string>();
  for (const file of files) {
    const source = ts.createSourceFile(file, await readFile(file, 'utf8'), ts.ScriptTarget.Latest, true);
    walk(source, node => {
      if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return;
      const method = node.expression.name.text.toLowerCase();
      const receiver = node.expression.expression.getText(source);
      const first = node.arguments[0];
      if (!HTTP_METHODS.has(method) || receiver !== 'app' || !first || !ts.isStringLiteralLike(first)) return;
      routes.add(normalizeRoute(method, first.text));
    });
  }
  return routes;
}

async function collectLiteralSendEvents(files: string[]): Promise<Set<string>> {
  const events = new Set<string>();
  for (const file of files) {
    const source = ts.createSourceFile(file, await readFile(file, 'utf8'), ts.ScriptTarget.Latest, true);
    walk(source, node => {
      if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression) || node.expression.text !== 'send') return;
      const first = node.arguments[0];
      if (first && ts.isStringLiteralLike(first)) events.add(first.text);
    });
  }
  return events;
}

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  node.forEachChild(child => walk(child, visit));
}

function normalizeRoute(method: string, path: string): string {
  const normalizedPath = path
    .replace(/:[A-Za-z][A-Za-z0-9_]*/g, '{param}')
    .replace(/\{[^}]+\}/g, '{param}');
  return `${method.toUpperCase()} ${normalizedPath}`;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function formatAjvIssues(surface: string, errors: ErrorObject[] | null | undefined): ContractCheckIssue[] {
  return (errors ?? []).map(error => ({
    surface,
    message: `${error.instancePath || '/'} ${error.message ?? 'is invalid'}`,
  }));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function main(): Promise<void> {
  const issues = await checkContracts();
  if (issues.length > 0) {
    for (const issue of issues) process.stderr.write(`contract check failed: ${issue.surface}: ${issue.message}\n`);
    process.exitCode = 1;
  } else {
    const count = (await readdir(resolve(ROOT, 'contracts')))
      .filter(name => name.endsWith('.yaml') && name !== 'meta-schema.yaml').length;
    process.stdout.write(`contract check passed (${count} contracts, executable pilot: ${PILOT_FILES.join(', ')})\n`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
