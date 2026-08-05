/**
 * Kimi Code subscription auth — API access via the Kimi Code CLI login.
 *
 * Reads the Kimi Code CLI's persisted OAuth session
 * (`~/.kimi-code/credentials/kimi-code.json`) and refreshes the access
 * token through Kimi's OAuth token endpoint, then serves
 * `{ apiKey, baseUrl }` for the OpenAI-compatible transport against
 * `https://api.kimi.com/coding/v1`.
 *
 * Reference: MoonshotAI/kimi-code `packages/oauth/src/oauth.ts`
 * (grant_type=refresh_token at `${oauthHost}/api/oauth/token`).
 *
 * Design notes:
 *   - This is the subscription credential class (`kimi-code` scope), NOT the
 *     Moonshot open-platform API key. `api.moonshot.ai` rejects these tokens.
 *   - Access tokens expire quickly (~900s); refresh is lazy, once per
 *     credential generation (single-flight) and best-effort write-back.
 *   - The credentials file is owned by the Kimi Code CLI; write-back failures
 *     (permissions, concurrent CLI ownership) are non-fatal — the refreshed
 *     token is still used in memory.
 *
 * Dependencies: Node.js stdlib only — no new npm packages.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { URLSearchParams } from 'node:url';
import { fetchWithConfiguredProxy } from './proxy-fetch.js';

// ── Constants ─────────────────────────────────────────────

export const KIMI_OAUTH_HOST = 'https://auth.kimi.com';
export const KIMI_OAUTH_CLIENT_ID = '17e5f671-d194-4dfb-9706-5516cb48c098';
export const KIMI_OAUTH_TOKEN_ENDPOINT = `${KIMI_OAUTH_HOST}/api/oauth/token`;
export const KIMI_CODE_BASE_URL = 'https://api.kimi.com/coding/v1';
export const KIMI_CODE_CREDENTIALS_PATH = join(
  homedir(),
  '.kimi-code',
  'credentials',
  'kimi-code.json',
);

/**
 * Kimi access tokens live ~900s (expires_in from the token response).
 * Refresh when expiring within this skew so in-flight runs stay warm.
 */
const KIMI_ACCESS_TOKEN_REFRESH_SKEW_SECONDS = 60;
const KIMI_REFRESH_TIMEOUT_SECONDS = 20;

// ── Types ─────────────────────────────────────────────────

export interface KimiCodeCredential {
  apiKey: string;
  baseUrl: string;
  source: string;
}

export class KimiCodeAuthError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'KimiCodeAuthError';
    this.code = code;
  }
}

interface KimiCredentialsFile {
  access_token?: string;
  refresh_token?: string;
  expires_at?: number;
  token_type?: string;
}

export interface KimiCredentialsSnapshot {
  path: string;
  raw: KimiCredentialsFile;
}

// ── Credentials file I/O ─────────────────────────────────

export function _readKimiCredentials(path: string): KimiCredentialsFile | null {
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'));
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed as KimiCredentialsFile;
  } catch {
    return null;
  }
}

function writeBackCredentials(path: string, raw: KimiCredentialsFile, updated: KimiCredentialsFile): void {
  try {
    writeFileSync(path, `${JSON.stringify({ ...raw, ...updated }, null, 2)}\n`, { mode: 0o600 });
  } catch {
    // Best-effort: the Kimi Code CLI owns this file. On failure the refreshed
    // token is still used in memory for this process.
  }
}

// ── Refresh ───────────────────────────────────────────────

export async function refreshKimiCodeAccessToken(
  refreshToken: string,
  opts: { tokenEndpoint?: string; timeoutSeconds?: number; fetchImpl?: typeof fetch } = {},
): Promise<{ access_token: string; refresh_token: string; expires_in: number }> {
  if (!refreshToken?.trim()) {
    throw new KimiCodeAuthError(
      'Kimi Code OAuth is missing refresh_token. Re-authenticate with the Kimi Code CLI.',
      'kimi_auth_missing_refresh_token',
    );
  }

  const endpoint = opts.tokenEndpoint?.trim() || KIMI_OAUTH_TOKEN_ENDPOINT;
  const timeoutSeconds = Math.max(5, opts.timeoutSeconds ?? KIMI_REFRESH_TIMEOUT_SECONDS);
  const body = new URLSearchParams({
    client_id: KIMI_OAUTH_CLIENT_ID,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });

  const fetchImpl = opts.fetchImpl ?? fetchWithConfiguredProxy;
  let response: Response;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutSeconds * 1000);
    response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: body.toString(),
      signal: controller.signal,
    });
    clearTimeout(timer);
  } catch (error) {
    throw new KimiCodeAuthError(
      `Kimi token refresh failed: ${(error as Error).message}`,
      'kimi_refresh_failed',
    );
  }

  const responseText = await response.text();
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(responseText) as Record<string, unknown>;
  } catch {
    throw new KimiCodeAuthError(
      'Kimi token refresh returned invalid JSON',
      'kimi_refresh_invalid_json',
    );
  }

  if (response.status !== 200) {
    throw new KimiCodeAuthError(
      `Kimi token refresh failed (HTTP ${response.status}). ${responseText.slice(0, 500)}`,
      'kimi_refresh_failed',
    );
  }

  const accessToken = String(payload.access_token ?? '').trim();
  if (!accessToken) {
    throw new KimiCodeAuthError(
      'Kimi token refresh response missing access_token',
      'kimi_refresh_missing_access_token',
    );
  }

  return {
    access_token: accessToken,
    refresh_token: String(payload.refresh_token || refreshToken).trim(),
    expires_in: typeof payload.expires_in === 'number' ? payload.expires_in : 900,
  };
}

// ── Credential resolution ────────────────────────────────

function isAccessTokenExpiring(expiresAt: number | undefined, nowMs: number): boolean {
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) return true;
  return expiresAt * 1000 - nowMs <= KIMI_ACCESS_TOKEN_REFRESH_SKEW_SECONDS * 1000;
}

type KimiRefreshFn = typeof refreshKimiCodeAccessToken;

// Single-flight: concurrent callers share one refresh; the winner persists.
const refreshQueues = new Map<string, Promise<string>>();

export async function resolveKimiCodeCredential(options: {
  credentialsPath?: string;
  nowMs?: number;
  refresh?: KimiRefreshFn;
  fetchImpl?: typeof fetch;
} = {}): Promise<KimiCodeCredential> {
  const path = options.credentialsPath ?? KIMI_CODE_CREDENTIALS_PATH;
  const nowMs = options.nowMs ?? Date.now();

  const raw = _readKimiCredentials(path);
  const refreshToken = raw?.refresh_token;
  if (!refreshToken) {
    throw new KimiCodeAuthError(
      'Kimi Code subscription not found. Log in with the Kimi Code CLI to enable kimi provider.',
      'kimi_auth_not_configured',
    );
  }

  const accessToken = raw.access_token && !isAccessTokenExpiring(raw.expires_at, nowMs)
    ? raw.access_token
    : await serializeRefresh(path, async () => {
        const refreshed = await (options.refresh ?? refreshKimiCodeAccessToken)(
          refreshToken,
          { fetchImpl: options.fetchImpl },
        );
        writeBackCredentials(path, raw, {
          access_token: refreshed.access_token,
          refresh_token: refreshed.refresh_token,
          expires_at: Math.floor((nowMs + refreshed.expires_in * 1000) / 1000),
          token_type: 'Bearer',
        });
        return refreshed.access_token;
      });

  return {
    apiKey: accessToken,
    baseUrl: KIMI_CODE_BASE_URL,
    source: `kimi-code/credentials/kimi-code.json`,
  };
}

function serializeRefresh(path: string, refresh: () => Promise<string>): Promise<string> {
  const queued = refreshQueues.get(path);
  if (queued) return queued;
  const run = refresh().finally(() => {
    refreshQueues.delete(path);
  });
  refreshQueues.set(path, run);
  return run;
}

// ── Status ─────────────────────────────────────────────────

export function getKimiCodeStatus(): {
  loggedIn: boolean;
  expiresAt?: string;
  remainingSeconds?: number;
  source?: string;
} {
  const raw = _readKimiCredentials(KIMI_CODE_CREDENTIALS_PATH);
  if (!raw?.refresh_token) {
    return { loggedIn: false };
  }
  const expiresAt = typeof raw.expires_at === 'number' ? raw.expires_at * 1000 : undefined;
  return {
    loggedIn: Boolean(raw.access_token),
    expiresAt: expiresAt ? new Date(expiresAt).toISOString() : undefined,
    remainingSeconds: expiresAt
      ? Math.max(0, Math.floor((expiresAt - Date.now()) / 1000))
      : undefined,
    source: KIMI_CODE_CREDENTIALS_PATH,
  };
}
