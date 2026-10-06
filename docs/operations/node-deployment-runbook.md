# Node Deployment Runbook

## Purpose

Use this runbook to bootstrap, update, verify, roll back, or reactivate a LOS
executor node. Runtime process evidence and the authenticated node registry
must agree before a rollout is considered complete.

The preferred update path is `tools/deploy-to-remote.sh`. Use
`tools/setup-node.sh` only for first-time machine bootstrap or recovery when
`/opt/los` is absent.

`tools/deploy-to-remote.sh` targets **Linux + systemd** nodes. macOS (launchd)
and Windows (service + PowerShell watchdog) nodes have no automated path yet:
do them by hand with the procedures in "macOS Nodes" and "Windows Nodes" below.

## Node Inventory

Maintain these facts for every active node without storing credentials:

| Field | Required evidence |
| --- | --- |
| Node identity | `EXECUTOR_NODE_ID`, hostname, registry row |
| Runtime endpoint | `EXECUTOR_HOST`, `EXECUTOR_PORT`, `/health` response |
| Build identity | `/health.version` and registry `version` |
| Service owner | systemd/launchd label, service user, main PID |
| Database | instance owner and port; never infer it from a generic 5432 listener |
| Resource class | RAM, swap, free disk, `heavy_task_safe`, `deploy_safe` |
| Configuration owner | path and permissions of `.env`; never record secret values |

Verify `build identity` from **two independent sources**: the `.env`-stamped
version that `/health` reports, and the node's own content digest
(`cd <root> && bash tools/los.sh build-version`) where the platform can compute
it. The stamp alone does not prove which code is on disk — on 2026-10-06
`desktop-srsbe20` reported the target version while still running the previous
tree, because the upload had failed and only the `.env` was rewritten.

Current dated evidence belongs in a rollout smoke such as
`2026-07-12-node-version-rollout.md`, not in this reusable procedure.

## Preflight

1. Reload applicable specs and read ADR 0010.
2. Confirm the node has no active work in authenticated `GET /nodes`:
   `activeTaskCount=0` and a fresh heartbeat.
3. Run the remote resource check:

   ```bash
   ./tools/deploy-to-remote.sh <node> preflight
   ```

4. Confirm `.env` exists with mode 600 and contains, without printing values:
   `DATABASE_URL`, `EXECUTOR_AGENT_KEY`, `EXECUTOR_NODE_ID`, `EXECUTOR_PORT`,
   and `GATEWAY_URL`.
   It must also be **readable by the deploy identity**: a `600`/`los:los` file
   plus a non-root login (`oracle` uses `ubuntu` + sudo) makes both the version
   stamp and `verify` fail without `LOS_REMOTE_PRIVILEGE=sudo`.
   The systemd unit must not override `EXECUTOR_HOST` or `EXECUTOR_PORT`; the
   node `.env` is the endpoint configuration source used by both runtime and
   deployment verification.
5. Identify the database listener owner with `ss -tlnp` or `lsof`. Test an
   actual query using the configured URL. A reachable port is insufficient.
6. Confirm Node 22+, pnpm, Tailscale, `/opt/los` ownership, and free disk.
7. On nodes below 2 GiB RAM, require swap and use `--low-resource`.

Stop before cutover if configuration truth, process ownership, database
identity, task load, or expected port is ambiguous.

## Deploy

Use phased commands so a failed install does not stop the serving process:

```bash
./tools/deploy-to-remote.sh <node> sync
./tools/deploy-to-remote.sh <node> install --low-resource  # constrained only
./tools/deploy-to-remote.sh <node> install-service
./tools/deploy-to-remote.sh <node> verify
```

Standard nodes may omit `--low-resource`. Installs are non-interactive and keep
optional dependencies because `tsx` requires esbuild's platform binary.

`sync` also repairs the node tree, so a rollout converges instead of drifting:

- source modes are normalized to `a+rX` (a `0600` file breaks
  `tools/los.sh build-version` for any non-owner identity);
- files present on the node but absent from the shipped manifest are removed
  (tar only adds and overwrites), which is what lets the node's own content
  digest match the fleet target;
- bsdtar AppleDouble `._*` sidecars are suppressed and historical ones cleaned.

The default transport is Tailscale SSH as `root`. When a node instead uses an
OpenSSH config alias or a non-root login with passwordless sudo, set transport
details in the invoking environment rather than committing host credentials:

```bash
LOS_SSH_TRANSPORT=ssh \
LOS_SSH_TARGET=<ssh-config-alias> \
LOS_REMOTE_PRIVILEGE=sudo \
  ./tools/deploy-to-remote.sh <node> full-setup --low-resource
```

Omit `LOS_REMOTE_PRIVILEGE=sudo` when the SSH target already logs in as root.
The alias owns hostname, user, port, and identity-file selection. Verify it with
`ssh -o BatchMode=yes <alias> true` before starting a rollout.

Set `LOS_SSH_OPTS='-o ControlPath=none -o ControlMaster=no'` to bypass
`~/.ssh/config` connection multiplexing. A multiplexed master that drops
mid-transfer makes `sync` abort under `set -e` with the log ending mid-step: on
2026-10-06 that silently skipped the version stamp on `node34` and lost a whole
sync on `tencent-sin`. Because the steps are idempotent, retrying the node is
the recovery.

The deployed version is a deterministic digest of deployable runtime content.
Do not override `LOS_DEPLOY_VERSION` unless reproducing an explicitly recorded
artifact. The sync must include all workspace manifests covered by
`pnpm-lock.yaml`.

## Cutover And Verification

1. Recheck `activeTaskCount=0` immediately before stopping an unmanaged or old
   service.
2. Stop through the owning service manager. For an unmanaged process, verify
   its ancestry, process group, cwd, listener, and operator intent first.
3. Enable and start `los-executor.service` as user `los`.
4. Run `verify`; it reads the configured remote port, waits up to 90 seconds
   for a transitional systemd state such as `deactivating` to become `active`,
   then retries startup health. Set `LOS_DEPLOY_VERIFY_GRACE_SECONDS` only when
   a node's measured stop time justifies a different bounded observation window.
   This grace period does not suppress `failed` states or health/version errors.
5. Verify all of the following independently:

   ```text
   systemd: active, enabled, User=los, NRestarts=0
   health: status=ok and expected version
   content: `bash tools/los.sh build-version` equals the local target digest
   registry: online, fresh heartbeat, same version, activeTaskCount=0
   process: no replaced unmanaged executor remains
   logs: no restart loop, DB auth failure, heartbeat failure, or missing path
   ```

6. **Promote the node.** A restart always leaves the registry row
   `status='draining'`: the executor emits one `status='draining'` heartbeat
   while shutting down, and `resolveHeartbeatStatus()` preserves an existing
   `draining` when a later heartbeat carries no explicit status (online
   heartbeats omit it on purpose so an operator-requested drain is not silently
   undone). A verified node therefore sits healthy, reachable, and receiving no
   work until it is promoted:

   ```bash
   ./tools/deploy-to-remote.sh <node> promote --node-id <registry-node-id>
   # or, equivalently:
   ./bin/los nodes command <registry-node-id> promote \
     -t "$LOS_AUTH_TOKEN" --operator-token "$LOS_OPERATOR_TOKEN" \
     --reason "rolled to <target version>"
   ```

   Promotion returns whatever version the registry last recorded, which lags a
   fresh restart — treat the node's own `/health` and content digest as the
   version evidence, not the promote output.

Record exact evidence with `[E]`, inference with `[I]`, and unresolved claims
with `[U]` in a dated operation smoke.

## Windows Nodes

Windows nodes have no systemd, no `bash`, and no `shasum`; they run
`tsx` under a Windows service (`los-executor`, nssm + a PowerShell watchdog) and
their SSH default shell is `cmd.exe`. `tools/deploy-to-remote.sh` is not usable
there — on a host with WSL it silently targets WSL's filesystem instead.

1. Confirm `pnpm-lock.yaml` has the same SHA-256 as the gateway host. If it
   differs you must run a package install on the node before restarting, which
   currently needs a manual step.
2. Create a rollback point first (source trees only, never `node_modules`):

   ```powershell
   & C:\Windows\system32\tar.exe -czf C:\los\rollback-src-<ts>.tar.gz `
     --exclude=node_modules --exclude=dist --exclude=.los-runtime `
     -C C:\los tools deploy packages contracts package.json pnpm-lock.yaml `
     pnpm-workspace.yaml tsconfig.base.json turbo.json
   ```

3. Ship and extract the same archive the Linux path builds. **Use the SSH
   config alias, not an explicit `user@ip`** — an explicit target drops the
   alias's `IdentityFile` and the upload fails with `Permission denied`:

   ```bash
   scp /tmp/los-win.tar.gz <alias>:C:/los/los-sync-<version>.tar.gz
   ssh <alias> 'powershell -NoProfile -Command "& C:\Windows\system32\tar.exe -xzf C:\los\los-sync-<version>.tar.gz -C C:\los"'
   ```

4. Stamp the version by **appending**; `run-executor-task.ps1` applies the file
   line by line with last-wins semantics, so appending avoids rewriting the
   non-ASCII header:

   ```powershell
   Add-Content C:\los\.env -Value "LOS_VERSION=<target>" -Encoding ASCII
   Add-Content C:\los\.env -Value "EXECUTOR_VERSION=<target>" -Encoding ASCII
   Restart-Service los-executor -Force
   ```

5. Verify **by content**, because the version stamp cannot: assert a file that
   the target revision introduced actually exists (e.g.
   `Test-Path C:\los\packages\agent\src\governance-seed-dedupe.test.ts`), then
   check `/health` and the registry.

## macOS Nodes

`mbp-executor-1` runs from the gateway's own checkout: restart it and the
version follows the working tree. `m3pro-executor-1` runs from
`~/.local/share/los` (a tar snapshot, no VCS) under launchd
`com.echerlos.los-executor`; `tools/deploy-to-remote.sh` is not usable (it
assumes systemd and a `los` user).

1. Ship the same include list by tar pipe and extract into the node root.
2. Normalize modes and stamp `.env` exactly as on Linux — both platforms get
   their version from `LOS_VERSION`/`EXECUTOR_VERSION` in that file.
3. Restart through launchd (KeepAlive brings it straight back):

   ```bash
   ssh <alias> 'launchctl kickstart -k gui/$(id -u)/com.echerlos.los-executor'
   ```

4. Verify the content digest, `/health`, and the registry row.

## Rollback

Before cutover, retain the prior deployment archive checksum and a root-readable
backup of `.env`. Never place the backup in version control or deployment tar.
Per-platform rollback artifacts: `/opt/los` snapshot + prior archive on Linux,
`C:\los\rollback-src-<ts>.tar.gz` on Windows, and the gateway checkout itself on
`mbp-executor-1` (git/jj history is the rollback).

If verification fails:

1. Stop the new systemd unit and inspect its journal.
2. Restore the previous runtime archive into a clean release directory or
   restore the prior `/opt/los` snapshot.
3. Restore `.env` only when configuration was part of the failure; preserve
   mode 600 and owner `los`.
4. Start the previous managed service and verify health plus registry freshness.
5. Record the failed target version, restored version, failure phase, and logs.

Do not revive an abandoned shell-session process as the normal rollback path.

## Offline Nodes

An offline registry row is historical evidence, not deployment truth. Do not
stamp, promote, or delete it during an unrelated rollout.

When reactivating an offline node:

1. Treat it as a fresh preflight and inspect its actual machine state.
2. Replace stale configuration and install the current managed service.
3. Require live `/health`, a fresh heartbeat, matching build version, and
   capability review before scheduling work.
4. Keep constrained nodes `heavy_task_safe=false` unless new resource evidence
   justifies promotion.

Retired SSH aliases, eval rows, and test fixtures should be cleaned in a
separate registry-governance change with explicit deletion evidence.

## Known Follow-Up

~~The current tar sync overlays `/opt/los`; it does not prove that obsolete
remote source files were removed.~~ **Resolved 2026-10-06**: `sync` now prunes
every file that is absent from the shipped manifest (with a hard stop if the
candidate list exceeds 500 entries or names `node_modules`/`.git`/`.env`), and
the node's own content digest converges to the fleet target as a result. A
versioned release directory plus an atomic `current` symlink would still make
the cutover atomic rather than in-place.

Open items:

- **Promote is manual.** `restart`/`verify` warn about the post-restart drain
  and `promote` exists as a subcommand, but nothing promotes automatically after
  a successful verify. A rollout that forgets it leaves verified nodes idle.
- **`promote` does not check the reported version**, so it can mark a stale node
  online from a lagging registry value.
- **No content probe for Windows/macOS**, and no automated path at all for those
  platforms. Windows upgrades depend on a hand-built archive plus a file
  existence check.
- **Maintenance windows do not gate scheduling.** `isNodeInMaintenance` is only
  consulted by fleet alerting, watch-state advancement, and host-check repair;
  the executor candidate filter never reads it. To actually stop work landing on
  a node, drain it.

The systemd unit still executes TypeScript with `tsx`. Moving to a built
executor artifact will reduce startup time and remove esbuild from the runtime
dependency set, but requires package export changes and a focused compatibility
gate.
