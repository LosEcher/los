/**
 * xAI OAuth PKCE login flow — interactive browser-based authentication.
 *
 * This file contains the login ceremony: OIDC discovery, PKCE generation,
 * browser open, loopback HTTP server, token exchange, and token persistence.
 *
 * Runtime credential resolution lives in xai-oauth.ts; the store and shared
 * types live in the adjacent xai-oauth-store.ts and xai-oauth-types.ts modules.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { URL, URLSearchParams } from 'node:url';
import {
  XAI_OAUTH_CLIENT_ID,
  XAI_OAUTH_SCOPE,
  XAI_OAUTH_REDIRECT_HOST,
  XAI_OAUTH_REDIRECT_PORT,
  XAI_OAUTH_REDIRECT_PATH,
  XAI_OAUTH_DISCOVERY_URL,
  saveXaiOAuthState,
  XaiOAuthError,
  type XaiOAuthState,
  type XaiOAuthTokens,
  type XaiLoginOptions,
} from './xai-oauth.js';
import { fetchWithConfiguredProxy } from './proxy-fetch.js';

// ── OIDC Discovery ────────────────────────────────────────

interface XaiOAuthDiscovery {
  authorization_endpoint: string;
  token_endpoint: string;
}

async function xaiOAuthDiscovery(timeoutSeconds: number = 15): Promise<XaiOAuthDiscovery> {
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
  try {
    payload = await response.json();
  } catch {
    throw new XaiOAuthError(
      'xAI OIDC discovery returned invalid JSON',
      'xai_discovery_invalid',
    );
  }

  const authorizationEndpoint = String(payload?.authorization_endpoint ?? '').trim();
  const tokenEndpoint = String(payload?.token_endpoint ?? '').trim();

  if (!authorizationEndpoint || !tokenEndpoint) {
    throw new XaiOAuthError(
      'xAI OIDC discovery response missing required endpoints',
      'xai_discovery_incomplete',
    );
  }

  validateOAuthEndpoint(authorizationEndpoint, 'authorization_endpoint');
  validateOAuthEndpoint(tokenEndpoint, 'token_endpoint');

  return { authorization_endpoint: authorizationEndpoint, token_endpoint: tokenEndpoint };
}

function validateOAuthEndpoint(url: string, field: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new XaiOAuthError(
      `xAI OIDC discovery ${field} is not a valid URL: ${JSON.stringify(url)}`,
      'xai_discovery_invalid',
    );
  }
  if (parsed.protocol !== 'https:') {
    throw new XaiOAuthError(
      `xAI OIDC discovery returned a non-HTTPS ${field}: ${JSON.stringify(url)}`,
      'xai_discovery_invalid',
    );
  }
  const host = parsed.hostname.toLowerCase();
  if (!host || (host !== 'x.ai' && !host.endsWith('.x.ai'))) {
    throw new XaiOAuthError(
      `xAI OIDC discovery ${field} host ${JSON.stringify(host)} is not on the xAI origin`,
      'xai_discovery_invalid',
    );
  }
}

// ── PKCE Helpers ──────────────────────────────────────────

function pkceCodeVerifier(): string {
  return randomBytes(64).toString('base64url');
}

function pkceCodeChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

function randomHex(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}

// ── Browser Open ──────────────────────────────────────────

function openBrowser(url: string): boolean {
  try {
    if (process.platform === 'darwin') {
      execSync(`open "${url}"`, { stdio: 'ignore' });
      return true;
    }
    if (process.platform === 'linux') {
      execSync(`xdg-open "${url}"`, { stdio: 'ignore' });
      return true;
    }
    if (process.platform === 'win32') {
      execSync(`start "" "${url}"`, { stdio: 'ignore' });
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

function isRemoteSession(): boolean {
  return !!(process.env.SSH_TTY || process.env.SSH_CONNECTION || process.env.SSH_CLIENT);
}

// ── Loopback Server ───────────────────────────────────────

interface CallbackResult {
  code?: string;
  state?: string;
  error?: string;
  error_description?: string;
  _manual_paste?: boolean;
}

function startCallbackServer(): {
  server: ReturnType<typeof createServer>;
  result: Promise<CallbackResult>;
  redirectUri: string;
} {
  let resolveResult!: (value: CallbackResult) => void;
  const result = new Promise<CallbackResult>(resolve => {
    resolveResult = resolve;
  });

  const redirectUri = `http://${XAI_OAUTH_REDIRECT_HOST}:${XAI_OAUTH_REDIRECT_PORT}${XAI_OAUTH_REDIRECT_PATH}`;

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url ?? '/', redirectUri);
      if (url.pathname === XAI_OAUTH_REDIRECT_PATH || url.pathname === '/callback') {
        const code = url.searchParams.get('code') ?? undefined;
        const state = url.searchParams.get('state') ?? undefined;
        const error = url.searchParams.get('error') ?? undefined;
        const errorDescription = url.searchParams.get('error_description') ?? undefined;

        if (error) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(`<html><body><h1>Authorization Failed</h1><p>${errorDescription ?? error}</p></body></html>`);
        } else {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<html><body><h1>Authorization Successful</h1><p>You may close this window.</p></body></html>');
        }

        resolveResult({ code, state, error, error_description: errorDescription });
      } else {
        res.writeHead(404);
        res.end('Not found');
      }
    } catch {
      res.writeHead(500);
      res.end('Internal error');
    }
  });

  server.listen(XAI_OAUTH_REDIRECT_PORT, XAI_OAUTH_REDIRECT_HOST);

  return { server, result, redirectUri };
}

function parseManualCallback(input: string, expectedRedirectUri: string): CallbackResult {
  const trimmed = input.trim();

  if (!trimmed.includes('=') && !trimmed.includes(' ') && trimmed.length > 10) {
    return { code: trimmed, state: undefined, _manual_paste: true };
  }

  try {
    const url = new URL(trimmed);
    return {
      code: url.searchParams.get('code') ?? undefined,
      state: url.searchParams.get('state') ?? undefined,
      error: url.searchParams.get('error') ?? undefined,
      error_description: url.searchParams.get('error_description') ?? undefined,
      _manual_paste: true,
    };
  } catch {
    const params = new URLSearchParams(trimmed.startsWith('?') ? trimmed.slice(1) : trimmed);
    return {
      code: params.get('code') ?? undefined,
      state: params.get('state') ?? undefined,
      error: params.get('error') ?? undefined,
      error_description: params.get('error_description') ?? undefined,
      _manual_paste: true,
    };
  }
}

// ── Token Exchange ────────────────────────────────────────

async function exchangeCodeForTokens(params: {
  tokenEndpoint: string;
  code: string;
  redirectUri: string;
  codeVerifier: string;
  codeChallenge: string;
  timeoutSeconds: number;
}): Promise<XaiOAuthTokens & { raw: Record<string, unknown> }> {
  const { tokenEndpoint, code, redirectUri, codeVerifier, codeChallenge, timeoutSeconds } = params;

  if (!codeVerifier) {
    throw new XaiOAuthError(
      'xAI token exchange refused: PKCE code_verifier is empty. This is a bug in los.',
      'xai_pkce_verifier_missing',
    );
  }

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: XAI_OAUTH_CLIENT_ID,
    code_verifier: codeVerifier,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });

  let response: Response;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(20, timeoutSeconds) * 1000);
    response = await fetchWithConfiguredProxy(tokenEndpoint, {
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
      `xAI token exchange failed: ${err.message}`,
      'xai_token_exchange_failed',
    );
  }

  const responseText = await response.text();
  let payload: any;
  try {
    payload = JSON.parse(responseText);
  } catch {
    throw new XaiOAuthError(
      `xAI token exchange returned invalid JSON`,
      'xai_token_exchange_invalid',
    );
  }

  if (response.status !== 200) {
    if (response.status === 403) {
      throw new XaiOAuthError(
        `xAI token exchange failed (HTTP 403). This OAuth account is not authorized ` +
        `for xAI API access — xAI may be restricting API/OAuth use to specific ` +
        `SuperGrok tiers. Set XAI_API_KEY and switch to the API-key path if available, ` +
        `or upgrade your subscription at https://x.ai/grok.`,
        'xai_oauth_tier_denied',
        false,
      );
    }
    throw new XaiOAuthError(
      `xAI token exchange failed (HTTP ${response.status}). Response: ${responseText.slice(0, 500)}`,
      'xai_token_exchange_failed',
    );
  }

  if (!payload || typeof payload !== 'object') {
    throw new XaiOAuthError(
      'xAI token exchange response was not a JSON object',
      'xai_token_exchange_invalid',
    );
  }

  const accessToken = String(payload.access_token ?? '').trim();
  const refreshToken = String(payload.refresh_token ?? '').trim();

  if (!accessToken) {
    throw new XaiOAuthError(
      'xAI token exchange did not return an access_token',
      'xai_token_exchange_invalid',
    );
  }
  if (!refreshToken) {
    throw new XaiOAuthError(
      'xAI token exchange did not return a refresh_token',
      'xai_token_exchange_invalid',
    );
  }

  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    id_token: String(payload.id_token ?? '').trim(),
    expires_in: typeof payload.expires_in === 'number' ? payload.expires_in : undefined,
    token_type: String(payload.token_type || 'Bearer').trim() || 'Bearer',
    raw: payload,
  };
}

// ── Login Flow ─────────────────────────────────────────────

function buildAuthorizeUrl(params: {
  authEndpoint: string;
  redirectUri: string;
  codeChallenge: string;
  state: string;
  nonce: string;
}): string {
  const { authEndpoint, redirectUri, codeChallenge, state, nonce } = params;
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: XAI_OAUTH_CLIENT_ID,
    redirect_uri: redirectUri,
    scope: XAI_OAUTH_SCOPE,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state,
    nonce,
    plan: 'generic',
    referrer: 'los',
  });
  return `${authEndpoint}?${query.toString()}`;
}

async function promptManualPaste(redirectUri: string): Promise<CallbackResult> {
  const readline = await import('node:readline');
  const { stdin, stdout } = await import('node:process');

  console.log();
  console.log('Paste the full callback URL from your browser (or the bare authorization code):');

  const rl = readline.createInterface({ input: stdin, output: stdout });
  const input = await new Promise<string>(resolve => {
    rl.question('> ', answer => {
      rl.close();
      resolve(answer.trim());
    });
  });

  return parseManualCallback(input, redirectUri);
}

export async function xaiOAuthLogin(options: XaiLoginOptions = {}): Promise<XaiOAuthState> {
  const timeoutSeconds = options.timeoutSeconds ?? 20;
  const openBrowser_ = options.openBrowser !== false;
  const manualPaste = options.manualPaste === true;

  console.log('Signing in to xAI Grok OAuth (SuperGrok / Premium+)...');
  console.log('(los creates its own local OAuth session)');
  console.log();

  const discovery = await xaiOAuthDiscovery(timeoutSeconds);
  const { authorization_endpoint: authEndpoint, token_endpoint: tokenEndpoint } = discovery;

  const codeVerifier = pkceCodeVerifier();
  const codeChallenge = pkceCodeChallenge(codeVerifier);
  const state_ = randomHex(16);
  const nonce = randomHex(16);

  let redirectUri: string;
  let callback: CallbackResult;

  if (manualPaste) {
    redirectUri = `http://${XAI_OAUTH_REDIRECT_HOST}:${XAI_OAUTH_REDIRECT_PORT}${XAI_OAUTH_REDIRECT_PATH}`;
    const authorizeUrl = buildAuthorizeUrl({ authEndpoint, redirectUri, codeChallenge, state: state_, nonce });
    console.log('Open this URL to authorize los with xAI:');
    console.log(authorizeUrl);
    callback = await promptManualPaste(redirectUri);
  } else {
    const { server, result, redirectUri: serverRedirectUri } = startCallbackServer();
    redirectUri = serverRedirectUri;

    const authorizeUrl = buildAuthorizeUrl({ authEndpoint, redirectUri, codeChallenge, state: state_, nonce });

    try {
      console.log('Open this URL to authorize los with xAI:');
      console.log(authorizeUrl);
      console.log();
      console.log(`Waiting for callback on ${redirectUri}`);
      console.log();

      const canOpen = openBrowser_ && !isRemoteSession();
      if (canOpen && openBrowser(authorizeUrl)) {
        console.log('Browser opened for xAI authorization.');
      } else if (canOpen) {
        console.log('Could not open the browser automatically; use the URL above.');
      }

      const timeout = Math.max(30, timeoutSeconds * 9) * 1000;
      const timeoutPromise = new Promise<CallbackResult>((_, reject) => {
        setTimeout(() => reject(new XaiOAuthError(
          'xAI loopback callback timed out.',
          'xai_callback_timeout',
        )), timeout);
      });

      callback = await Promise.race([result, timeoutPromise]);
    } finally {
      try { server.close(); } catch { /* ignore */ }
    }
  }

  if (callback.error) {
    const detail = callback.error_description || callback.error;
    throw new XaiOAuthError(
      `xAI authorization failed: ${detail}`,
      'xai_authorization_failed',
    );
  }

  const callbackState = callback.state;
  if (callbackState && callbackState !== state_ && !callback._manual_paste) {
    throw new XaiOAuthError(
      'xAI authorization failed: state mismatch',
      'xai_state_mismatch',
    );
  }

  const code = (callback.code ?? '').trim();
  if (!code) {
    throw new XaiOAuthError(
      'xAI authorization failed: missing authorization code',
      'xai_code_missing',
    );
  }

  const tokens = await exchangeCodeForTokens({
    tokenEndpoint,
    code,
    redirectUri,
    codeVerifier,
    codeChallenge,
    timeoutSeconds,
  });

  const oauthState: XaiOAuthState = {
    tokens: {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      id_token: tokens.id_token,
      expires_in: tokens.expires_in,
      token_type: tokens.token_type,
    },
    discovery,
    redirect_uri: redirectUri,
    last_refresh: new Date().toISOString().replace('+00:00', 'Z'),
    auth_mode: 'oauth_pkce',
  };

  return await saveXaiOAuthState(oauthState);
}
