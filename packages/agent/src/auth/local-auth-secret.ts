/**
 * Read-only local auth store secret extraction for MCP credential_ref.
 *
 * Supports only `local-file:los-auth/<provider-key>` refs. Reads
 * `~/.los/auth.json` providers entries and returns the access token string.
 * Fail-closed: missing path, missing provider, or missing token returns a
 * typed reason via `readLocalAuthSecretResult`.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const LOS_AUTH_PREFIX = 'local-file:los-auth/';
const DEFAULT_AUTH_PATH = join(homedir(), '.los', 'auth.json');

export type LocalAuthSecretRead =
  | { ok: true; value: string; providerKey: string }
  | { ok: false; reason: string };

export interface ReadLocalAuthSecretOptions {
  authPath?: string;
}

/**
 * Parse and read `local-file:los-auth/<provider-key>` from the LOS auth store.
 * Production callers use the Result form so reason codes stay fail-closed.
 */
export function readLocalAuthSecretResult(
  ref: string,
  options: ReadLocalAuthSecretOptions = {},
): LocalAuthSecretRead {
  const trimmed = ref.trim();
  if (!trimmed.startsWith(LOS_AUTH_PREFIX)) {
    return { ok: false, reason: 'local_file_prefix_not_allowed' };
  }
  const providerKey = trimmed.slice(LOS_AUTH_PREFIX.length).trim();
  if (!providerKey || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,190}$/.test(providerKey)) {
    return { ok: false, reason: 'local_file_provider_key_invalid' };
  }
  if (providerKey.includes('..') || providerKey.startsWith('/') || providerKey.includes('\\')) {
    return { ok: false, reason: 'local_file_provider_key_invalid' };
  }

  const authPath = options.authPath ?? DEFAULT_AUTH_PATH;
  if (!existsSync(authPath)) {
    return { ok: false, reason: 'local_file_reader_unavailable' };
  }

  let store: unknown;
  try {
    store = JSON.parse(readFileSync(authPath, 'utf-8'));
  } catch {
    return { ok: false, reason: 'local_file_reader_unavailable' };
  }
  if (!isRecord(store)) {
    return { ok: false, reason: 'local_file_reader_unavailable' };
  }

  const providers = store.providers;
  if (!isRecord(providers)) {
    return { ok: false, reason: 'local_file_secret_missing' };
  }

  const entry = providers[providerKey];
  if (!isRecord(entry)) {
    return { ok: false, reason: 'local_file_secret_missing' };
  }

  const token = extractAccessToken(entry);
  if (!token) {
    return { ok: false, reason: 'local_file_secret_missing' };
  }
  return { ok: true, value: token, providerKey };
}

function extractAccessToken(entry: Record<string, unknown>): string | null {
  // xAI / generic OAuth shape: { tokens: { access_token } }
  const tokens = entry.tokens;
  if (isRecord(tokens) && typeof tokens.access_token === 'string') {
    const value = tokens.access_token.trim();
    if (value) return value;
  }
  // Minimal flat shape: { access_token }
  if (typeof entry.access_token === 'string') {
    const value = entry.access_token.trim();
    if (value) return value;
  }
  // Provider apiKey shape used by some credential resolvers
  if (typeof entry.apiKey === 'string') {
    const value = entry.apiKey.trim();
    if (value) return value;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
