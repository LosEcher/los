# Node Deployment Runbook

## Purpose

Use this runbook to bootstrap, update, verify, roll back, or reactivate a LOS
executor node. Runtime process evidence and the authenticated node registry
must agree before a rollout is considered complete.

The preferred update path is `tools/deploy-to-remote.sh`. Use
`tools/setup-node.sh` only for first-time machine bootstrap or recovery when
`/opt/los` is absent.

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
   registry: online, fresh heartbeat, same version, activeTaskCount=0
   process: no replaced unmanaged executor remains
   logs: no restart loop, DB auth failure, heartbeat failure, or missing path
   ```

Record exact evidence with `[E]`, inference with `[I]`, and unresolved claims
with `[U]` in a dated operation smoke.

## Rollback

Before cutover, retain the prior deployment archive checksum and a root-readable
backup of `.env`. Never place the backup in version control or deployment tar.

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

The current tar sync overlays `/opt/los`; it does not prove that obsolete remote
source files were removed. A future deployment change should use versioned
release directories plus an atomic `current` symlink, or verify a remote file
manifest before switching services.

The systemd unit still executes TypeScript with `tsx`. Moving to a built
executor artifact will reduce startup time and remove esbuild from the runtime
dependency set, but requires package export changes and a focused compatibility
gate.
