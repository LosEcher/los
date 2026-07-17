# Forgejo Runner And CI Optimization (2026-07-17)

## Outcome

The los Forgejo runner now accepts two concurrent jobs and bind-mounts a
host-persistent pnpm store into each job. The repository workflow cancels
superseded runs, runs full CI on pull requests, and avoids repeating the two
expensive database jobs after a protected merge to `main`.

This is a bounded capacity increase, not a three-runner deployment. Forgejo CI
now has successful protected-PR, cold-store, and warm-store evidence for the
final scheduling and mount configuration. Forgejo PR `#25` merged the workflow
at `c1254d1b`; subsequent `main` run `160` verified the fast-only path. GitHub
mirror PR `#154` merged the same delivery line at `d6f1ba8f`.

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
  about 125 MiB during the run and stabilized afterward;
- `[E]` Forgejo PR `#25` merged to `origin/main=c1254d1b`, with all three
  required checks green on the exact PR head;
- `[E]` protected `main` run `160` ran only `gate-fast` and completed in 3
  minutes 5 seconds; `gate-test` and `gate-drift` were skipped;
- `[E]` branch protection still has `block_on_outdated_branch=true` after the
  merge;
- `[E]` GitHub mirror PR `#154` merged to `github/main=d6f1ba8f`, with all ten
  mirror checks green;
- `[E]` `git ls-remote origin refs/heads/main` and
  `git ls-remote github refs/heads/main` returned those two heads on 2026-07-17;
- `[E]` the delivery handoff had a clean local jj working copy, `main` pointed
  to `c1254d1b`, and `jj workspace list` contained only the default workspace
  before this documentation follow-up.

Not yet verified:

- `[U]` repeated real pull-request batches remain free of queueing regressions,
  sustained swap growth, and resource-related flakes over a 10-20 PR window.

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

## Post-Delivery Todo Ledger

This is the operational follow-up queue for this runner change. It does not
replace the product P0/P1 queue in
`docs/governance/2026-07-16-current-p0-p1-queue.md`.

| ID | Priority | State | Work | Completion evidence |
| --- | --- | --- | --- | --- |
| `CI-OBS-01` | P0 | observing | Record the next 10-20 real Forgejo PR runs | Interim summary at 10 eligible PRs; close at 20 or earlier on a resource stop condition, with queue and duration P95, minimum available memory, swap delta, and classified flake rate |
| `CI-NET-01` | P1 | backlog | Give `gate-test` and `gate-drift` isolated PostgreSQL DNS/network identities, then reassess the serial dependency | Both jobs overlap without cross-connecting, followed by three consecutive full green runs before removing `needs: gate-test` |
| `CI-STORE-01` | P1 | backlog | Add a periodic pnpm store capacity check without restoring `actions/cache` | A documented command and cadence record store size plus filesystem free space; growth has an owner and cleanup decision |

`CI-OBS-01` owns the immediate next action. `CI-NET-01` is the prerequisite for
any attempt to parallelize the two database jobs. `CI-STORE-01` is independent
and can be added without changing job execution behavior.

Historical local-only jj changes remain in the repository history. They do not
dirty the current working copy and are not part of this delivery. Review or
abandonment is a separate destructive-history decision and requires explicit
operator scope.

## Observation Protocol

Eligible samples are real pull-request workflows created after PR `#25`.
Exclude `workflow_dispatch`, protected-`main`, cancelled superseded heads, and
unchanged reruns from the primary PR denominator. Record excluded runs
separately when they provide resource or flake evidence.

For each eligible PR, record:

1. PR number, exact head SHA, run id, result, and whether the head was current;
2. queue time from workflow creation to the first job start;
3. total workflow duration and each job duration;
4. minimum host available memory during the run;
5. swap used before the run, peak swap used, and swap used five minutes after
   completion; report both peak and post-run deltas;
6. pnpm store size and host-filesystem free space;
7. any failed or rerun job, classified as code/test failure, resource failure,
   network/provider failure, cancellation, or unexplained flake.

Use nearest-rank P95 after the tenth eligible PR and recompute at twenty. Define
flake rate as unchanged-head attempts that fail and then pass without a code or
configuration change, divided by all eligible PR attempts. Do not count a
superseded cancellation as a flake. The PR sample count uses unique heads; the
attempt-level flake denominator also includes their unchanged reruns.

Keep runner capacity at two throughout the window. Stop the observation window
and investigate immediately if a run is OOM-killed, exits with resource
exhaustion, drops below 1.5 GiB available memory, or fails to stabilize swap
after completion. Do not test three-runner capacity on the current 3-core/6-GB
host.

On node34, capture store capacity weekly and after every fifth eligible PR:

```bash
du -sm /home/z/forgejo/runner-data/job-cache/pnpm-store
df -Pm /home/z/forgejo/runner-data/job-cache/pnpm-store
```

The initial persistent-store baseline is about 225 MiB. Size growth alone does
not authorize deletion; record the trend and filesystem pressure before choosing
a cleanup policy.

### Delivery Evidence Snapshot

These runs establish the starting point but do not count toward the post-merge
10-20 PR observation denominator.

| Run | Event | Total | `gate-fast` | `gate-test` | `gate-drift` | Memory / swap | Store | Result |
| --- | --- | ---: | ---: | ---: | ---: | --- | ---: | --- |
| `155` | protected PR | 11m36s | 7m01s | 10m53s | 42s | not recorded | pre-fill | green |
| `157` | cold dispatch | 10m54s | not recorded | not recorded | not recorded | available >2.3 GiB; swap +125 MiB and stabilized | ~225 MiB | green |
| `158` | warm dispatch | 10m57s | not recorded | not recorded | not recorded | not recorded | ~225 MiB | green |
| `160` | protected `main` | 3m05s | 3m05s | skipped | skipped | not recorded | ~225 MiB | green |

### Eligible PR Log

Append one row per eligible PR. Use `unknown` rather than inferring a metric
that was not captured.

| Sample | PR | Head SHA | Run | Queue | Total | Fast | Test | Drift | Min available MiB | Swap peak delta MiB | Swap +5m delta MiB | Store MiB | Result | Flake class / note |
| ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |

### Rolling Summary

Update this after samples 10 and 20.

| Eligible PRs | Queue P95 | Total P95 | Minimum available memory | Maximum swap peak delta | Maximum swap +5m delta | Flake rate | Judgment |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| `0 / 20` | pending | pending | pending | pending | pending | pending | observation started |

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
