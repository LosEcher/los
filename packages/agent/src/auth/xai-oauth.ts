/**
 * xAI OAuth PKCE — Grok API access via SuperGrok / Premium+ subscription.
 *
 * Core module: token refresh, credential resolution, and status.
 * Store and type definitions live in the adjacent xai-oauth-store.ts and
 * xai-oauth-types.ts modules.
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

import { URL, URLSearchParams } from 'node:url';
import { requireProviderDefaults } from '@los/infra/provider-defaults';
import { _xaiOAuthStore, type _XaiOAuthStore } from './xai-oauth-store.js';
import { fetchWithConfiguredProxy } from './proxy-fetch.js';
import {
  XaiOAuthError,
  type XaiLoginOptions,
  type XaiOAuthCredential,
  type XaiOAuthState,
  type XaiOAuthStatus,
  type XaiOAuthTokens,
} from './xai-oauth-types.js';

export {
  XaiOAuthError,
  type XaiLoginOptions,
  type XaiOAuthCredential,
  type XaiOAuthState,
  type XaiOAuthStatus,
  type XaiOAuthTokens,
} from './xai-oauth-types.js';

// ── Constants ─────────────────────────────────────────────

export const XAI_OAUTH_ISSUER = 'https://auth.x.ai';
export const XAI_OAUTH_DISCOVERY_URL = `${XAI_OAUTH_ISSUER}/.well-known/openid-configuration`;
export const XAI_OAUTH_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828';
export const XAI_OAUTH_SCOPE = 'openid profile email offline_access grok-cli:access api:access';
export const XAI_OAUTH_REDIRECT_HOST = '127.0.0.1';
export const XAI_OAUTH_REDIRECT_PORT = 56121;
export const XAI_OAUTH_REDIRECT_PATH = '/callback';
const DEFAULT_XAI_OAUTH_BASE_URL = requireProviderDefaults('xai').baseUrl;

/**
 * xAI access tokens are ~6h TTL in SuperGrok flows.
 * Refresh up to 1 hour early so ordinary runtime calls keep the token warm.
 */
const ACCESS_TOKEN_REFRESH_SKEW_SECONDS = 3600;

// ── Auth Store ────────────────────────────────────────────

/**
 * Load the xai-oauth provider state from the local auth store.
 * Checks LOS's own store first, then reads Hermes as an external fallback.
 */
export function loadXaiOAuthState(): XaiOAuthState | null {
  return _xaiOAuthStore.load();
}

export async function saveXaiOAuthState(state: XaiOAuthState): Promise<XaiOAuthState> {
  return _xaiOAuthStore.save(state);
}

export async function clearXaiOAuthTokens(): Promise<boolean> {
  return _xaiOAuthStore.clear();
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
    response = await fetchWithConfiguredProxy(endpoint, {
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
    response = await fetchWithConfiguredProxy(XAI_OAUTH_DISCOVERY_URL, {
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
type XaiRefreshFn = typeof refreshXaiOAuthToken;
const refreshQueues = new WeakMap<_XaiOAuthStore, Promise<void>>();

export async function resolveXaiOAuthCredential(): Promise<XaiOAuthCredential> {
  return _resolveXaiOAuthCredential();
}

export async function _resolveXaiOAuthCredential(options: {
  store?: _XaiOAuthStore;
  refresh?: XaiRefreshFn;
  baseUrl?: string;
} = {}): Promise<XaiOAuthCredential> {
  const store = options.store ?? _xaiOAuthStore;
  const initial = store.loadWithSource();
  if (!initial?.state.tokens.access_token) throw notConfiguredError();

  const baseUrl = options.baseUrl ?? validateInferenceBaseUrl(
    process.env.XAI_BASE_URL ?? process.env.HERMES_XAI_BASE_URL ?? '',
    DEFAULT_XAI_OAUTH_BASE_URL,
  );
  if (!isAccessTokenExpiring(initial.state.tokens.access_token, ACCESS_TOKEN_REFRESH_SKEW_SECONDS)) {
    return credentialFromState(initial.state, initial.source, baseUrl);
  }

  return serializeRefresh(store, () => store.withCredentialLock(async () => {
    const current = store.loadWithSource();
    if (!current?.state.tokens.access_token) throw notConfiguredError();
    if (!isAccessTokenExpiring(current.state.tokens.access_token, ACCESS_TOKEN_REFRESH_SKEW_SECONDS)) {
      return credentialFromState(current.state, current.source, baseUrl);
    }

    const generation = store.generation(current.state);
    try {
      const refreshed = await (options.refresh ?? refreshXaiOAuthToken)(
        current.state.tokens.refresh_token,
        { tokenEndpoint: current.state.discovery?.token_endpoint || '' },
      );
      const updated = store._saveWhileLocked({
        ...current.state,
        tokens: {
          ...current.state.tokens,
          access_token: refreshed.access_token,
          refresh_token: refreshed.refresh_token,
          id_token: refreshed.id_token || current.state.tokens.id_token,
          expires_in: refreshed.expires_in ?? current.state.tokens.expires_in,
          token_type: refreshed.token_type || current.state.tokens.token_type,
        },
        last_refresh: refreshed.last_refresh,
        last_auth_error: undefined,
      }, { expectedGeneration: generation });
      return credentialFromState(updated, 'los-auth-store', baseUrl);
    } catch (error) {
      if (error instanceof XaiOAuthError && error.isTerminal) {
        const cleared = store._clearWhileLocked({ expectedGeneration: generation });
        if (!cleared) {
          const sibling = store.loadWithSource();
          if (sibling && !isAccessTokenExpiring(sibling.state.tokens.access_token, 60)) {
            return credentialFromState(sibling.state, sibling.source, baseUrl);
          }
        }
      }
      if (error instanceof XaiOAuthError && error.code === 'xai_credential_generation_conflict') {
        const sibling = store.loadWithSource();
        if (sibling && !isAccessTokenExpiring(sibling.state.tokens.access_token, 60)) {
          return credentialFromState(sibling.state, sibling.source, baseUrl);
        }
      }
      throw error;
    }
  }));
}

// ── Status ─────────────────────────────────────────────────

export function getXaiOAuthStatus(): XaiOAuthStatus {
  const loaded = _xaiOAuthStore.loadWithSource();
  const state = loaded?.state;
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
    source: loaded?.source,
  };
}

function credentialFromState(
  state: XaiOAuthState,
  source: XaiOAuthCredential['source'],
  baseUrl: string,
): XaiOAuthCredential {
  return { apiKey: state.tokens.access_token, baseUrl, source, lastRefresh: state.last_refresh };
}

function notConfiguredError(): XaiOAuthError {
  return new XaiOAuthError(
    'xAI OAuth not configured. Run `los auth xai login` to authenticate.',
    'xai_not_configured',
    true,
  );
}

function serializeRefresh<T>(store: _XaiOAuthStore, action: () => Promise<T>): Promise<T> {
  const previous = refreshQueues.get(store) ?? Promise.resolve();
  const next = previous.then(action, action);
  refreshQueues.set(store, next.then(() => undefined, () => undefined));
  return next;
}
