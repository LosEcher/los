#!/usr/bin/env node
/**
 * Emit a mode-only snapshot of an executor `.env` file.
 *
 * Why this exists: `deploy-to-remote.sh` must validate the same lines the
 * executor process reads. `loadEnvFile()` in packages/infra/src/config-sources.ts
 * uses JavaScript `.trim()` (which strips BOM, NBSP and other Unicode
 * whitespace) and last-assignment-wins. A bash `grep`/`awk` parser disagreed on
 * a BOM-prefixed `DATABASE_URL` and produced a false green for
 * `EXECUTOR_DB_MODE=none` + `DATABASE_URL`. This helper is the single parser
 * used locally (`mode-check`) and on the node (preflight/verify/mode).
 *
 * It prints only mode-shaped keys; `DATABASE_URL` is reduced to `<redacted>` and
 * every other value is passed through. It is not a general dotenv loader.
 */
import { readFileSync, statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const SENTINELS = {
  missing: '__ENV_MISSING__',
  unreadable: '__ENV_UNREADABLE__',
  notAFile: '__ENV_NOT_A_FILE__',
};

/**
 * Parse dotenv text with the exact algorithm of `loadEnvFile()`.
 * Keep this in lockstep with packages/infra/src/config-sources.ts; the test
 * asserts parity against the compiled/source implementation when it is
 * available.
 */
export function parseEnvText(content) {
  const result = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    result[key] = value;
  }
  return result;
}

/** Returns a snapshot object plus a sentinel marker when the file is unusable. */
export function snapshotFor(raw) {
  const env = parseEnvText(raw);
  const value = (key) => env[key] ?? '';
  return {
    EXECUTOR_DB_MODE: value('EXECUTOR_DB_MODE'),
    EXECUTOR_TASK_TOKEN_MODE: value('EXECUTOR_TASK_TOKEN_MODE'),
    GATEWAY_URL: value('GATEWAY_URL'),
    EXECUTOR_HOST: value('EXECUTOR_HOST'),
    EXECUTOR_PORT: value('EXECUTOR_PORT'),
    DATABASE_URL: value('DATABASE_URL') ? '<redacted>' : '',
  };
}

export function serializeSnapshot(snapshot) {
  return Object.entries(snapshot).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
}

/** Read a path and return a serialized snapshot or a single sentinel line. */
export function snapshotPath(path) {
  let stat;
  try {
    stat = statSync(path);
  } catch (err) {
    if (err?.code === 'ENOENT') return `${SENTINELS.missing}\n`;
    if (err?.code === 'EACCES' || err?.code === 'EPERM') return `${SENTINELS.unreadable}\n`;
    throw err;
  }
  if (!stat.isFile()) return `${SENTINELS.notAFile}\n`;
  try {
    return serializeSnapshot(snapshotFor(readFileSync(path, 'utf8')));
  } catch (err) {
    if (err?.code === 'EACCES' || err?.code === 'EPERM') return `${SENTINELS.unreadable}\n`;
    throw err;
  }
}

const invokedDirectly = process.argv[1] === '-' ||
  (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href);

if (invokedDirectly) {
  const file = process.argv[2];
  if (!file) {
    console.error('usage: executor-mode-snapshot.mjs <env-file>');
    process.exit(2);
  }
  process.stdout.write(snapshotPath(file));
}
