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
(`cd <root> && bash tools/los.sh build-version`, or
`node tools/deployable-content.mjs --digest` where there is no bash). The stamp
alone does not prove which code is on disk — on 2026-10-06 `desktop-srsbe20`
reported the target version while still running the previous tree, because the
upload had failed and only the `.env` was rewritten.

## Content Identity

The deployed version is a deterministic digest of the content a node executes:
`<base>+b<12hex>`, where `<base>` is `packages/executor/package.json`'s version
and the 12 hex characters are a SHA-256 over every covered file's SHA-256.

**It has exactly one implementation: `tools/deployable-content.mjs`.** bash
(`tools/los.sh build-version`) and PowerShell (the Windows driver's `digest`
step) are both callers, because a digest that only one platform can compute is
not a criterion — it is a slogan. What is covered, and what is deliberately
excluded (gateway-only scripts, `node_modules`, `dist`, `.turbo`, `.los`,
`.los-runtime`, `*.tsbuildinfo`, `.DS_Store`, `._*`), is defined there and pinned
by `tools/deployable-content.test.mjs` (`pnpm check:deployable-content`).

```bash
bash tools/los.sh build-version             # the version string
bash tools/los.sh build-version --files     # the exact files the digest covers
node tools/deployable-content.mjs --json    # version + base + revision + files
```

Use `--files` to diagnose a mismatch instead of guessing: run it on the gateway
and on the node, diff the two lists, and you will see whether the node is
**missing** files (a genuinely half-synced tree) or holding **extra** ones (a
stale file the prune did not remove). A whole-tree digest alone can only say
"different" — that ambiguity is what cost hours on 2026-10-11.

The digest moved to this module on 2026-10-11 (it used to be an inline bash
pipeline). Equivalence was proven before the switch — identical file lists and
identical digests on the same explicit list — and the fleet was then rolled once,
because the module itself is covered content. See
`architecture/2026-10-11-cross-platform-content-identity-design.md`.

**Covered means repository content, not "whatever is on disk".** The module also
excludes the generated state that the repository's own `.gitignore` calls non-content
(`*.db`/`*.db-shm`/`*.db-wal`, `packages/<pkg>/test-results/`). Without that, running
a test suite or writing a local SQLite WAL silently **moved the fleet target**, and
428 KB of that state was shipped to every node. Generated state belongs in
`.los-runtime/` (excluded); if something new starts writing inside a covered tree,
move the producer rather than extending the list — the list exists as a backstop, and
a covered-but-not-shipped file makes convergence impossible (loudly, not silently).

**A rollout freezes its payload once, from a revision.** `tools/los-fleet-rollout.sh`
builds the ship tarball at the start by archiving **`main@origin`** (`git archive`, so
only tracked content can enter), extracts it to
`.los-runtime/rollouts/payload-latest-tree`, and defines the target as *that
snapshot's* digest; every node then receives the same bytes (`LOS_DEPLOY_TARBALL`).

Two properties come from this, and they are the point:

- **the working tree is not the content.** A dirty, branchy or stale checkout no
  longer decides what the fleet runs — the named revision does. "The fleet runs what
  is merged" stops being a property you approximate by checking whether a tree is
  dirty, and becomes the default behaviour. (The tree still decides *which rollout
  code* runs, so run rolls from a tree that is near `main`.)
- **mid-rollout edits cannot split the fleet.** Each node used to pack its own tarball
  at its own turn, with the target computed before any of them; now the bytes are
  fixed before the first node, so a writer active during a rollout cannot leave the
  early nodes on one revision and the later ones on another.

`LOS_ROLLOUT_SOURCE=worktree` opts into the old behaviour (ship what is on disk) for a
deliberate hotfix roll; that mode keeps the dirty-tree gate and the "not
`main@origin`" warning. `LOS_ROLLOUT_REVISION=<rev>` picks a different revision.


**The target is a snapshot of the gateway's working tree**, not of a commit:
`tools/los-fleet-rollout.sh` computes it with `bash tools/los.sh build-version` in
the checkout it runs from. Two invariants therefore have to hold, and the
orchestrator enforces both:

1. **The covered files must be committed.** An uncommitted edit inside the digest's
   scope makes the target a snapshot of work in progress, so a rollout would ship
   that work to the whole fleet. The orchestrator lists the offending files and
   **refuses to roll**; `LOS_ROLLOUT_ALLOW_DIRTY=1` overrides when rolling
   uncommitted content is deliberate. It also warns when the content comes from
   something other than the merged `main@origin`.
2. **The target must not change while the rollout runs.** The gate above only
   describes the start; the orchestrator re-computes the digest before every node
   and aborts if it moved — otherwise the early nodes would get one revision and the
   later ones another. Such an abort touches nothing further and names the report.

`--plan` stays read-only: it prints the dirty-file warning and the plan so you can
see the situation, and does not refuse.

Two consequences worth knowing before you start a roll:

- `mbp-executor-1` runs from that same checkout, so it is by construction "at the
  working tree" and reads as off-target whenever the tree has such changes.
- an executor that runs from an editable tree is a task-correctness risk, not just a
  bookkeeping one: `tsx` reads a module from disk the first time it is required, so a
  half-finished edit can enter the execution path without any restart. Keep
  `mbp-executor-1` on content you are willing to have run.

For the same reason, compare a node against the *fleet target* rather than against
your current checkout when a concurrent editor is active.


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

4. Confirm `.env` contains, without printing values: `DATABASE_URL`,
   `EXECUTOR_AGENT_KEY`, `EXECUTOR_NODE_ID`, `EXECUTOR_PORT`, and `GATEWAY_URL`.
   It must also be **readable by the deploy identity**: a `600`/`los:los` file
   plus a non-root login (`oracle` uses `ubuntu` + sudo) makes both the version
   stamp and `verify` fail without `LOS_REMOTE_PRIVILEGE=sudo`.
   Mode is **not** uniformly `600` across the fleet, and the right shape follows
   from who reads the file: macOS runs the executor as the owner, so `600`; a
   Linux node whose `.env` is `root:root` and whose service user is `los` needs
   `644` (a root-owned `600` file is unreadable to `los`). Do not "harden" that
   second shape. `sync` now preserves whatever mode it finds — before
   2026-10-11 the stamp rewrote `.env` with `awk`+`mv`, which recreated it with
   umask permissions and silently turned `600` back into `644` on every rollout.
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

`install` also ensures the **pinned unirun** on the node
(`tools/install-unirun.sh`, version + sha256 in `deploy/unirun-pin.txt`) and
`verify` reports whether the node has one the gateway can use
(`unirun: ok (<version>)` or a warning that ssh dispatch falls back to native).
The install warns rather than fails when `github.com` is unreachable from the
node; set `LOS_REQUIRE_UNIRUN=1` to make a missing/unusable unirun fatal. See
`docs/operations/unirun-pin.md` for the pin, the capability keys, and the bump
procedure.

`sync` also repairs the node tree, so a rollout converges instead of drifting:

- source modes are normalized to `a+rX` (a `0600` file breaks
  `tools/los.sh build-version` for any non-owner identity);
- files present on the node but absent from the shipped manifest are removed
  (tar only adds and overwrites), which is what lets the node's own content
  digest match the fleet target;
- bsdtar AppleDouble `._*` sidecars are suppressed and historical ones cleaned.

The prune is what reconciles deleted or renamed sources, and it has to work on
both GNU and BSD userlands: until 2026-10-11 it deleted the stale list with
`xargs -a FILE -d '\n'`, which macOS's `xargs` rejects outright
(`xargs: invalid option -- a`). On `m3pro-executor-1` that left exactly one
renamed-away source file in place, so the node's digest could never equal the
fleet target even though every byte of the transfer was correct — three
consecutive rollouts restored it to the old revision. A stale path the prune
cannot remove now fails the sync out loud, and the prune's output goes into the
sync log instead of nowhere
(`2026-10-11-macos-m3-sync-nonconvergence.md`).

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

**`sync` asserts convergence on exit — read the guard's message before acting.**
On exit the sync re-reads the node's own content digest and refuses to report
success unless it equals the target. A mismatch has two very different causes,
and the sync log now distinguishes them:

| sync log says | meaning | action |
| --- | --- | --- |
| `prune: N stale file(s)` … `removed N stale file(s)`, digest matches | normal repair | none |
| `prune: FAILED — could not remove stale path: …` | extra source files survive (BSD/GNU `rm` flag, permissions, `uchg`) | clear the obstacle and re-run; the tree itself is intact |
| no `prune:` complaint, digest != target | source files are **missing** on the node | treat as half-synced: do NOT restart it; re-run the sync |

That distinction matters because the transfer is otherwise silent: a successful
`scp` plus a silent `tar xzf` used to leave a **0-byte sync log**, which reads
exactly like "it died before transferring anything" and sends you after the
transport instead of the prune (2026-10-11, M3, several hours).

Always confirm after `sync` with the node's own digest:

```bash
ssh <alias> 'cd <REMOTE_HOME> && bash tools/los.sh build-version'   # must equal the local target
```

If files really are missing (or the digest keeps changing between attempts),
stop retrying and use **upload-then-extract** instead: `scp` the archive to
`/tmp` on the node, compare `shasum -a 256` on both sides, then extract locally
on the node. That path is resilient because a dropped control connection cannot
truncate an already-complete file. Never leave a node in a half-synced state: a
partially written `packages/` tree is worse than the previous revision, which at
least started.

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
   unirun: ok (<pinned version>) — else ssh dispatch stays on native ssh
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

The automated path is the driver, and the orchestrator runs it:

```bash
tools/los-fleet-rollout.sh --node desktop-srsbe20       # sync → install → activate → verify → promote
```

`tools/deploy-drivers/windows-service.sh <sync|install|activate|verify> <alias> C:/los <target> [node_id]`
runs the individual steps when you need to do one by hand. The manual procedure
below is the fallback for when the driver cannot reach the node.

1. **Install the dependency graph (`install`).** `tar` ships sources only —
   `node_modules` is never in the manifest — while the executor resolves
   workspace packages through `packages\<pkg>\node_modules\@los\`. Any release
   that adds or removes a workspace package therefore needs a package install
   *before* the restart, or the node crash-loops under nssm on
   `ERR_MODULE_NOT_FOUND` (2026-10-11: the new `@los/mcp-stdio` left both Windows
   nodes without that link).
   Two traps that made this look like "the machine has no toolchain":
   - **PATH**: a non-interactive SSH session may not have `C:\Program Files\nodejs`
     on `PATH` even though `node.exe`, `npm.cmd` and `pnpm.cmd` are installed
     (`desktop-srsbe20` was mis-recorded for a day as "missing pnpm/corepack"
     because of exactly this). Probe with `Test-Path`, not `where.exe`, and extend
     `$env:Path` with `C:\Program Files\nodejs` and `%APPDATA%\npm`.
   - **execution policy**: call the **`.cmd`** shim, not the bare name.
     `Get-Command pnpm` prefers `pnpm.ps1`, and a non-interactive session's
     default execution policy refuses scripts — the symptom is "pnpm is installed
     but nothing runs".
2. Confirm `pnpm-lock.yaml` has the same SHA-256 as the gateway host, then
   `pnpm install --frozen-lockfile` in `C:\los`.
3. Create a rollback point first (source trees only, never `node_modules`):

   ```powershell
   & C:\Windows\system32\tar.exe -czf C:\los\rollback-src-<ts>.tar.gz `
     --exclude=node_modules --exclude=dist --exclude=.los-runtime `
     -C C:\los tools deploy packages contracts package.json pnpm-lock.yaml `
     pnpm-workspace.yaml tsconfig.base.json turbo.json
   ```

4. Ship and extract the same archive the Linux path builds. **Use the SSH
   config alias, not an explicit `user@ip`** — an explicit target drops the
   alias's `IdentityFile` and the upload fails with `Permission denied`:

   ```bash
   scp /tmp/los-win.tar.gz <alias>:C:/los/los-sync-<version>.tar.gz
   ssh <alias> 'powershell -NoProfile -Command "& C:\Windows\system32\tar.exe -xzf C:\los\los-sync-<version>.tar.gz -C C:\los"'
   ```

5. **Prune.** `tar` only adds and overwrites, so any source file the repository has
   deleted since the last rollout stays on the node forever — and because the
   content digest covers every source file, the node then *never* equals the fleet
   target. Until 2026-10-11 the driver had no prune at all and both Windows nodes
   had drifted (45 and 14 stale files, including an unzipped nssm source tree and
   `packages/*/pkg.tar`). The driver now derives the manifest from the tarball
   itself (`deploy-to-remote.sh tarball` writes `<tarball>.list`), uploads it, and
   deletes what the node has but the manifest does not — never `node_modules`,
   `.git` or `.env`, and never more than 500 paths at once.

6. Stamp the version by **appending**; `run-executor-task.ps1` applies the file
   line by line with last-wins semantics, so appending avoids rewriting the
   non-ASCII header:

   ```powershell
   Add-Content C:\los\.env -Value "LOS_VERSION=<target>" -Encoding ASCII
   Add-Content C:\los\.env -Value "EXECUTOR_VERSION=<target>" -Encoding ASCII
   Restart-Service los-executor -Force
   ```

7. Verify **four** things, not three. The stamp, the service state and a source
   probe are all satisfiable by a node whose executor is crash-looping under
   nssm — that is exactly how `desktop-srsbe20` sat "Running", stamped with the
   new version, probe present, and never heartbeating again. Add the node's own
   `/health` version:

   ```powershell
   (Invoke-RestMethod -Uri "http://127.0.0.1:$port/health" -TimeoutSec 8).version
   ```

   `svc=Running` + `stamped=<target>` + `probe=True` + `health=<target>`, then the
   registry row. Without the last one the rollout can report a dead node as
   "safely restored to the old revision".

### Writing PowerShell for these nodes

The driver uploads each script to `C:\Windows\Temp\los-<step>.ps1` and runs it
with `-File` (see the header of `windows-service.sh` for why `-Command -` and
`-EncodedCommand` both failed). If you add scripts, keep these four constraints:

- the `.ps1` must start with a **UTF-8 BOM** — Windows PowerShell 5.1 otherwise
  decodes it with the system ANSI code page and non-ASCII comments corrupt the
  parse (a `}` reported as an unexpected token);
- arguments must be quoted with **double** quotes — `cmd.exe` does not treat
  single quotes as quoting, so the value arrives with literal quotes attached;
- strip `\r` from captured output before anchored matching (`LC_ALL=C tr -d '\r'`,
  and `LC_ALL=C` matters because CLIXML error text can be in a local code page);
- do not suppress the CLIXML error stream; it is where PowerShell reports why a
  command failed.

### Node-local infrastructure stays OUT of the deployed tree

The nssm wrapper is node-local (the repository does not carry the binary), so it must
live **outside** `C:\los`:

```text
C:\los-node\nssm.exe          the service wrapper (BINARY_PATH_NAME)
C:\los\                       the deployed tree — exactly what the tar ships
```

Keep it that way. The stale-file prune deletes everything under the covered trees
that the shipped manifest does not list, and it cannot tell infrastructure from a
leftover: when `tools\nssm.exe` lived inside the tree it was flagged stale on every
sync and survived only because a running executable is locked — a sync that happened
while the service was stopped would have deleted the wrapper and left a node that
cannot start.

To relocate a node that still has the legacy layout (2026-10-11, both Windows nodes):

```powershell
Copy-Item C:\los\tools\nssm.exe C:\los-node\nssm.exe -Force   # verify: certutil -hashfile … SHA256 on both
sc.exe stop los-executor
reg add HKLM\SYSTEM\CurrentControlSet\Services\los-executor /v ImagePath /t REG_EXPAND_SZ /d "C:\los-node\nssm.exe" /f
# verify BEFORE starting: value must be exactly C:\los-node\nssm.exe (length 20, no stray characters)
sc.exe start los-executor
```

**Do not do this with `sc config … binPath=` through a nested quoting layer** (bash →
`cmd.exe` → PowerShell → `sc.exe`): it silently wrote a **leading space** into
`ImagePath` (`" C:\los\tools\nssm.exe"`), which made every subsequent start fail with
`[SC] StartService 失败 87: 参数错误` — a 15-minute outage on `desktop-r45553o` whose
cause was invisible in `sc qc` (which only showed one extra blank). Use `reg add`, and
assert the exact string before starting. If a start does fail, look for an **orphaned
wrapper process** (`tasklist | findstr nssm`) — a failed start can leave one behind, and
subsequent starts then fail until it is killed.

## macOS Nodes

**Both macOS nodes now have the same configuration**: the executor runs from
`~/.local/share/los` (a content-synced tree, no VCS) under its own launchd label
`com.echerlos.los-executor`, driven by `tools/deploy-drivers/macos-launchd.sh`.
They differ only in transport:

| node | transport | how the orchestrator drives it |
| --- | --- | --- |
| `m3pro-executor-1` | ssh alias `m3-t` | `LOS_SSH_TRANSPORT=ssh` |
| `mbp-executor-1` (this machine, the gateway host) | local | `LOS_SSH_TRANSPORT=local`, and the driver runs in place |

Until 2026-10-11 `mbp-executor-1` ran from the **gateway's editable checkout**.
That is why it was the fleet's most confusing node: its identity was "whatever the
editor had on disk", `tsx` loads a module from disk the first time it is required,
so an uncommitted edit could enter the execution path **without a restart**, and
rolling it ran `los.sh restart` — bouncing the gateway too. Pinning it removed all
three, and it is now the busiest node's normal configuration rather than a special
case.

**Only the executor restarts.** The gateway keeps running from the checkout; the
launchd wrapper `com.los.daemon` is told `LOS_EXECUTOR_EXTERNAL=1` so it checks and
starts **only** the gateway (`los.sh start-gateway`). Without that flag the wrapper
would see 8090 as unhealthy and call `los.sh start`, resurrecting the old executor
from the checkout to fight the pinned one for the port.

`tools/deploy-to-remote.sh` **is** usable on macOS for `sync`, `install`,
`digest` and `cmd`; `verify` and `restart` are not (they drive systemd). Drive it
with the SSH transport and the node's own home:

```bash
LOS_SSH_TRANSPORT=ssh LOS_SSH_TARGET=m3-t \
LOS_REMOTE_HOME=/Users/echerlos/.local/share/los LOS_REMOTE_PRIVILEGE=none \
  ./tools/deploy-to-remote.sh m3pro-executor-1 sync
```

`tools/los-fleet-rollout.sh --node <macos-node>` runs the whole sequence
(sync → install → plist → launchd restart → content+`/health` assertion →
promote) and is the preferred path; only hand-roll it when the orchestrator is
unavailable.

1. `sync` — upload-then-extract, stale-file prune, and the version stamp.
2. `install` — **do not skip this.** The executor resolves workspace packages
   through `packages/*/node_modules/@los`, so any release that adds or removes a
   workspace package needs `pnpm install` before the restart. On 2026-10-11 the
   new `@los/mcp-stdio` package had no link on M3 and restarting there would have
   crash-looped the executor on `ERR_MODULE_NOT_FOUND` — the same defect the
   Windows driver hit. `install` now probes whether it can really become user
   `los` (`su - los -c true`) and otherwise runs `pnpm` directly as the login
   user. Never probe that user by name: on M3 `id -u los` **succeeds** (the
   directory service resolves the unknown name to the current user, uid 501)
   even though no `los` account exists.
3. Stamp `.env` (`LOS_VERSION`/`EXECUTOR_VERSION`) — `sync` already does this,
   so the orchestrator's extra `sed -i ''` is only a belt-and-braces repeat.
4. Restart through launchd (KeepAlive brings it straight back):

   ```bash
   tools/deploy-drivers/macos-launchd.sh install-plist <home> com.echerlos.los-executor
   tools/deploy-drivers/macos-launchd.sh activate      <home> com.echerlos.los-executor
   ```

   `activate` unloads, **waits for the unload to finish**, then loads. `launchctl
   bootout` is asynchronous, and bootstrapping straight after it fails with a
   "still loaded / in progress" error — which is exactly how two rolls were lost on
   2026-10-11 before the wait was added. Do not swallow launchctl's stderr while
   debugging this: the driver prints all three errors when it gives up.

5. Verify all three: the content digest, `/health.version`, and the registry row
   plus `target_version`. `/health` is the evidence that the **new process** is
   up; the registry heartbeat lags. `verify` cannot be used here (it drives
   systemd), so the driver asserts the digest *and* `/health` itself:

   ```bash
   tools/deploy-drivers/macos-launchd.sh verify <home> com.echerlos.los-executor <target>
   ```

**The pinned tree keeps its own `.env`** (mode 600), like every other node — and
that is a trap on the gateway host, where a secret rotation applied only to the
checkout's `.env` leaves the pinned executor on the old value with no signal. The
orchestrator compares the two files (version keys excluded) before each local roll
and warns when they differ; it does not overwrite, because the node's port and
identity are legitimately allowed to differ.

**Rollback** (if the pinned executor misbehaves): `launchctl bootout
gui/$(id -u)/com.echerlos.los-executor`, remove `LOS_EXECUTOR_EXTERNAL` from
`~/Library/LaunchAgents/com.los.daemon.plist`, reload that plist, then
`./tools/los.sh start-executor` — the node is back on the checkout.

**`.env` mode is the node's own policy, and `sync` no longer rewrites it.** It
holds `DATABASE_URL` and `EXECUTOR_AGENT_KEY`. M3 runs the executor as its owner
and uses `600`; a Linux node whose `.env` is `root:root` keeps `644` so the `los`
service user can read it. Until 2026-10-11 the stamp recreated the file through
`awk`+`mv` and reset it to `0644` on every rollout, so tightening it by hand did
not survive the next sync. The macOS node root belongs to the login user, so
`chmod`, `launchctl` and the stamp need no sudo.

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
- **No macOS driver file.** The macOS sequence still lives as an inline branch in
  `tools/los-fleet-rollout.sh` instead of `tools/deploy-drivers/macos-launchd`
  (the split the rollout design calls for), so it cannot be reviewed or tested in
  isolation. The macOS branch does now assert the content digest (via `sync`) and
  `/health.version` (via the registry `base_url`), which it previously did not.
- ~~**No content digest for Windows.**~~ **Resolved 2026-10-11**: the driver has a
  `digest` step that runs `tools/deployable-content.mjs` on the node, so the
  reconciler reads a real digest for Windows and skips converged nodes like any
  other platform. Windows still has no `bash`, which is now irrelevant: the digest
  is computed by Node, not by `shasum`, and Node is already a hard requirement.
- **`.env` mode has no gate.** `sync` no longer resets it (fixed 2026-10-11), but
  nothing checks it either, so the fleet legitimately holds both `600` (macOS,
  owner-run) and `root:root 644` (Linux, so the `los` service user can read it).
  A consistency check would have to encode that rule rather than demand `600`.
- **macOS `unirun` install always warns.** `install` still calls
  `tools/install-unirun.sh --dest /usr/local/bin`, which needs root; macOS nodes
  therefore keep dispatching via native ssh. Skipping it on Darwin would make the
  deploy log honest instead of permanently noisy.
- **Maintenance windows do not gate scheduling.** `isNodeInMaintenance` is only
  consulted by fleet alerting, watch-state advancement, and host-check repair;
  the executor candidate filter never reads it. To actually stop work landing on
  a node, drain it.

The systemd unit still executes TypeScript with `tsx`. Moving to a built
executor artifact will reduce startup time and remove esbuild from the runtime
dependency set, but requires package export changes and a focused compatibility
gate.
