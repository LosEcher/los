# unirun Pin And Capability Gate

Reference for the pinned `unirun` build los ships, and for the gate that decides
whether the gateway may dispatch `unirun ssh`. Closes the los side of the
cross-project audit's C4/F1 finding ("los has no unirun install step / version
pin; a host with 0.3.0 installed made the gate idle").

## Why the gate is not a version table

`packages/gateway/src/ssh-command-runner.ts` dispatches node commands to
`unirun ssh` only when the resolved binary advertises the capability keys the
call needs. `packages/gateway/src/unirun-capabilities.ts`:

1. probes candidates in order — `LOS_UNIRUN_BIN`, `PATH`, `~/.cargo/bin/unirun`,
   `/usr/local/bin/unirun`, `/opt/homebrew/bin/unirun`;
2. asks each one `unirun capabilities --json` (available from unirun 0.5.0) and
   reads the stable keys `ssh-identity` and `ssh-workdir-env`;
3. **skips** a candidate that cannot describe itself and keeps looking, so a
   stale `~/.cargo/bin/unirun` does not shadow a good one;
4. treats everything unreadable as "no capabilities", which keeps the call on
   native ssh instead of handing the binary flags it may append to the remote
   script (pre-0.5.0 behaviour) or reject with exit 2 (0.5.0 `strict-flags`).

The probe runs once per process and the outcome is cached. Fallbacks are logged
with a reason: `unirun_unavailable` (nothing found), `unirun_capability_gap` (a
binary exists but cannot serve this call, logged once with `unirunVersion`),
`unirun_error` (it ran and failed), `policy_native` (`LOS_SSH_RUNNER=native`).

A version→feature table lived here until the 0.5.0 capability document made it
unnecessary; it is deleted, not deprecated. The corresponding assertion in
unirun's own source (`src/capabilities.rs`) is satisfied.

## The pin

| Item | Value |
| --- | --- |
| Pin file | `deploy/unirun-pin.txt` (`UNIRUN_VERSION`, one sha256 per asset) |
| Installer | `tools/install-unirun.sh` (POSIX sh; alpine/busybox compatible) |
| Docker | runtime stage installs the pinned **musl** asset to `/usr/local/bin/unirun` and sets `LOS_UNIRUN_BIN` |
| Deploy | `tools/deploy-to-remote.sh <node> install` runs the installer on the node after `pnpm install`; `verify` reports the outcome |
| Local | `pnpm run doctor` prints `unirun: ok (<version>)`, `absent`, or `unirun: unusable` |

Installer contract:

- asset naming is the release contract (`unirun-linux-x86_64-musl`,
  `unirun-linux-aarch64-musl`, `unirun-macos-aarch64`); a platform without a
  pinned digest fails closed rather than installing unverified bytes;
- the download is sha256-verified against the pin, then executed once to confirm
  it reports both capability keys; **verification happens before the file
  replaces anything in `--dest`**, so a wrong asset cannot clobber a working
  binary;
- an existing binary is only kept when its version is exactly `UNIRUN_VERSION`
  and it passes the capability check; any other version is replaced;
- `--skip-run-check` exists for cross-platform installs (a foreign-arch binary
  cannot be executed on the build host); `LOS_SKIP_UNIRUN_INSTALL=1` opts out
  with a warning;
- GitHub publishes no checksum asset, so the digests in the pin file are
  recorded here by the person bumping the pin. That is what makes a version bump
  a reviewed change rather than a silent upgrade.

## Bump Procedure

```bash
# 1. edit deploy/unirun-pin.txt: UNIRUN_VERSION + the sha256 of each asset
#    (assets: https://github.com/LosEcher/unirun/releases/download/v<ver>/<asset>)
# 2. verify the installer end to end on this host and in an alpine container
sh tools/install-unirun.sh --dest /tmp/unirun-check --force
sh tools/install-unirun.sh --check --dest /tmp/unirun-check
docker run --rm -v "$PWD":/ctx:ro alpine:3.20 sh -euc '
  cp /ctx/deploy/unirun-pin.txt /ctx/tools/install-unirun.sh /tmp/
  apk add --no-cache ca-certificates >/dev/null
  sh /tmp/install-unirun.sh --pin /tmp/unirun-pin.txt \
    --asset unirun-linux-aarch64-musl --dest /usr/local/bin'
# 3. rebuild the image (COPY of the pin file invalidates the layer by itself)
docker build -t los .
```

The capability keys the installer demands and the keys the gateway gate reads
are asserted equal by `packages/gateway/src/unirun-capabilities.test.ts`; adding
a gate without adding it to `REQUIRED_FEATURES` fails that test.

## Verification Record (2026-10-07)

| Check | Result |
| --- | --- |
| `sh tools/install-unirun.sh` (macos-aarch64, pinned 0.5.0) | `installed unirun 0.5.0`, re-run skips without network |
| Tampered digest in a copied pin file | refused: `sha256 mismatch … refusing to install` |
| Wrong-platform asset with `--force` | refused, destination binary byte-identical afterwards |
| alpine:3.20 / linux/arm64 (busybox sh, wget) | pinned `aarch64-musl` installed, `unirun 0.5.0`, keys ok |
| alpine:3.20 / linux/amd64 (emulated) | pinned `x86_64-musl` installed, `unirun 0.5.0` |
| `pnpm run doctor` on the macOS gateway host | `unirun: ok (0.5.0)` |
| Focused tests | `node --import tsx --test src/unirun-capabilities.test.ts src/ssh-command-runner.test.ts` → 38 pass |
| `pnpm --filter @los/gateway test` | package suite exit 0 (shared-process + isolated lanes) |
| `docker build -t los .` (linux/arm64) | succeeds; `TARGETARCH=arm64` installs the pinned `aarch64-musl` asset |
| Gateway probe inside the built image (user `los`) | `LOS_UNIRUN_BIN` → `/usr/local/bin/unirun`, capabilities full; without it, PATH resolves the same binary |
| Stale binary inside the image | a 0.3.0 at the head of the candidate list is skipped in favour of the pinned one; if it is the only one, it is reported as `staleVersion=unirun 0.3.0` with no capabilities (native fallback, named) |
| `./tools/ci-gate.sh --no-tests` | all phases pass except the pre-existing wiring-topology drift (unrelated: baseline last updated 2026-08-28, flagged sources 2026-10-05/06) |

## Residual Risk

- **No upstream checksum publication.** Digests are trust-on-first-record by the
  person bumping the pin; a compromised release would need a second pair of eyes
  on the bump change, not an automated check.
- **macOS x86_64 has no release asset.** The installer refuses there and points
  at `cargo install unirun@<version>` plus `LOS_UNIRUN_BIN`.
- **Node reachability to `github.com`.** `install` warns (native ssh still works)
  unless `LOS_REQUIRE_UNIRUN=1`; a node can therefore stay on native ssh after a
  deploy, visibly, but not silently.
- **Native fallback semantics are unchanged** (audit C8): a call that falls back
  still gets `cd`/`export` joined with `; `. C4/F1 only guarantees that a node
  with the pinned unirun does not take that path.
- The `tools/install-unirun.sh` script was exercised locally, inside alpine, and
  through a full image build; no live fleet node was deployed to as part of this
  change, so the `deploy-to-remote.sh` install/verify steps are reviewed and
  syntax-checked but not yet run against a node.
