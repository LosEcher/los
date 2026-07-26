# Forgejo Branch And Merge Gates

Forgejo `los/los` is the primary repository. The local `origin` remote must
point to Forgejo; an optional GitHub backup uses the `github` remote name.

## Repository CI

`.forgejo/workflows/ci.yml` runs on pull requests targeting `main` and manual
dispatch. Both events run three required jobs plus Web E2E. Protected `main`
does not repeat the workflow because the exact PR head must already have passed
the required checks before merge. It provides:

1. `gate-fast`: typecheck, security, structure, coupling, state-machine,
   contracts, delete-safety, and wiring checks;
2. `gate-test`: the real root `pnpm test` path, which uses Turbo concurrency to
   run every package test script once against PostgreSQL 16;
3. `gate-drift`: migration-versus-ensure-store schema drift verification;
4. `gate-web-e2e`: Playwright operator-path specs, scheduled after `gate-fast`
   on the Windows runner while the test path runs independently.

The workflow cancels an older in-progress run for the same ref. Each runner
bind-mounts its own host-persistent pnpm store into its jobs, and dependency
installation uses `--prefer-offline`. This avoids downloading and executing an
external cache action before repository checks can start. Turbo `test` remains
uncached and every package test command executes on every PR.

The repo-scoped `win-los-canary` runner handles `gate-fast` and `gate-test`
through `win-ci-jj`, `gate-drift` through `win-ci`, and Web E2E through
`win-ci-playwright`. The first two labels use the pinned Node 24 image. The
Playwright label uses `los-ci:node22-jj0.39.0-playwright1.61.1`, which preloads
Chromium and its Debian dependencies. `gate-test` advertises two Turbo package
tasks through `LOS_TEST_CONCURRENCY=2` on the effective 8-vCPU, 15-GiB Podman
VM. node34 runs Forgejo only and is not a CI fallback.

`gate-test` and Web E2E depend on `gate-fast`, so a fast failure does not
allocate either expensive workload. After fast passes, the Windows runner runs
the single-worker browser path alongside the workspace tests and later the
short drift job. Do not remove the fast dependency or raise the Windows limit
without CPU, available-memory, swap, service-latency, and job-duration evidence
from representative unchanged-head runs.

`gate-drift` starts independently with `gate-fast`. Its PostgreSQL service uses
a distinct DNS name, database, user, and credential from `gate-test`. Manual
isolation canary run `269` (UI run `241`) completed both dependency-free jobs
in the same 22-second window before this dependency was removed. Keep runner
capacity at two and restore `needs: gate-test` if later evidence shows Podman
service-network collisions, swap growth, or Forgejo latency during overlap.

`.forgejo/workflows/audit.yml` runs the dependency audit manually. The daily
schedule is disabled so an offline Windows host cannot accumulate unattended
work.

Runner requirements are Linux containers, Git, Bash, Node 22+, Corepack, pnpm
9, service containers, and outbound access to the package registry. The
Windows labels require the locally provisioned Node 24, Playwright, and
`postgres:16` images because its Podman VM cannot reliably pull Docker Hub.
The base CI image must provide jj 0.39.0 and pnpm 9.0.0 and is built with
`tools/build-forgejo-ci-image.sh`. The Playwright derivative is built and
smoke-tested with `tools/build-forgejo-playwright-image.sh`, then exported to
Windows before the label is enabled. The PostgreSQL service user must be able
to create the temporary drift databases.

The Windows runner configuration must allow and mount its named store:

```yaml
container:
  options: "--volume forgejo-pnpm-store:/root/.local/share/pnpm/store"
  valid_volumes:
    - forgejo-pnpm-store
```

Windows jobs verify the image-provided pnpm version but do not run
`corepack prepare`; otherwise a registry timeout can fail the job before the
preheated package store is used. The Windows Playwright job follows the same
rule.

`win-los-canary` is manually enabled CI capacity. Start the Windows host,
Podman machine, and runner before opening or updating a delivery PR; otherwise
the required Windows jobs remain queued. Do not treat it as unattended
capacity until startup automation and three unchanged-head runs are recorded.

The Windows host observer is not part of every pull request. Exact-head run
`289` for PR `#70` verified task `863` with 18 samples, zero unavailable
samples, a 15-second interval, and a 6.496% probe duty cycle. Task-container
peaks were 1,237,619,573 bytes, 121.44% CPU, and 262 PIDs. The shared WSL
working set is host context rather than per-job RSS; page-file used stayed at
65,011,712 bytes through start, sampled peak, job end, and the five-minute
post-run sample. Raw host JSON was summarized into the todo/document record and
the six explicit temporary paths were then verified absent. Continue sampling
only every fifth eligible PR and keep Windows results separate from GitHub
Linux samples. This canary proves observer compatibility, not long-term runner
capacity.

## Required Server Policy

Configure Forgejo `main` protection to:

1. reject deletion and non-fast-forward updates;
2. require a pull request for normal changes;
3. require successful `gate-fast`, `gate-test`, and `gate-drift` checks;
4. reject merges while required checks are pending or stale;
5. restrict bypass permission to an explicitly audited emergency operator.

The exact server-side rule must be verified in the Forgejo UI or authenticated
API. Repository YAML cannot create branch protection by itself.

The `main` fast-only policy depends on normal changes entering through this
protected PR path. If an emergency operator bypasses the pull-request rule, run
the full workflow manually before treating that revision as verified.

For a required-context migration, first make the workflow emit the replacement
context, verify it on an exact PR head, then add it to server protection, and
only then remove the retired context. Rollback follows the same overlap rule:
restore the last verified workflow behavior on a feature bookmark, obtain a
green exact-head run, and then restore the server context set. Stop merges
throughout the change. An emergency bypass remains an explicitly audited
operator action and requires a full manual workflow on the final SHA afterward.

## Merge Evidence

Before merging:

```bash
bash tools/branch-closeout.sh
```

The closeout script treats `origin` as primary and queries Forgejo Actions when
the remote uses HTTP(S). Private repositories require `FORGEJO_TOKEN` for API
evidence. A local gate does not substitute for a green clean-checkout Forgejo
run on the exact PR head.

After merging:

```bash
jj git fetch --remote origin
jj log -r 'main@origin' -n 1
bash tools/branch-prune-origin.sh
```

Use `--apply` for branch deletion only with explicit operator approval.

PR `#70` is the current delivery example: exact head
`70aa3d14f2a9e324256fed3aec2ab2ac2c66da59` passed run `289`, jobs `942--945`,
and merged as `a14fc8751cba847b3a08825bd86ef295438dfd60`. The optional GitHub mirror used
an independent equivalent-patch PR because its merge history had diverged; that
mirror result did not gate the Forgejo merge. Both remote feature branches were
retained because no branch-deletion approval was given.

## Failure Artifacts

Regular Forgejo CI does not upload retained failure bundles yet. The server
reports version `16.0.1+gitea-1.22.0`, and its authenticated run-artifact list
endpoint returns HTTP 200, but the advertised user and organization artifact
quota endpoints return HTTP 404 for the current operator account. Storage
capacity and cleanup policy therefore remain unverified.

`.forgejo/workflows/artifact-canary.yml` is a manual compatibility probe. It
uploads and downloads a 1 KiB sentinel with the patched
`forgejo/upload-artifact@v4` and `forgejo/download-artifact@v4` actions, requests
one-day retention, and verifies the downloaded bytes. A successful canary
proves the runner round trip only; it does not authorize enabling regular
failure uploads until the instance quota and cleanup configuration are read.

Canary run `286` did not reach upload: cloning `forgejo/upload-artifact@v4`
timed out, job `933` failed after 301 seconds, and the run contained zero
artifacts. Therefore regular Forgejo CI still owns only runner-temporary logs;
it uploads neither success artifacts nor retained failure bundles. The unified
owner, cleanup trigger, size, and retention table is in
`docs/operations/2026-07-25-ci-cd-observability-priority-and-todo-plan.md`.

Forgejo's artifact compatibility and retention references are:

- <https://forgejo.org/docs/latest/user/actions/advanced-features/>
- <https://forgejo.org/docs/latest/admin/actions/>

## GitHub Independence

No build or deterministic test requires GitHub. GitHub Actions, rulesets, `gh`,
and GitHub PR state are optional mirror services and must not be included in the
Forgejo completion gate.
