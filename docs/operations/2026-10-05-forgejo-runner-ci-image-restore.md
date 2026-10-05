# Forgejo Runner CI Image Restore (2026-10-05)

Operational record. Every Forgejo job failed at container start because the
runner's Podman store had lost the `los-ci` image while Docker Hub is not
reachable from the runner machine. The image was rebuilt on the Mac and loaded
into the runner's store.

## Symptom

PR #319 (`fix(gateway): gate unirun ssh flags on the resolved binary version`)
produced runs 1101 and 1103, and **all four jobs** (`gate-fast`, `gate-test`,
`gate-drift`, `gate-web-e2e`) failed after ~2m13s with:

```
🚀  Start image=los-ci:node24.16.0-jj0.39.0
  🐳  docker pull image=los-ci:node24.16.0-jj0.39.0 platform=linux/amd64 username= forcePull=false
Error response from daemon: i/o timeout
```

The last green run before this was **869 (2026-09-06)**; nothing was pushed to
`main` between then and 2026-10-05, so the outage went unnoticed for a month.

Note: Forgejo 16.0.5+gitea-1.22.0 has **no re-run API**
(`POST /api/v1/repos/{owner}/{repo}/actions/runs/{id}/rerun` → 404). A second
run for an unchanged head is produced by closing and reopening the PR, or by
`POST /actions/workflows/ci.yml/dispatches` with `{"ref":"main"}`
(`ci.yml` declares `workflow_dispatch` for unchanged-head canaries).

## Diagnosis

Runner topology is unchanged from
`2026-08-18-runner-topology-and-turbo-persistence.md`: one device
(`DESKTOP-R45553O` / `win-los`), one Podman machine, one `act_runner`, three
labels.

| Probe | Result |
| --- | --- |
| `ssh win-los 'podman ps -a'` | `forgejo-runner-win-canary` **Up 3 weeks** — runner itself healthy |
| `ssh win-los 'podman images'` | `forgejo/runner:12`, `postgres:16`, `alpine:3` — **no `los-ci`** |
| Machine egress (`podman run --rm alpine wget https://registry.npmjs.org/`) | works |
| Machine egress (`curl https://registry-1.docker.io/v2/`) | timed out (12s) |
| `wsl -l -v` | `Ubuntu` (stopped), `podman-machine-default` (running) |

So the failure is: the job image is absent from the machine store, and the
machine cannot pull it from Docker Hub. WSL reports the likely cause of the
egress gap: a Windows `localhost` proxy is configured but not mirrored into
WSL (`NAT` mode cannot use a localhost proxy).

**Pitfall that cost a diagnosis round:** `wsl -d podman-machine-default --
podman images` reads a *different, empty* store than the Windows-side
`podman.exe` (which talks to the machine's real store). Do not conclude "the
machine has no images" from the WSL-side CLI; use `ssh win-los 'podman images'`.

## Fix

Build the image where the registry is reachable, then load it into the
machine's store. The Mac has Docker (OrbStack, `linux/amd64` via emulation):

```bash
# 1. On the Mac (build context is the repo; the script verifies node/jj/pnpm)
CONTAINER_ENGINE=docker bash tools/build-forgejo-ci-image.sh

# 2. Package and transfer (1.18 GB image → 440 MB gzip; ~18s over LAN)
docker save -o /tmp/los-ci.tar los-ci:node24.16.0-jj0.39.0
gzip -1 /tmp/los-ci.tar
scp -o ControlPath=none -o HostName=192.168.31.5 \
  /tmp/los-ci.tar.gz win-los:C:/Users/los/los-ci.tar.gz

# 3. Load into the runner's Podman store (Windows-side podman CLI)
ssh win-los 'podman load -i C:\Users\los\los-ci.tar.gz'

# 4. Verify short-name resolution and the toolchain the jobs need
ssh win-los 'podman image exists los-ci:node24.16.0-jj0.39.0 && podman run --rm los-ci:node24.16.0-jj0.39.0 sh -c "node -v; jj --version; pnpm --version"'
# → v24.16.0 / jj 0.39.0-9689cd9… / 11.6.0
```

`podman load` stores the image as `docker.io/library/los-ci:node24.16.0-jj0.39.0`;
`podman image exists los-ci:node24.16.0-jj0.39.0` resolves the short name, which
is how the runner requests it.

### Second image: the Playwright chain

`gate-web-e2e` (queue `win-ci-playwright`) needs
`los-ci:node22-jj0.39.0-playwright1.61.1`, which was missing for the same
reason. It is built from the older `node:22` line, so the whole chain has to be
rebuilt (one generation older than the node24 image):

```bash
# Node 22 base (the playwright image builds FROM this tag)
CONTAINER_ENGINE=docker \
FORGEJO_CI_NODE_IMAGE=node:22-bookworm \
FORGEJO_CI_NODE_MAJOR=22 \
FORGEJO_CI_IMAGE=los-ci:node22-jj0.39.0 \
  bash tools/build-forgejo-ci-image.sh

# Playwright layer (Chromium + its Debian runtime libraries, 2.16 GB)
DOCKER_BUILDKIT=0 CONTAINER_ENGINE=docker \
  bash tools/build-forgejo-playwright-image.sh
```

**BuildKit pitfall:** with the default builder, `FROM los-ci:node22-jj0.39.0`
in `.forgejo/images/node22-jj-playwright/Dockerfile` is resolved against Docker
Hub, not the local store (`pull access denied … repository does not exist`), and
passing the bare image ID as `FORGEJO_CI_BASE_IMAGE` only renames the failing
pull (`docker.io/library/62a74a483213:latest`). The legacy builder uses the
local image: set `DOCKER_BUILDKIT=0`. Docker Desktop/OrbStack both honour it.

The same `docker save | gzip` → `scp` → `podman load -i` path transfers it
(864 MB compressed, ~10s over LAN).

## Verification

`workflow_dispatch` run **1104** on `main` (`3df9e8c6`): `gate-fast`,
`gate-test` and `gate-drift` all `success` (jobs start containers again);
`gate-web-e2e` still failed on its own missing image, which is what led to the
second image above.

## Residual risk

- Both images live **only** in the Podman machine store. Any machine recreation
  or `podman system prune -a` removes them and CI breaks the same way; this
  record is the rebuild recipe.
- Docker Hub remains unreachable from the runner machine, so the runner cannot
  rebuild or pull the images by itself. `podman pull` for any *new* tag will hang
  for ~2 minutes and fail; use the save/load path instead.
- The Playwright chain is built from the older `node:22` line while
  `gate-fast`/`gate-test`/`gate-drift` run `node:24`; restoring one does not
  restore the other (they are separate tags).
- The WSL egress gap itself (Windows localhost proxy not mirrored into WSL) was
  **not** fixed — only worked around by building elsewhere. If the machine needs
  registry access in the future, set mirrored networking or configure the proxy
  inside WSL, then delete this workaround.
