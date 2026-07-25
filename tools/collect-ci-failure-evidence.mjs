#!/usr/bin/env node

import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, extname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_TAIL_BYTES = 512 * 1024;
const MANIFEST_RESERVE_BYTES = 64 * 1024;
const DENIED_TREE_SEGMENTS = new Set(['node_modules', '.turbo', '.pnpm-store', 'pnpm-store']);

export function collectFailureEvidence({
  output,
  inputs,
  maxBytes = DEFAULT_MAX_BYTES,
  tailBytes = DEFAULT_TAIL_BYTES,
}) {
  if (!output) throw new Error('output is required');
  if (existsSync(output)) throw new Error(`output already exists: ${output}`);
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= MANIFEST_RESERVE_BYTES) {
    throw new Error(`max-bytes must be greater than ${MANIFEST_RESERVE_BYTES}`);
  }
  if (!Number.isSafeInteger(tailBytes) || tailBytes <= 0) {
    throw new Error('tail-bytes must be a positive integer');
  }

  const outputRoot = resolve(output);
  mkdirSync(outputRoot, { recursive: true });
  const budget = { remaining: maxBytes - MANIFEST_RESERVE_BYTES, included: 0 };
  const records = inputs.map(input => collectInput({
    input,
    outputRoot,
    budget,
    tailBytes,
  }));

  const manifestPath = resolve(outputRoot, 'manifest.json');
  const manifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    maxBundleBytes: maxBytes,
    totalBytes: 0,
    inputs: records,
    exclusions: ['node_modules', 'pnpm store', '.turbo'],
  };
  const encoded = encodeManifest(manifest, budget.included);
  if (encoded.length > MANIFEST_RESERVE_BYTES || budget.included + encoded.length > maxBytes) {
    throw new Error('manifest exceeded the reserved evidence budget');
  }
  writeFileSync(manifestPath, encoded);
  return manifest;
}

function encodeManifest(manifest, includedBytes) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const encoded = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
    const totalBytes = includedBytes + encoded.length;
    if (manifest.totalBytes === totalBytes) return encoded;
    manifest.totalBytes = totalBytes;
  }
  throw new Error('manifest byte count did not stabilize');
}

function collectInput({ input, outputRoot, budget, tailBytes }) {
  const source = resolve(input.path);
  const record = {
    label: input.label,
    kind: input.kind,
    source: displaySource(source),
    status: 'unavailable',
    includedBytes: 0,
    includedFiles: [],
    skippedFiles: [],
  };
  if (!existsSync(source)) return record;

  if (input.kind === 'tail') {
    return collectTail({ source, outputRoot, budget, tailBytes, record });
  }
  if (input.kind === 'file') {
    return collectFile({ source, outputRoot, budget, record });
  }
  if (input.kind === 'tree') {
    return collectTree({ source, outputRoot, budget, record });
  }
  throw new Error(`unsupported input kind: ${input.kind}`);
}

function collectTail({ source, outputRoot, budget, tailBytes, record }) {
  if (!statSync(source).isFile()) return record;
  const content = readFileSync(source);
  const length = Math.min(content.length, tailBytes, budget.remaining);
  if (length <= 0) return { ...record, status: 'cap_exceeded' };
  const destination = `${safeLabel(record.label)}${extname(source) || '.log'}`;
  writeOutput(outputRoot, destination, content.subarray(content.length - length));
  consumeBudget(budget, length);
  return {
    ...record,
    status: length < content.length ? 'partial' : 'included',
    includedBytes: length,
    includedFiles: [destination],
  };
}

function collectFile({ source, outputRoot, budget, record }) {
  if (!statSync(source).isFile()) return record;
  const size = statSync(source).size;
  if (size > budget.remaining) return { ...record, status: 'cap_exceeded' };
  const destination = `${safeLabel(record.label)}${extname(source)}`;
  mkdirSync(dirname(resolve(outputRoot, destination)), { recursive: true });
  copyFileSync(source, resolve(outputRoot, destination));
  consumeBudget(budget, size);
  return {
    ...record,
    status: 'included',
    includedBytes: size,
    includedFiles: [destination],
  };
}

function collectTree({ source, outputRoot, budget, record }) {
  if (!statSync(source).isDirectory()) return record;
  const candidates = walkTree(source);
  for (const candidate of candidates) {
    const sourceRelative = relative(source, candidate);
    const destination = `${safeLabel(record.label)}/${sourceRelative}`;
    const size = statSync(candidate).size;
    if (size > budget.remaining) {
      record.skippedFiles.push({ path: sourceRelative, reason: 'cap_exceeded', bytes: size });
      continue;
    }
    mkdirSync(dirname(resolve(outputRoot, destination)), { recursive: true });
    copyFileSync(candidate, resolve(outputRoot, destination));
    consumeBudget(budget, size);
    record.includedBytes += size;
    record.includedFiles.push(destination);
  }
  if (record.includedFiles.length === 0) {
    record.status = record.skippedFiles.length > 0 ? 'cap_exceeded' : 'unavailable';
  } else {
    record.status = record.skippedFiles.length > 0 ? 'partial' : 'included';
  }
  return record;
}

function walkTree(root) {
  const out = [];
  const visit = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (DENIED_TREE_SEGMENTS.has(entry.name)) continue;
      const path = resolve(directory, entry.name);
      if (entry.isSymbolicLink() || lstatSync(path).isSymbolicLink()) continue;
      if (entry.isDirectory()) visit(path);
      if (entry.isFile()) out.push(path);
    }
  };
  visit(root);
  return out;
}

function writeOutput(outputRoot, destination, content) {
  const path = resolve(outputRoot, destination);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function consumeBudget(budget, bytes) {
  budget.remaining -= bytes;
  budget.included += bytes;
}

function safeLabel(label) {
  const normalized = label.trim().replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!normalized || normalized === '.' || normalized === '..') throw new Error(`invalid label: ${label}`);
  return normalized;
}

function displaySource(source) {
  const fromCwd = relative(process.cwd(), source);
  if (fromCwd && !fromCwd.startsWith(`..${sep}`) && fromCwd !== '..') return fromCwd;
  return `<external>/${basename(source)}`;
}

function parseInput(value, kind) {
  const separator = value.indexOf('=');
  if (separator <= 0 || separator === value.length - 1) {
    throw new Error(`${kind} input must use label=path`);
  }
  return { kind, label: value.slice(0, separator), path: value.slice(separator + 1) };
}

function parseArgs(argv) {
  const options = { inputs: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') return { help: true };
    if (argument === '--output') options.output = argv[++index];
    else if (argument === '--max-bytes') options.maxBytes = Number(argv[++index]);
    else if (argument === '--tail-bytes') options.tailBytes = Number(argv[++index]);
    else if (argument === '--tail') options.inputs.push(parseInput(argv[++index], 'tail'));
    else if (argument === '--file') options.inputs.push(parseInput(argv[++index], 'file'));
    else if (argument === '--tree') options.inputs.push(parseInput(argv[++index], 'tree'));
    else throw new Error(`unknown argument: ${argument}`);
  }
  return options;
}

function printHelp() {
  console.log(`Usage: collect-ci-failure-evidence.mjs --output DIR [options]

Options:
  --max-bytes N       Maximum bundle bytes including manifest (default: 10485760)
  --tail-bytes N      Maximum bytes retained from each tailed log (default: 524288)
  --tail LABEL=PATH   Retain the end of a log file
  --file LABEL=PATH   Copy one file if it fits
  --tree LABEL=PATH   Copy a directory tree until the bundle cap is reached`);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) printHelp();
    else console.log(JSON.stringify(collectFailureEvidence(options)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
