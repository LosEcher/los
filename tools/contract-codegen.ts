import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import YAML from 'yaml';

type Schema = {
  type?: string | string[];
  enum?: unknown[];
  oneOf?: Schema[];
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
  [key: string]: unknown;
};

export interface GeneratedContractFiles {
  runSpec: string;
  runStream: string;
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GENERATED_DIR = resolve(ROOT, 'packages/contracts/src/generated');

export async function generateContractFiles(root = ROOT): Promise<GeneratedContractFiles> {
  const [runSpecText, runStreamText] = await Promise.all([
    readFile(resolve(root, 'contracts/run-spec.yaml'), 'utf8'),
    readFile(resolve(root, 'contracts/run-stream.yaml'), 'utf8'),
  ]);
  const runSpec = YAML.parse(runSpecText) as Schema & { contract: string; version: string };
  const runStream = YAML.parse(runStreamText) as {
    contract: string;
    version: string;
    eventTypes: string[];
    sseProtocol: string[];
  };

  const schema = pickJsonSchema(runSpec);
  return {
    runSpec: renderRunSpec(runSpec.contract, runSpec.version, schema),
    runStream: renderRunStream(runStream),
  };
}

export async function writeGeneratedContractFiles(root = ROOT): Promise<void> {
  const generated = await generateContractFiles(root);
  const directory = resolve(root, 'packages/contracts/src/generated');
  await mkdir(directory, { recursive: true });
  await Promise.all([
    writeFile(resolve(directory, 'run-spec.ts'), generated.runSpec),
    writeFile(resolve(directory, 'run-stream.ts'), generated.runStream),
  ]);
}

function pickJsonSchema(contract: Schema): Schema {
  return {
    $schema: contract.schemaDialect,
    type: contract.type,
    required: contract.required,
    properties: contract.properties,
    additionalProperties: contract.additionalProperties ?? true,
  };
}

function renderRunSpec(contract: string, version: string, schema: Schema): string {
  return `${header(contract, version)}import { createContractValidator } from '../runtime.js';

export const RUN_SPEC_CONTRACT = ${JSON.stringify(contract)};
export const RUN_SPEC_VERSION = ${JSON.stringify(version)};
export const RUN_SPEC_REQUEST_SCHEMA = ${JSON.stringify(schema)} as const;

export type RunSpecRequest = ${schemaToType(schema)};

export const validateRunSpecRequest = createContractValidator<RunSpecRequest>(
  RUN_SPEC_REQUEST_SCHEMA,
);
`;
}

function renderRunStream(contract: {
  contract: string;
  version: string;
  eventTypes: string[];
  sseProtocol: string[];
}): string {
  return `${header(contract.contract, contract.version)}export const RUN_STREAM_CONTRACT = ${JSON.stringify(contract.contract)};
export const RUN_STREAM_VERSION = ${JSON.stringify(contract.version)};
export const RUN_STREAM_EVENT_TYPES = ${JSON.stringify(contract.eventTypes, null, 2)} as const;
export const RUN_STREAM_SSE_EVENTS = ${JSON.stringify(contract.sseProtocol, null, 2)} as const;

export type RunStreamEventType = typeof RUN_STREAM_EVENT_TYPES[number];
export type RunStreamSseEventType = typeof RUN_STREAM_SSE_EVENTS[number];
export type RunStreamWireEventType = RunStreamEventType | RunStreamSseEventType;
`;
}

function header(contract: string, version: string): string {
  return `// Generated from ${contract}@${version} by tools/contract-codegen.ts. Do not edit.\n\n`;
}

function schemaToType(schema: Schema, indent = ''): string {
  if (schema.enum?.length) return schema.enum.map(value => JSON.stringify(value)).join(' | ');
  if (schema.oneOf?.length) return schema.oneOf.map(item => schemaToType(item, indent)).join(' | ');
  if (Array.isArray(schema.type)) {
    return schema.type.map(type => type === 'null' ? 'null' : schemaToType({ ...schema, type }, indent)).join(' | ');
  }
  switch (schema.type) {
    case 'string': return 'string';
    case 'integer':
    case 'number': return 'number';
    case 'boolean': return 'boolean';
    case 'null': return 'null';
    case 'array': return `Array<${schemaToType(schema.items ?? {}, indent)}>`;
    case 'object': {
      if (!schema.properties || Object.keys(schema.properties).length === 0) return 'Record<string, unknown>';
      const required = new Set(schema.required ?? []);
      const childIndent = `${indent}  `;
      const fields = Object.entries(schema.properties).map(([name, child]) => {
        const key = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name);
        return `${childIndent}${key}${required.has(name) ? '' : '?'}: ${schemaToType(child, childIndent)};`;
      });
      return `{\n${fields.join('\n')}\n${indent}}`;
    }
    default: return 'unknown';
  }
}

async function main(): Promise<void> {
  await writeGeneratedContractFiles();
  process.stdout.write(`generated contracts in ${GENERATED_DIR}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
