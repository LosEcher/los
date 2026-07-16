# Forgejo Runner And CI Optimization (2026-07-17)

## Outcome

The los Forgejo runner now accepts two concurrent jobs and bind-mounts a
host-persistent pnpm store into each job. The repository workflow cancels
superseded runs, runs full CI on pull requests, and avoids repeating the two
expensive database jobs after a protected merge to `main`.

This is a bounded capacity increase, not a three-runner deployment. Forgejo CI
now has successful protected-PR, cold-store, and warm-store evidence for the
final scheduling and mount configuration.

## Observed Baseline

The following values were verified before the runner restart:

| Surface | Observed value |
| --- | --- |
| Host CPU | 3 vCPU |
| Host memory | 5,925 MiB total; 3,423 MiB available |
| Host swap | 6,045 MiB total; 4,486 MiB used |
| los runner | Forgejo runner `v12.12.0`, `capacity: 1`, cache disabled |
| Job image | `node:22-bookworm` |
| Network | runner and job containers use `forgejo_forgejo-net` |
| Other load | Forgejo plus multiple database and application containers share the host |
| Recent successful PR runs | 999-1,192 seconds each with one runner slot |
| Merged-main run `149` | 1,042 seconds; success |

Five pull requests entering the single-slot queue caused later runs to wait for
earlier three-job workflows. The observed 16-20 minute run duration was therefore
only part of the two-hour delivery time; serialized runs, reruns, and strict
stacked-PR merge ordering contributed the rest.

## Judgment

Three full concurrent jobs are not an appropriate default for this host. The
machine has three cores, already uses about 4.4 GiB of swap, and hosts unrelated
stateful services. Three Node workspaces plus PostgreSQL service containers can
increase reclaim and I/O wait enough to make nominal parallelism slower or less
reliable.

Two runner slots are the current limit. The test job caps Turbo at two package
tasks and the fast job caps it at one. This keeps the combined package-task
limit aligned with the three-core host while still allowing the drift job or
non-Turbo fast checks to overlap.

## Effective Configuration

The host-owned runner configuration is outside this repository:

```yaml
runner:
  capacity: 2

container:
  options: "--volume /home/z/forgejo/runner-data/job-cache/pnpm-store:/root/.local/share/pnpm/store"

cache:
  enabled: false
```

The pre-change file is backed up at:

```text
/home/z/forgejo/runner-data/config.yaml.bak-20260717-001917
```

The rejected intermediate cache-action configuration is retained separately at
`/home/z/forgejo/runner-data/config.yaml.bak-20260717-005654` for audit only; it
is not the rollback target.

After restart, the runner declared successfully. The persistent store directory
is `/home/z/forgejo/runner-data/job-cache/pnpm-store`; Docker mounts it at the
same pnpm store path configured by every workflow job.

The first cache-action trial failed before repository steps: two concurrent jobs
attempted to populate the runner's shared action repository, and the clone from
`data.forgejo.org` ended with an HTTP transport reset after 7 minutes 27 seconds.
The final design therefore removes the external cache action from the CI
critical path instead of treating a rerun as evidence of reliability.

The first persistent-store trial exposed a separate concurrency issue:
`gate-test` and `gate-drift` both advertised a service named `postgres` on
`forgejo_forgejo-net`. The drift process could create a database through one
service container and reconnect through the other. The final workflow sequences
the two database jobs while retaining `gate-fast` and `gate-test` overlap.

## Repository CI Policy

`.forgejo/workflows/ci.yml` applies these rules:

1. A newer run for the same ref cancels the older run.
2. Pull requests and manual dispatch run `gate-fast`, `gate-test`, and
   `gate-drift`.
3. A push to protected `main` runs `gate-fast` only.
4. The runner mounts one persistent pnpm content-addressed store into all job
   containers.
5. `pnpm install --frozen-lockfile --prefer-offline` consumes that store without
   weakening lockfile enforcement.
6. No external cache action or cross-run Turbo cache is used; every test still
   executes.
7. `gate-test` sets `LOS_TEST_CONCURRENCY=2`, and `gate-fast` sets
   `TURBO_CONCURRENCY=1`; local development keeps the existing test default of
   four unless the variable is set.
8. `gate-drift` waits for `gate-test`, preventing their identically named
   PostgreSQL service containers from overlapping on the fixed runner network.

The `main` fast-only rule is safe only while Forgejo branch protection requires
all three PR checks and `block_on_outdated_branch=true`. The API showed required
contexts for `CI / gate-fast (*)`, `CI / gate-test (*)`, and
`CI / gate-drift (*)` after the delivery batch.

## Verification Status

Verified:

- workflow YAML parses;
- `tools/run-tests.sh` passes `bash -n`;
- `pnpm check` passes with only the existing grandfathered module-size warnings;
- `LOS_TEST_CONCURRENCY=2 pnpm test` completes 15 Turbo tasks with zero
  failures in about 3 minutes 41 seconds;
- runner effective config is `capacity: 2` with the persistent pnpm store mount;
- final config restart completed and stale failed-run containers were removed;
- protected PR run `155` passed all required contexts in 11 minutes 36 seconds:
  `gate-fast` 7 minutes 1 second, `gate-test` 10 minutes 53 seconds, and the
  dependent `gate-drift` 42 seconds;
- cold-store dispatch run `157` passed in 10 minutes 54 seconds and grew the
  store from 4 KiB to about 225 MiB;
- warm-store dispatch run `158` passed in 10 minutes 57 seconds with the store
  size unchanged;
- a warm install log reported 296 reused packages, zero downloaded packages,
  and a 13.7-second install;
- the cold run retained more than 2.3 GiB available memory; swap increased by
  about 125 MiB during the run and stabilized afterward.

Not yet verified:

- protected `main` runs only `gate-fast` after this workflow is merged;
- repeated batches remain free of resource-related flakes over a longer window.

## Acceptance Result

The acceptance runs showed:

1. cold and warm total duration were effectively equal because the full test
   suite, not package download, dominates elapsed time;
2. the persistent store still removes repeat package downloads and reduces the
   installation resource spike;
3. two slots reduce the former 16-20 minute serialized PR runtime to about
   11 minutes for this change;
4. `gate-fast` and `gate-test` overlap, while `gate-drift` starts only after
   `gate-test` completes;
5. all three required PR contexts remain green and mergeable.

Keep `capacity: 2` while the host retains at least about 1.5 GiB available
memory without sustained swap growth. The acceptance runs remained above that
limit. Restore the backup and restart only `forgejo-runner` if later batches
cross it or introduce resource-related flakes.

## Rollback

Runner rollback:

```bash
cp /home/z/forgejo/runner-data/config.yaml.bak-20260717-001917 \
  /home/z/forgejo/runner-data/config.yaml
docker restart forgejo-runner
```

Repository rollback removes the event conditions, then restores the fixed
`turbo test --concurrency=4` command. Do not change the other project runners or
disable `block_on_outdated_branch` as part of this rollback.

## Delivery Process Improvements

For another stacked batch, avoid opening every cumulative layer into a
single-slot queue at once. Submit the first mergeable layer, let its required
checks finish, update the next layer onto current `main`, and continue. If all
layers must remain open for review, limit active CI to the next one or two
mergeable heads rather than spending full clean-checkout runs on heads that will
immediately become outdated.

Keep `block_on_outdated_branch=true`. The temporary disable used for PRs
`#20-#24` bypassed the normal stale-base guard and should remain an exceptional,
explicitly audited operation rather than the standard stacked-PR procedure.
