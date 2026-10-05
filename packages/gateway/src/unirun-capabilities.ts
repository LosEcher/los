// Locate the unirun binary and model what it can do.
//
// Pre-0.3.0 builds do not reject unknown flags — they append them to the remote
// script — and 0.3.x rejects `--workdir`/`--env` with exit 2. The gateway
// therefore derives what the resolved binary understands from
// `unirun --version` instead of assuming it.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** What the resolved unirun binary can actually do. */
export interface UnirunCapabilities {
  /** `unirun ssh` accepts --user/--port/--identity (>= 0.3.0). */
  sshIdentity: boolean;
  /** `unirun ssh` accepts remote --workdir/--env (>= 0.4.0). */
  sshWorkdirEnv: boolean;
}

/** The subset of a run request that needs remote-context support. */
export interface RemoteContextOptions {
  cwd?: string;
  env?: Record<string, string>;
}

/** Conservative set for "no usable binary" / "unknown version". */
const NO_UNIRUN_CAPABILITIES: UnirunCapabilities = { sshIdentity: false, sshWorkdirEnv: false };
const FULL_UNIRUN_CAPABILITIES: UnirunCapabilities = { sshIdentity: true, sshWorkdirEnv: true };

/** A fresh conservative set (callers never share a mutable capabilities object). */
export function noUnirunCapabilities(): UnirunCapabilities {
  return { ...NO_UNIRUN_CAPABILITIES };
}

/** Resolved unirun binary path (undefined = not resolved yet, null = absent). */
let unirunBin: string | null | undefined;

/**
 * Resolve the unirun binary. Gateway processes (launchd/systemd/containers)
 * often run with a minimal PATH that lacks ~/.cargo/bin, so we probe known
 * locations in addition to PATH, with LOS_UNIRUN_BIN as an explicit override.
 * The result is cached for the process lifetime.
 */
export async function resolveUnirunBinary(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  if (unirunBin !== undefined) return unirunBin;
  const candidates: string[] = [];
  if (env.LOS_UNIRUN_BIN) candidates.push(env.LOS_UNIRUN_BIN);
  candidates.push('unirun');
  const home = homedir();
  candidates.push(join(home, '.cargo', 'bin', 'unirun'));
  candidates.push('/usr/local/bin/unirun', '/opt/homebrew/bin/unirun');

  for (const candidate of candidates) {
    const ok = candidate === 'unirun'
      ? await tryRunUnirunVersion(candidate)
      : existsSync(candidate) && (await tryRunUnirunVersion(candidate));
    if (ok) {
      unirunBin = candidate;
      return candidate;
    }
  }
  unirunBin = null;
  return null;
}

function tryRunUnirunVersion(bin: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(bin, ['--version'], {
      stdio: 'ignore',
      timeout: 3_000,
    });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
}

/**
 * Parse `unirun --version` ("unirun 0.4.0") into a capability set. Output that
 * carries no version yields the conservative empty set.
 */
export function parseUnirunCapabilities(versionOutput: string): UnirunCapabilities {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(versionOutput);
  if (!match) return { ...NO_UNIRUN_CAPABILITIES };
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const atLeast = (wantMajor: number, wantMinor: number) =>
    major > wantMajor || (major === wantMajor && minor >= wantMinor);
  return {
    sshIdentity: atLeast(0, 3),
    sshWorkdirEnv: atLeast(0, 4),
  };
}

/** Accept the boolean shorthand used by injected seams:
 *  `true` = available and fully capable, `false` = no usable binary. */
export function normalizeUnirunCapabilities(value: UnirunCapabilities | boolean): UnirunCapabilities {
  if (typeof value === 'boolean') {
    return value ? { ...FULL_UNIRUN_CAPABILITIES } : { ...NO_UNIRUN_CAPABILITIES };
  }
  return { ...NO_UNIRUN_CAPABILITIES, ...value };
}

/** Does this call ask for remote workdir/env support? */
export function wantsRemoteContext(opts: RemoteContextOptions): boolean {
  return Boolean(opts.cwd) || Object.keys(opts.env ?? {}).length > 0;
}

/**
 * Can this binary serve the call without being handed flags it does not know?
 * Calls it cannot serve stay on native ssh.
 */
export function unirunSshUsable(
  caps: UnirunCapabilities,
  opts: RemoteContextOptions,
): boolean {
  if (!caps.sshIdentity) return false;
  return !wantsRemoteContext(opts) || caps.sshWorkdirEnv;
}
