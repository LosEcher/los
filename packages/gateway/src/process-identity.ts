/**
 * Process content identity — the single source for "which content is this
 * process running?".
 *
 * Three content identities exist in los and must not be conflated
 * (docs/architecture/2026-10-10-control-plane-truth-remediation.md §1 and the
 * truth-source table):
 *
 *   1. process identity   — `LOS_VERSION` baked in at start-up (this module)
 *   2. worktree identity  — `tools/los.sh build-version` output (recomputed on
 *                           demand; never read from here)
 *   3. declared target    — `executor_nodes.target_version` (a column)
 *
 * Rules this module encodes:
 *
 * - The version is resolved **once**, not per request. A later env change cannot
 *   retroactively alter what this process started with.
 * - Missing `LOS_VERSION` falls back to the gateway `package.json` version and
 *   is reported as `versionSource: 'package_json'`. That value is **not** a
 *   content hash (no `+b<12>` suffix) and must not be read as one.
 * - The worktree digest is never recomputed here: `find` + `shasum` does not
 *   belong on a request path, and doing it would merge identities 1 and 2 back
 *   into one field.
 */

const STARTED_AT = new Date().toISOString();
const PID = process.pid;

export type VersionSource = 'env' | 'package_json' | 'unversioned';

export type ProcessIdentity = {
  /** Version string this process started with. */
  processVersion: string;
  /** Where `processVersion` came from. `package_json` is not a content hash. */
  versionSource: VersionSource;
  /** ISO-8601 instant captured at module load. */
  startedAt: string;
  /** OS process id, captured at module load. */
  pid: number;
};

export type ProcessIdentityInputs = {
  /** `config.server.version` — comes from the `LOS_VERSION` env var when set. */
  envVersion?: string;
  /** Fallback when the env var is absent: the running package's version. */
  packageVersion?: string;
};

function normalizeVersion(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Pure form: resolve an identity from explicit inputs plus this process's
 * start-up facts. Kept separate from {@link getProcessIdentity} so the fallback
 * semantics are testable in-process without spawning a subprocess.
 */
export function _buildProcessIdentityForTests(
  inputs: ProcessIdentityInputs,
  facts: { startedAt?: string; pid?: number } = {},
): ProcessIdentity {
  const envVersion = normalizeVersion(inputs.envVersion);
  const packageVersion = normalizeVersion(inputs.packageVersion);
  const processVersion = envVersion ?? packageVersion ?? 'unknown';
  const versionSource: VersionSource = envVersion
    ? 'env'
    : packageVersion
      ? 'package_json'
      : 'unversioned';
  return {
    processVersion,
    versionSource,
    startedAt: facts.startedAt ?? STARTED_AT,
    pid: facts.pid ?? PID,
  };
}

let identity: ProcessIdentity | undefined;

/**
 * The identity of *this* process. Resolved on first call and then frozen, so
 * every reader — `/health`, heartbeats, tests — sees the same four values for
 * the lifetime of the process.
 *
 * The caller supplies the version inputs (the gateway passes
 * `config.server.version` and `gatewayPackage.version`); this module never
 * discovers them itself, which keeps the fallback rule in one visible place.
 */
export function getProcessIdentity(inputs: ProcessIdentityInputs): ProcessIdentity {
  if (!identity) identity = _buildProcessIdentityForTests(inputs);
  return identity;
}

/** Test-only: drop the frozen identity so a test can re-resolve it. */
export function _resetProcessIdentityForTests(): void {
  identity = undefined;
}
