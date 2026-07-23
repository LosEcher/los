# Forgejo Branch And Merge Gates

Forgejo `los/los` is the primary repository. The local `origin` remote must
point to Forgejo; an optional GitHub backup uses the `github` remote name.

## Repository CI

`.forgejo/workflows/ci.yml` runs on pushes to `main`, pull requests targeting
`main`, and manual dispatch. Pull requests and manual dispatch run three
required jobs plus Web E2E; a protected `main` push runs `gate-fast` only
because the exact PR head must already have passed the three required checks
before merge. It provides:

1. `gate-fast`: typecheck, security, structure, coupling, state-machine,
   contracts, delete-safety, and wiring checks;
2. `gate-test`: the real root `pnpm test` path, which uses Turbo concurrency to
   run every package test script once against PostgreSQL 16;
3. `gate-drift`: migration-versus-ensure-store schema drift verification;
4. `gate-web-e2e`: Playwright operator-path specs, scheduled after `gate-fast`
   on node34 while the Windows test path runs independently.

The workflow cancels an older in-progress run for the same ref. Each runner
bind-mounts its own host-persistent pnpm store into its jobs, and dependency
installation uses `--prefer-offline`. This avoids downloading and executing an
external cache action before repository checks can start. Turbo `test` remains
uncached and every package test command executes on every PR.

The node34 runner keeps `gate-fast` and Web E2E. `gate-fast` uses
`ubuntu-latest` with `TURBO_CONCURRENCY=1`; Web E2E stays there until Chromium
is provisioned in a Windows job image. The repo-scoped `win-los-canary` runner
handles `gate-test` through `win-ci-jj` and `gate-drift` through `win-ci`. Both
labels use the pinned `los-ci:node22-jj0.39.0` image. `gate-test` advertises two
Turbo package tasks through `LOS_TEST_CONCURRENCY=2` on the effective 8-vCPU,
16-GiB Podman VM.

`gate-test` and Web E2E depend on `gate-fast`, so a fast failure does not
allocate either expensive workload. After fast passes, node34 runs the
single-worker browser path while Windows runs the workspace tests and later
the short drift job. Do not remove the fast dependency or raise the Windows
limit without CPU, available-memory, swap, service-latency, and job-duration
evidence from representative unchanged-head runs.

`gate-drift` depends on `gate-test` while the isolation change is observed. The
jobs register distinct PostgreSQL service DNS names (`postgres-test` and
`postgres-drift`). Keep the dependency until three consecutive full green runs
prove the Windows Podman service networking and resource envelope; only then
reassess same-host overlap.

`.forgejo/workflows/audit.yml` runs the dependency audit daily and manually.

Runner requirements are Linux containers, Git, Bash, Node 22+, Corepack, pnpm
9, service containers, and outbound access to the package registry. The
Windows labels require the locally provisioned `los-ci:node22-jj0.39.0` and
`postgres:16` images because its Podman VM cannot reliably pull Docker Hub.
The CI image must provide jj 0.39.0 and pnpm 9.0.0 and is built with
`tools/build-forgejo-ci-image.sh`. The PostgreSQL service user must be able to
create the temporary drift databases.

The Windows runner configuration must allow and mount its named store:

```yaml
container:
  options: "--volume forgejo-pnpm-store:/root/.local/share/pnpm/store"
  valid_volumes:
    - forgejo-pnpm-store
```

Windows jobs verify the image-provided pnpm version but do not run
`corepack prepare`; otherwise a registry timeout can fail the job before the
preheated package store is used.

`win-los-canary` is a manually enabled burst runner. Start the Windows host,
Podman machine, and runner before opening or updating a delivery PR; otherwise
the required Windows jobs remain queued. Do not treat it as unattended
capacity until startup automation and three unchanged-head runs are recorded.

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

## GitHub Independence

No build or deterministic test requires GitHub. GitHub Actions, rulesets, `gh`,
and GitHub PR state are optional mirror services and must not be included in the
Forgejo completion gate.
