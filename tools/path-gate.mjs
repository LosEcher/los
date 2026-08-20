#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const SAFE_PREFIXES = ['tools/', 'docs/', '.forgejo/'];
export const SAFE_EXACT = new Set([
  'README.md',
  'LICENSE',
  '.gitignore',
  '.editorconfig',
  '.env.example',
  'pnpm-workspace.yaml',
]);

export function isSafePath(file) {
  const normalized = String(file ?? '').replaceAll('\\', '/').replace(/^\.\//, '');
  if (!normalized) return false;
  if (SAFE_EXACT.has(normalized)) return true;
  return SAFE_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

export function classifyPaths(files, extras = {}) {
  if (files == null) {
    return {
      skipHeavy: false,
      files: [],
      unsafe: [],
      mode: extras.mode ?? 'error',
      error: extras.error ?? 'path list unavailable',
    };
  }

  const cleaned = [...new Set(files.map((file) => String(file).trim()).filter(Boolean))];
  const unsafe = cleaned.filter((file) => !isSafePath(file));
  return {
    skipHeavy: unsafe.length === 0,
    files: cleaned,
    unsafe,
    mode: extras.mode ?? 'files',
    error: extras.error ?? null,
  };
}

export function listGitChangedFiles({ base = 'FETCH_HEAD', head = 'HEAD' } = {}) {
  const mergeBase = runGit(['merge-base', base, head]);
  if (mergeBase.status === 0 && mergeBase.stdout.trim()) {
    const threeDot = runGit(['diff', '--name-only', `${base}...${head}`]);
    if (threeDot.status === 0) {
      return { files: splitLines(threeDot.stdout), mode: 'three-dot' };
    }
  }

  const twoDot = runGit(['diff', '--name-only', base, head]);
  if (twoDot.status !== 0) {
    return {
      files: null,
      mode: 'error',
      error: (twoDot.stderr || twoDot.stdout || 'git diff failed').trim() || 'git diff failed',
    };
  }
  return { files: splitLines(twoDot.stdout), mode: 'two-dot' };
}

export function writeGithubOutput(skipHeavy, outputPath = process.env.GITHUB_OUTPUT) {
  if (!outputPath) return false;
  appendFileSync(outputPath, `skip_heavy=${skipHeavy ? 'true' : 'false'}\n`);
  return true;
}

export function formatReport(result) {
  const lines = [
    `PATH-GATE: skip_heavy=${result.skipHeavy ? 'true' : 'false'}`,
    `PATH-GATE: mode=${result.mode}`,
    `PATH-GATE: files=${result.files.length}`,
  ];
  if (result.error) lines.push(`PATH-GATE: error=${result.error}`);
  for (const file of result.unsafe) lines.push(`PATH-GATE: unsafe=${file}`);
  for (const file of result.files) lines.push(`PATH-GATE: path=${file}`);
  return `${lines.join('\n')}\n`;
}

function splitLines(text) {
  return String(text).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function runGit(args) {
  return spawnSync('git', args, { encoding: 'utf8' });
}

function parseArgs(argv) {
  const options = { filesFrom: null, git: false, base: 'FETCH_HEAD', head: 'HEAD' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--files-from') {
      options.filesFrom = argv[i + 1];
      i += 1;
    } else if (arg === '--git') {
      options.git = true;
    } else if (arg === '--base') {
      options.base = argv[i + 1];
      i += 1;
    } else if (arg === '--head') {
      options.head = argv[i + 1];
      i += 1;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

function loadFiles(options) {
  if (options.filesFrom) {
    try {
      return {
        files: splitLines(readFileSync(options.filesFrom, 'utf8')),
        mode: 'files',
      };
    } catch (error) {
      return { files: null, mode: 'error', error: error.message };
    }
  }
  if (options.git) {
    return listGitChangedFiles({ base: options.base, head: options.head });
  }
  return { files: null, mode: 'error', error: 'pass --files-from or --git' };
}

export function runPathGate(argv = process.argv.slice(2), env = process.env) {
  let result;
  try {
    const options = parseArgs(argv);
    const listed = loadFiles(options);
    result = classifyPaths(listed.files, { mode: listed.mode, error: listed.error });
  } catch (error) {
    result = classifyPaths(null, { error: error.message });
  }
  writeGithubOutput(result.skipHeavy, env.GITHUB_OUTPUT);
  return result;
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  const result = runPathGate();
  process.stdout.write(formatReport(result));
  process.exit(0);
}
