// Locate the unirun binary and ask it what it can do.
//
// `unirun --version` answers "which release is this?", not "does it take
// --workdir", so a consumer that maps versions to features keeps a private table
// that goes stale silently. That is what happened in audit C4/F1: with 0.3.0
// installed, every call that needed remote cwd/env was reported as
// "unirun_unavailable" and quietly ran on native ssh. 0.5.0 added
// `unirun capabilities --json`, whose keys name behaviour, so this module asks
// the binary instead of guessing from a version string.
//
// Anything the binary cannot answer — pre-0.5.0, or a document this module
// cannot read — yields the conservative empty set, which keeps the call on
// native ssh rather than handing the binary flags it might append to the remote
// script.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** What the resolved unirun binary can actually do. */
export interface UnirunCapabilities {
  /** `unirun ssh` accepts --user/--port/--identity (key `ssh-identity`). */
  sshIdentity: boolean;
  /** `unirun ssh` accepts remote --workdir/--env (key `ssh-workdir-env`). */
  sshWorkdirEnv: boolean;
}

/** A resolved binary plus the capabilities it reported (or failed to report). */
export interface UnirunProbe {
  /** Binary the caller may dispatch to, or null when none was found. */
  bin: string | null;
  /**
   * `--version` output of a binary that exists but cannot describe itself
   * (pre-0.5.0, or a broken install). Named so the fallback log can say which
   * binary is installed instead of reporting it as absent.
   */
  staleVersion: string | null;
  /** What the binary can do; the conservative empty set when it cannot say. */
  capabilities: UnirunCapabilities;
}

/** Interrogate one candidate binary; null = it could not be spawned at all.
 *  Injectable so tests can drive the probe without a binary on disk. */
export type UnirunProbeRunner = (
  bin: string,
  args: string[],
  timeoutMs: number,
) => Promise<{ code: number; stdout: string } | null>;

/** The subset of a run request that needs remote-context support. */
export interface RemoteContextOptions {
  cwd?: string;
  env?: Record<string, string>;
}

/** Capability keys this module reads; `tools/install-unirun.sh` requires the
 *  same two of an installed binary. */
const SSH_IDENTITY_KEY = 'ssh-identity';
const SSH_WORKDIR_ENV_KEY = 'ssh-workdir-env';

/** Conservative set for "no usable binary" / "unreadable capabilities". */
const NO_UNIRUN_CAPABILITIES: UnirunCapabilities = { sshIdentity: false, sshWorkdirEnv: false };
const FULL_UNIRUN_CAPABILITIES: UnirunCapabilities = { sshIdentity: true, sshWorkdirEnv: true };

/** Probe result, cached for the process lifetime (undefined = not probed yet). */
let cachedProbe: UnirunProbe | undefined;

/** Where a unirun may live: gateway processes (launchd/systemd/containers) often
 *  run with a minimal PATH that lacks ~/.cargo/bin. LOS_UNIRUN_BIN wins. */
function unirunBinaryCandidates(env: NodeJS.ProcessEnv): string[] {
  const candidates: string[] = [];
  if (env.LOS_UNIRUN_BIN) candidates.push(env.LOS_UNIRUN_BIN);
  candidates.push('unirun');
  const home = homedir();
  candidates.push(join(home, '.cargo', 'bin', 'unirun'));
  candidates.push('/usr/local/bin/unirun', '/opt/homebrew/bin/unirun');
  return candidates;
}

/** Spawn a candidate and capture stdout (stderr is discarded: exit code and the
 *  capabilities document are what the gate reads). */
function spawnProbe(
  bin: string,
  args: string[],
  timeoutMs: number,
): Promise<{ code: number; stdout: string } | null> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'ignore'], timeout: timeoutMs });
    let stdout = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf-8');
    });
    child.on('error', () => resolve(null));
    child.on('close', (code) => resolve({ code: code ?? -1, stdout }));
  });
}

/**
 * Parse a `unirun capabilities --json` document into the capability set the ssh
 * runner gates on.
 *
 * The unirun contract is that keys are added, never renamed or removed, so an
 * unknown key is ignored and a missing one means "not supported here": the
 * caller falls back to its own precedent behaviour (native ssh) rather than
 * assuming the capability is present.
 */
function parseUnirunCapabilities(capabilitiesJson: string): UnirunCapabilities {
  let document: unknown;
  try {
    document = JSON.parse(capabilitiesJson);
  } catch {
    return { ...NO_UNIRUN_CAPABILITIES };
  }
  if (typeof document !== 'object' || document === null) return { ...NO_UNIRUN_CAPABILITIES };
  const features = (document as { features?: unknown }).features;
  if (!Array.isArray(features)) return { ...NO_UNIRUN_CAPABILITIES };
  const keys = new Set(features.filter((key): key is string => typeof key === 'string'));
  return {
    sshIdentity: keys.has(SSH_IDENTITY_KEY),
    sshWorkdirEnv: keys.has(SSH_WORKDIR_ENV_KEY),
  };
}

/**
 * Find a unirun and return what it can do, once per process.
 *
 * Candidates are tried in preference order. The first one that answers
 * `capabilities --json` wins; a binary that exists but cannot answer does not
 * end the search (a stale early candidate must not shadow a usable one) and is
 * only remembered as `staleVersion` for the fallback log. A binary that cannot
 * even be spawned is skipped, so "absent" stays distinct from "installed but
 * unusable" — the distinction audit C4/F1 found missing.
 */
export async function probeUnirun(
  env: NodeJS.ProcessEnv = process.env,
  run: UnirunProbeRunner = spawnProbe,
): Promise<UnirunProbe> {
  if (cachedProbe) return cachedProbe;
  let stale: { bin: string; version: string } | null = null;
  for (const candidate of unirunBinaryCandidates(env)) {
    if (candidate !== 'unirun' && !existsSync(candidate)) continue;
    const caps = await run(candidate, ['capabilities', '--json'], 3_000);
    if (caps === null) continue;
    if (caps.code === 0) {
      cachedProbe = {
        bin: candidate,
        staleVersion: null,
        capabilities: parseUnirunCapabilities(caps.stdout),
      };
      return cachedProbe;
    }
    if (!stale) {
      const version = await run(candidate, ['--version'], 3_000);
      stale = { bin: candidate, version: version?.stdout.trim() || 'unreported version' };
    }
  }
  cachedProbe = {
    bin: stale?.bin ?? null,
    staleVersion: stale?.version ?? null,
    capabilities: { ...NO_UNIRUN_CAPABILITIES },
  };
  return cachedProbe;
}

/** Resolved unirun binary path, or null when there is none. Cached with the
 *  probe, so the capabilities gate and the ssh dispatch agree on the binary. */
export async function resolveUnirunBinary(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  return (await probeUnirun(env)).bin;
}

/** Clear the process cache. Exported for tests. */
export function _resetUnirunProbe(): void {
  cachedProbe = undefined;
}

/** Accept the shapes an injected seam may use: a capability set, a full probe,
 *  or the boolean shorthand (`true` = available and fully capable, `false` = no
 *  usable binary). */
export function normalizeUnirunProbe(value: UnirunCapabilities | boolean | UnirunProbe): UnirunProbe {
  if (typeof value === 'boolean') {
    return {
      bin: null,
      staleVersion: null,
      capabilities: value ? { ...FULL_UNIRUN_CAPABILITIES } : { ...NO_UNIRUN_CAPABILITIES },
    };
  }
  if ('capabilities' in value) {
    return {
      bin: value.bin ?? null,
      staleVersion: value.staleVersion ?? null,
      capabilities: { ...NO_UNIRUN_CAPABILITIES, ...value.capabilities },
    };
  }
  return {
    bin: null,
    staleVersion: null,
    capabilities: { ...NO_UNIRUN_CAPABILITIES, ...value },
  };
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
