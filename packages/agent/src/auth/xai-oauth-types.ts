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
  /** Monotonic fence for refresh, login, and logout mutations. */
  credential_generation?: number;
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

export class XaiOAuthError extends Error {
  public readonly code: string;
  public readonly isTerminal: boolean;
  public readonly reloginRequired: boolean;

  constructor(message: string, code: string, reloginRequired = false) {
    super(message);
    this.name = 'XaiOAuthError';
    this.code = code;
    this.isTerminal = reloginRequired
      || ['xai_oauth_tier_denied', 'xai_refresh_missing_access_token'].includes(code);
    this.reloginRequired = this.isTerminal;
  }
}
