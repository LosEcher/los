/**
 * xAI OAuth PKCE — Grok API access via SuperGrok / Premium+ subscription.
 *
 * Core module: auth store, types, token refresh, credential resolution, status.
 * The interactive login flow lives in xai-oauth-login.ts (imported by CLI only).
 *
 * Reference implementation: Hermes hermes_cli/auth.py (xAI OAuth path, ~600 lines).
 * Key design decisions:
 *   - OIDC discovery with *.x.ai host validation (MITM defence)
 *   - PKCE S256 with code_challenge echoed at token exchange (xAI re-validates)
 *   - Single-use refresh tokens (each refresh returns a new refresh_token)
 *   - plan=generic + referrer=los query params
 *   - 403 → tier denied; 400/401 → relogin required
 *
 * Dependencies: Node.js stdlib only — no new npm packages.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { URL, URLSearchParams } from 'node:url';

// ── Constants ─────────────────────────────────────────────

export const XAI_OAUTH_ISSUER = 'https://auth.x.ai';
export const XAI_OAUTH_DISCOVERY_URL = `${XAI_OAUTH_ISSUER}/.well-known/openid-configuration`;
export const XAI_OAUTH_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828';
export const XAI_OAUTH_SCOPE = 'openid profile email offline_access grok-cli:access api:access';
export const XAI_OAUTH_REDIRECT_HOST = '127.0.0.1';
export const XAI_OAUTH_REDIRECT_PORT = 56121;
export const XAI_OAUTH_REDIRECT_PATH = '/callback';
const DEFAULT_XAI_OAUTH_BASE_URL = 'https://api.x.ai/v1';

/**
 * xAI access tokens are ~6h TTL in SuperGrok flows.
 * Refresh up to 1 hour early so ordinary runtime calls keep the token warm.
 */
const ACCESS_TOKEN_REFRESH_SKEW_SECONDS = 3600;

// ── Types ─────────────────────────────────────────────────

export interface XaiOAuthTokens {
  access_token: string;
  refresh_token: string;
  id_token: string;
  expires_in?: number;
  token_type: string;
}

export interface XaiOAuthState {
  tokens: XaiOAuthTokens;
  discovery: { authorization_endpoint: string; token_endpoint: string };
  redirect_uri: string;
  last_refresh?: string;
  auth_mode: 'oauth_pkce';
  /** Stored when refresh/login fails terminally; cleared on next successful login. */
  last_auth_error?: {
    provider: string;
    code: string;
    message: string;
    at: string;
  };
}

export interface XaiOAuthCredential {
  apiKey: string;
  baseUrl: string;
  source: 'los-auth-store' | 'hermes-auth-store';
  lastRefresh?: string;
}

export interface XaiOAuthStatus {
  loggedIn: boolean;
  expiresAt?: string;
  remainingSeconds?: number;
  source?: string;
  error?: string;
}

export interface XaiLoginOptions {
  timeoutSeconds?: number;
  openBrowser?: boolean;
  manualPaste?: boolean;
}

// ── Auth Store ────────────────────────────────────────────

function authStorePath(): string {
  return join(homedir(), '.los', 'auth.json');
}

function ensureAuthDir(): void {
  const dir = dirname(authStorePath());
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function loadAuthStore(): Record<string, unknown> {
  const path = authStorePath();
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return {};
  }
}

function saveAuthStore(store: Record<string, unknown>): void {
  ensureAuthDir();
  writeFileSync(authStorePath(), JSON.stringify(store, null, 2) + '\n', 'utf-8');
}

/**
 * Load the xai-oauth provider state from the local auth store.
 * Checks los's own store first, then falls back to Hermes's auth.json.
 */
export function loadXaiOAuthState(): XaiOAuthState | null {
  // 1. los own store
  const store = loadAuthStore();
  const providers = (store.providers ?? {}) as Record<string, unknown>;
  const state = providers['xai-oauth'] as XaiOAuthState | undefined;
  if (state?.tokens?.access_token) return state;

  // 2. Fallback: Hermes auth.json
  try {
    const hermesPath = join(homedir(), '.hermes', 'auth.json');
    if (existsSync(hermesPath)) {
      const hermesStore = JSON.parse(readFileSync(hermesPath, 'utf-8'));
      const hermesProviders = (hermesStore.providers ?? {}) as Record<string, unknown>;
      const hermesState = hermesProviders['xai-oauth'] as XaiOAuthState | undefined;
      if (hermesState?.tokens?.access_token) {
        // Migrate to los store on read
        saveXaiOAuthState(hermesState);
        return hermesState;
      }
    }
  } catch {
    // Hermes store unreadable — not an error
  }

  return null;
}

export function saveXaiOAuthState(state: XaiOAuthState): void {
  const store = loadAuthStore();
  const providers = (store.providers ?? {}) as Record<string, unknown>;
  providers['xai-oauth'] = state;
  store.providers = providers;
  saveAuthStore(store);
}

export function clearXaiOAuthTokens(): void {
  const store = loadAuthStore();
  const providers = (store.providers ?? {}) as Record<string, unknown>;
  delete providers['xai-oauth'];
  store.providers = providers;
  saveAuthStore(store);
}

// ── JWT Helpers ───────────────────────────────────────────

/**
 * Decode a JWT access token's `exp` claim without verifying the signature.
 */
function decodeJwtExp(accessToken: string): number | undefined {
  if (typeof accessToken !== 'string' || !accessToken.includes('.')) return undefined;
  try {
    const parts = accessToken.split('.');
    if (parts.length < 2) return undefined;
    let payloadB64 = parts[1];
    payloadB64 += '='.repeat((4 - (payloadB64.length % 4)) % 4);
    const payload = JSON.parse(
      Buffer.from(payloadB64, 'base64url').toString('utf-8'),
    );
    const exp = payload.exp;
    if (typeof exp === 'number') return exp;
    return undefined;
  } catch {
    return undefined;
  }
}

function isAccessTokenExpiring(accessToken: string, skewSeconds: number = 0): boolean {
  const exp = decodeJwtExp(accessToken);
  if (exp === undefined) return false;
  return exp <= (Date.now() / 1000) + Math.max(0, skewSeconds);
}

// ── Endpoint Validation ──────────────────────────────────

function validateOAuthEndpoint(url: string, field: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new XaiOAuthError(
      `xAI OIDC endpoint ${field} is not a valid URL: ${JSON.stringify(url)}`,
      'xai_discovery_invalid',
    );
  }
  if (parsed.protocol !== 'https:') {
    throw new XaiOAuthError(
      `xAI OIDC endpoint is non-HTTPS: ${JSON.stringify(url)}`,
      'xai_discovery_invalid',
    );
  }
  const host = parsed.hostname.toLowerCase();
  if (!host || (host !== 'x.ai' && !host.endsWith('.x.ai'))) {
    throw new XaiOAuthError(
      `xAI OIDC endpoint host ${JSON.stringify(host)} is not on the xAI origin`,
      'xai_discovery_invalid',
    );
  }
}

function validateInferenceBaseUrl(value: string, fallback: string): string {
  const candidate = value.trim().replace(/\/+$/, '');
  if (!candidate) return fallback;

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    console.warn(`[xai-oauth] Ignoring malformed base_url ${JSON.stringify(candidate)}; using ${fallback}`);
    return fallback;
  }

  if (parsed.protocol !== 'https:') {
    console.warn(`[xai-oauth] Refusing non-HTTPS base_url ${JSON.stringify(candidate)}; using ${fallback}`);
    return fallback;
  }

  const host = parsed.hostname.toLowerCase();
  if (!host || (host !== 'api.x.ai' && !host.endsWith('.x.ai'))) {
    console.warn(`[xai-oauth] Refusing non-xAI base_url ${JSON.stringify(candidate)}; using ${fallback}`);
    return fallback;
  }

  return candidate;
}

// ── Token Refresh ─────────────────────────────────────────

/**
 * Refresh an xAI OAuth access token using the refresh_token grant.
 * xAI refresh tokens are single-use — each refresh returns a new refresh_token.
 */
export async function refreshXaiOAuthToken(
  refreshToken: string,
  opts: { tokenEndpoint?: string; timeoutSeconds?: number } = {},
): Promise<XaiOAuthTokens & { last_refresh: string }> {
  if (!refreshToken?.trim()) {
    throw new XaiOAuthError(
      'xAI OAuth is missing refresh_token. Re-authenticate with `los auth xai login`.',
      'xai_auth_missing_refresh_token',
      true,
    );
  }

  let endpoint = opts.tokenEndpoint?.trim() || '';
  if (!endpoint) {
    // Re-discover token endpoint
    const discovery = await fetchOidcDiscovery(opts.timeoutSeconds ?? 20);
    endpoint = discovery.token_endpoint;
  } else {
    validateOAuthEndpoint(endpoint, 'token_endpoint');
  }

  const timeoutSeconds = Math.max(5, opts.timeoutSeconds ?? 20);
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: XAI_OAUTH_CLIENT_ID,
    refresh_token: refreshToken,
  });

  let response: Response;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutSeconds * 1000);
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: body.toString(),
      signal: controller.signal,
    });
    clearTimeout(timer);
  } catch (err: any) {
    throw new XaiOAuthError(
      `xAI token refresh failed: ${err.message}`,
      'xai_refresh_failed',
    );
  }

  const responseText = await response.text();
  let payload: any;
  try {
    payload = JSON.parse(responseText);
  } catch {
    throw new XaiOAuthError(
      'xAI token refresh returned invalid JSON',
      'xai_refresh_invalid_json',
    );
  }

  if (response.status !== 200) {
    if (response.status === 403) {
      throw new XaiOAuthError(
        `xAI token refresh failed with HTTP 403. This OAuth account is not authorized ` +
        `for xAI API access — xAI may be restricting API/OAuth use to specific ` +
        `SuperGrok tiers. Set XAI_API_KEY if available, or upgrade your subscription ` +
        `at https://x.ai/grok.`,
        'xai_oauth_tier_denied',
        false,
      );
    }
    throw new XaiOAuthError(
      `xAI token refresh failed (HTTP ${response.status}). ${responseText.slice(0, 500)}`,
      'xai_refresh_failed',
      response.status === 400 || response.status === 401,
    );
  }

  const refreshedAccess = String(payload?.access_token ?? '').trim();
  if (!refreshedAccess) {
    throw new XaiOAuthError(
      'xAI token refresh response missing access_token',
      'xai_refresh_missing_access_token',
      true,
    );
  }

  return {
    access_token: refreshedAccess,
    refresh_token: String(payload.refresh_token || refreshToken).trim(),
    id_token: String(payload.id_token ?? '').trim(),
    expires_in: typeof payload.expires_in === 'number' ? payload.expires_in : undefined,
    token_type: String(payload.token_type || 'Bearer').trim() || 'Bearer',
    last_refresh: new Date().toISOString().replace('+00:00', 'Z'),
  };
}

async function fetchOidcDiscovery(timeoutSeconds: number): Promise<{ token_endpoint: string }> {
  let response: Response;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutSeconds * 1000);
    response = await fetch(XAI_OAUTH_DISCOVERY_URL, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    clearTimeout(timer);
  } catch (err: any) {
    throw new XaiOAuthError(
      `xAI OIDC discovery failed: ${err.message}`,
      'xai_discovery_failed',
    );
  }

  if (response.status !== 200) {
    throw new XaiOAuthError(
      `xAI OIDC discovery returned status ${response.status}`,
      'xai_discovery_failed',
    );
  }

  let payload: any;
  try { payload = await response.json(); } catch {
    throw new XaiOAuthError('xAI OIDC discovery returned invalid JSON', 'xai_discovery_invalid');
  }

  const tokenEndpoint = String(payload?.token_endpoint ?? '').trim();
  if (!tokenEndpoint) {
    throw new XaiOAuthError('xAI OIDC discovery missing token_endpoint', 'xai_discovery_incomplete');
  }
  validateOAuthEndpoint(tokenEndpoint, 'token_endpoint');
  return { token_endpoint: tokenEndpoint };
}

// ── Credential Resolution ─────────────────────────────────

/**
 * Resolve a ready-to-use xAI API credential from the local OAuth store.
 *
 * This is the main entry point called by the provider config layer. It:
 * 1. Reads the local auth store (los, then Hermes fallback)
 * 2. Checks if the access token is expiring
 * 3. Refreshes if needed, writes back to store
 * 4. Returns { apiKey, baseUrl } for the OpenAI-compatible transport
 */
export async function resolveXaiOAuthCredential(): Promise<XaiOAuthCredential> {
  const state = loadXaiOAuthState();
  if (!state?.tokens?.access_token) {
    throw new XaiOAuthError(
      'xAI OAuth not configured. Run `los auth xai login` to authenticate.',
      'xai_not_configured',
      true,
    );
  }

  const baseUrl = validateInferenceBaseUrl(
    process.env.XAI_BASE_URL ?? process.env.HERMES_XAI_BASE_URL ?? '',
    DEFAULT_XAI_OAUTH_BASE_URL,
  );

  let accessToken = state.tokens.access_token;
  let { refresh_token: refreshToken } = state.tokens;
  let lastRefresh = state.last_refresh;

  const needsRefresh = isAccessTokenExpiring(accessToken, ACCESS_TOKEN_REFRESH_SKEW_SECONDS);

  if (needsRefresh) {
    const tokenEndpoint = state.discovery?.token_endpoint || '';
    try {
      const refreshed = await refreshXaiOAuthToken(refreshToken, { tokenEndpoint });
      accessToken = refreshed.access_token;
      refreshToken = refreshed.refresh_token;
      lastRefresh = refreshed.last_refresh;

      const updatedState: XaiOAuthState = {
        ...state,
        tokens: {
          ...state.tokens,
          access_token: accessToken,
          refresh_token: refreshToken,
          id_token: refreshed.id_token || state.tokens.id_token,
          expires_in: refreshed.expires_in ?? state.tokens.expires_in,
          token_type: refreshed.token_type || state.tokens.token_type,
        },
        last_refresh: lastRefresh,
        last_auth_error: undefined,
      };
      saveXaiOAuthState(updatedState);
    } catch (err) {
      if (err instanceof XaiOAuthError && err.isTerminal) {
        try { clearXaiOAuthTokens(); } catch { /* best-effort */ }
      }
      throw err;
    }
  }

  return {
    apiKey: accessToken,
    baseUrl,
    source: 'los-auth-store',
    lastRefresh,
  };
}

/**
 * Synchronous: return the credential if the token is valid, or throw.
 * Does NOT refresh — use resolveXaiOAuthCredential() for the full path.
 */
export function getXaiOAuthCredentialSync(): XaiOAuthCredential {
  const state = loadXaiOAuthState();
  if (!state?.tokens?.access_token) {
    throw new XaiOAuthError(
      'xAI OAuth not configured. Run `los auth xai login` to authenticate.',
      'xai_not_configured',
      true,
    );
  }

  if (isAccessTokenExpiring(state.tokens.access_token, 60)) {
    throw new XaiOAuthError(
      'xAI access token is expired or expiring. Call resolveXaiOAuthCredential() to refresh.',
      'xai_token_expired',
      true,
    );
  }

  const baseUrl = validateInferenceBaseUrl(
    process.env.XAI_BASE_URL ?? process.env.HERMES_XAI_BASE_URL ?? '',
    DEFAULT_XAI_OAUTH_BASE_URL,
  );

  return {
    apiKey: state.tokens.access_token,
    baseUrl,
    source: 'los-auth-store',
    lastRefresh: state.last_refresh,
  };
}

// ── Status ─────────────────────────────────────────────────

export function getXaiOAuthStatus(): XaiOAuthStatus {
  const state = loadXaiOAuthState();
  if (!state?.tokens?.access_token) {
    return {
      loggedIn: false,
      error: state?.last_auth_error?.message,
    };
  }

  const exp = decodeJwtExp(state.tokens.access_token);
  const remainingSeconds = exp ? exp - Date.now() / 1000 : undefined;

  return {
    loggedIn: true,
    expiresAt: exp ? new Date(exp * 1000).toISOString() : undefined,
    remainingSeconds: remainingSeconds && remainingSeconds > 0 ? remainingSeconds : 0,
    source: 'los-auth-store',
  };
}

// ── Error ──────────────────────────────────────────────────

export class XaiOAuthError extends Error {
  public readonly code: string;
  public readonly isTerminal: boolean;
  public readonly reloginRequired: boolean;

  constructor(message: string, code: string, reloginRequired = false) {
    super(message);
    this.name = 'XaiOAuthError';
    this.code = code;
    this.isTerminal = ['xai_oauth_tier_denied', 'xai_refresh_missing_access_token'].includes(code);
    this.reloginRequired = reloginRequired || this.isTerminal;
  }
}
