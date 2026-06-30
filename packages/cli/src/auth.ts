/**
 * @los/cli/auth — Authentication commands.
 *
 *   los auth xai login    Run the xAI OAuth PKCE login flow
 *   los auth xai status   Show current xAI OAuth token state
 */

import { xaiOAuthLogin } from '@los/agent/auth/login';
import { getXaiOAuthStatus, clearXaiOAuthTokens, XaiOAuthError } from '@los/agent';
import type { XaiOAuthState } from '@los/agent';

type ParsedArgs = {
  values: Record<string, string | boolean | number>;
  positionals: string[];
};

function parseArgs(argv: string[]): ParsedArgs {
  const values: Record<string, string | boolean | number> = {};
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const eqIdx = arg.indexOf('=');
      if (eqIdx >= 0) {
        const key = arg.slice(2, eqIdx);
        values[key] = arg.slice(eqIdx + 1);
      } else {
        const key = arg.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('-')) {
          values[key] = next;
          i++;
        } else {
          values[key] = true;
        }
      }
    } else if (arg.startsWith('-') && arg.length === 2) {
      const key = arg.slice(1);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        values[key] = next;
        i++;
      } else {
        values[key] = true;
      }
    } else {
      positionals.push(arg);
    }
  }
  return { values, positionals };
}

function stringFlag(parsed: ParsedArgs, ...names: string[]): string | undefined {
  for (const name of names) {
    if (parsed.values[name] !== undefined) return String(parsed.values[name]);
  }
  return undefined;
}

function hasFlag(parsed: ParsedArgs, name: string): boolean {
  return parsed.values[name] === true || parsed.values[name] === 'true';
}

export async function authCommand(_globalArgs: string[], argv: string[]): Promise<void> {
  const parsed = parseArgs(argv);
  const subcommand = parsed.positionals[0];
  const provider = parsed.positionals[1] ?? 'xai';

  if (!subcommand || subcommand === 'help') {
    printAuthHelp();
    return;
  }

  if (subcommand === 'login' || subcommand === 'signin') {
    await authLogin(provider, parsed);
    return;
  }

  if (subcommand === 'status') {
    await authStatus(provider);
    return;
  }

  if (subcommand === 'logout' || subcommand === 'signout') {
    await authLogout(provider);
    return;
  }

  console.error(`Unknown auth subcommand: ${subcommand}`);
  printAuthHelp();
  process.exit(2);
}

async function authLogin(provider: string, parsed: ParsedArgs): Promise<void> {
  if (provider !== 'xai') {
    console.error(`OAuth login is only supported for xAI. Provider '${provider}' uses API key auth.`);
    console.error(`Set ${provider.toUpperCase()}_API_KEY in your environment.`);
    process.exit(2);
  }

  const manualPaste = hasFlag(parsed, 'manual-paste');
  const noBrowser = hasFlag(parsed, 'no-browser');

  try {
    const state = await xaiOAuthLogin({
      openBrowser: !noBrowser,
      manualPaste,
    });

    console.log();
    console.log('Login successful!');
    console.log(`  Auth store:  ~/.los/auth.json`);
    console.log(`  Provider:    xai`);
    console.log(`  Model:       ${process.env.XAI_MODEL ?? 'grok-4.3'}`);
    console.log(`  Base URL:    ${process.env.XAI_BASE_URL ?? 'https://api.x.ai/v1'}`);

    const exp = decodeJwtExp(state.tokens.access_token);
    if (exp) {
      const remaining = Math.max(0, exp - Date.now() / 1000);
      const hours = Math.floor(remaining / 3600);
      const minutes = Math.floor((remaining % 3600) / 60);
      console.log(`  Expires in:  ~${hours}h ${minutes}m`);
    }

    console.log();
    console.log('To use xAI as your default provider:');
    console.log('  export AGENT_DEFAULT_PROVIDER=xai');
    console.log('Or for a single request:');
    console.log('  los run --provider xai "your prompt"');
  } catch (err) {
    if (err instanceof XaiOAuthError) {
      console.error(`xAI OAuth login failed: ${err.message}`);
      if (err.reloginRequired) {
        console.error('Run `los auth xai login` to re-authenticate.');
      }
    } else {
      console.error(`Login failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    process.exit(1);
  }
}

async function authStatus(provider: string): Promise<void> {
  if (provider !== 'xai') {
    console.log(`OAuth status is only available for xAI.`);
    console.log(`Provider '${provider}': use 'los provider list' to check readiness.`);
    return;
  }

  const status = getXaiOAuthStatus();

  if (!status.loggedIn) {
    console.log('xAI OAuth: Not logged in.');
    if (status.error) {
      console.log(`  Last error: ${status.error}`);
    }
    console.log('  Run `los auth xai login` to authenticate.');
    return;
  }

  console.log('xAI OAuth: Logged in.');
  if (status.expiresAt) {
    console.log(`  Expires at: ${status.expiresAt}`);
    if (status.remainingSeconds !== undefined) {
      const hours = Math.floor(status.remainingSeconds / 3600);
      const minutes = Math.floor((status.remainingSeconds % 3600) / 60);
      console.log(`  Remaining:  ~${hours}h ${minutes}m`);
    }
  }
  if (status.source) {
    console.log(`  Source:     ${status.source}`);
  }
}

async function authLogout(provider: string): Promise<void> {
  if (provider !== 'xai') {
    console.error(`OAuth logout is only supported for xAI. Provider '${provider}' uses API key auth.`);
    process.exit(2);
  }

  clearXaiOAuthTokens();
  console.log('xAI OAuth: Tokens cleared.');
  console.log('Run `los auth xai login` to re-authenticate.');
}

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
    return typeof payload.exp === 'number' ? payload.exp : undefined;
  } catch {
    return undefined;
  }
}

function printAuthHelp(): void {
  console.log(`los auth

Manage OAuth authentication for subscription-based providers.

Usage:
  los auth <provider> <login|status|logout>

Commands:
  login    Start the OAuth PKCE login flow (opens browser)
  status   Show current OAuth token state
  logout   Clear stored OAuth tokens

Options:
  --no-browser     Don't open the browser automatically
  --manual-paste   Skip the loopback server; paste the callback URL manually

Currently supported providers: xai (SuperGrok / Premium+ subscription)

Examples:
  los auth xai login
  los auth xai login --no-browser
  los auth xai status
  los auth xai logout
`);
}
