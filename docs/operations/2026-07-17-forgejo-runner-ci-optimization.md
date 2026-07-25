# Forgejo Runner And CI Optimization (2026-07-17)

## Outcome

The 2026-07-25 operator decision supersedes the node34 shared-CI design. node34
will run Forgejo as a code archive only; all LOS Forgejo jobs move to the
repo-scoped Windows Podman runner. The migration keeps the existing job/context
names and dependency order, removes the protected-`main` duplicate run, and
disables the unattended dependency-audit schedule. Three exact-head Windows
canaries are required before the node34 LOS runner is stopped and the PR is
merged.

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

Two runner slots remain the host-level limit. The 2026-07-17 acceptance run
allowed the test job's two Turbo tasks to overlap the fast job's single task.
The 2026-07-23 resource stop event below supersedes that scheduling rule: fast
and test are now serialized, and each expensive stage advertises only one Turbo
task so the shared host retains service headroom.

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
service container and reconnect through the other. The workflow now gives the
jobs distinct service identities (`postgres-test` and `postgres-drift`) while
retaining the serial dependency until three consecutive full green runs prove
that the jobs can overlap safely.

## Repository CI Policy

`.forgejo/workflows/ci.yml` applies these rules:

1. A newer run for the same ref cancels the older run.
2. Pull requests and manual dispatch run `gate-fast`, `gate-test`,
   `gate-drift`, and Web E2E.
3. A push to protected `main` runs `gate-fast` only.
4. Each runner mounts its own persistent pnpm content-addressed store into its
   job containers.
5. `pnpm install --frozen-lockfile --prefer-offline` consumes that store without
   weakening lockfile enforcement.
6. No external cache action or cross-run Turbo cache is used; every test still
   executes.
7. `gate-fast` uses node34's pnpm-preloaded `ubuntu-jj` image with
   `TURBO_CONCURRENCY=1`; after it passes, `gate-test` runs on Windows with
   `LOS_TEST_CONCURRENCY=2`. Local development keeps the existing test default
   of four unless the variable is set.
8. `gate-drift` waits for `gate-test` during the observation window; its
   PostgreSQL service identity is distinct from `postgres-test`, so a later
   parallelization trial cannot rely on an ambiguous shared DNS name.
9. Web E2E waits for `gate-fast`, then runs on node34 in parallel with the
   Windows test path. Its `ubuntu-playwright` label uses the prebuilt
   `los-ci:node22-jj0.39.0-playwright1.61.1` image, so CI no longer downloads
   Chromium or Debian browser dependencies on every run.

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

## 2026-07-17 Acceptance Result

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

These results describe the 2026-07-17 workload. The later resource event below
showed that the expanded suite no longer fits the same overlap envelope. Keep
runner capacity at two but serialize fast and test while node34 retains the CI
workload. Restore the backup and restart only `forgejo-runner` if later batches
cross the documented resource stop condition or introduce resource-related
flakes.

## Post-Delivery Todo Ledger

This is the operational follow-up queue for this runner change. It does not
replace the product P0/P1 queue in
`docs/governance/2026-07-16-current-p0-p1-queue.md`.

| ID | Priority | State | Work | Completion evidence |
| --- | --- | --- | --- | --- |
| `CI-OBS-01` | P0 | superseded | Record the next 10-20 real Forgejo PR runs | Replaced by Windows-runner observation because node34 no longer executes LOS CI |
| `CI-HOST-01` | P0 | done | Remove LOS CI resource contention from node34 without changing nmem | All four jobs passed three exact-head canaries on Windows; node34 LOS runner was stopped while Forgejo API and repository access remained healthy |
| `CI-NET-01` | P1 | observing | Give `gate-test` and `gate-drift` isolated PostgreSQL DNS, database, user, and credential identities, then reassess the serial dependency | Identities are distinct; retain `needs: gate-test` until the manual concurrency canary overlaps and three consecutive full green runs are evidenced |
| `CI-STORE-01` | P1 | done | Add a periodic pnpm store capacity check without restoring `actions/cache` | `gate-fast` runs `tools/observe-pnpm-store.sh --json`; the observation protocol records a weekly and every-fifth-eligible-PR cadence without deleting store content |
| `CI-TEST-01` | P1 | done | Compare the pinned Node 22 and Node 24 job images on the same source head and runner | Three warm runs per version completed; median difference was 0.04%, so Node 24 is retained as a compatibility upgrade rather than a performance optimization |
| `CI-TEST-02` | P1 | in progress | Separate DB-free regression tests, DB integration tests, and coverage collection | Agent and Gateway now have explicit DB-free and isolated-DB lanes plus separate coverage commands; three Gateway audit batches moved four files to the DB-free lane, while 35 Gateway files and the remaining DB packages still need classification |
| `CI-TEST-03` | P1 | in progress | Replace per-file migration/store setup with run-scoped provisioning and isolated mutable data | Agent and Gateway provision stores once per run and truncate mutable rows per isolated file; remaining DB packages and repeated CI evidence are pending |
| `CI-TEST-04` | P2 | backlog | Persist safe build/check caches and shorten the required-job dependency chain | Cache keys include OS, architecture, Node major, lockfile and task inputs; mutable DB, browser profile, coverage, secret, and session state remain uncached; full main/nightly gates detect classifier omissions |

`CI-HOST-01` owns the immediate next action. Its selected host-separation path
moves every LOS CI job to Windows and leaves `nmem.service` unchanged.
`CI-NET-01` remains the prerequisite for any attempt to parallelize the two
database jobs. After the migration canaries pass, the next test-runtime item is
the remaining Gateway isolated-DB audit: classify the 39 files, introduce
focused fakes or move DB-independent behavior into the DB-free lane, and retain
PostgreSQL where persistence behavior is part of the contract. The first audit
batch completed on 2026-07-25; after the third batch, 35 Gateway files remain
in the isolated lane.

## 2026-07-24 Test Runtime Optimization Plan

### Baseline

- [E] Workflow-dispatch run `255` used exact head
  `5db5df2742c77776e1c0ae5f0483eccaea96cddf` and completed in 11m30s.
- [E] `gate-fast` took 4m40s. Turbo type-checking took about 3m16s; the
  security, coupling, and wiring checks took about 23s, 29s, and 17s.
- [E] `gate-test` took 5m53s. `pnpm test` took 5m33s and critical coverage
  took about 12s.
- [E] The Agent package ran 832 tests in 121 files in about 324.2s. The
  Gateway package ran 126 tests in 57 files in about 170.0s. Agent setup logs
  contained 227 config loads and 197 PostgreSQL connections; Gateway setup
  logs contained 118 config loads and 73 PostgreSQL connections.
- [E] `gate-web-e2e` took 1m15s for 18 tests with one worker. Migration drift's
  check itself took about 4-5s; job provisioning and its serial dependency
  accounted for most of its critical-path cost.
- [E] The Windows host reports Node `v24.16.0`, but the
  `los-ci:node22-jj0.39.0` job image reports Node `v22.23.1`. The Podman VM
  reports 15 GiB total memory and 8 GiB swap from inside the VM. The stale
  2-GiB value in `podman machine list` remains metadata, not effective memory.
- [E] Both node34 CI images also report Node `v22.23.1`. Node 24 comparison
  therefore requires a candidate job image; upgrading either host runtime does
  not change the effective CI Node version.

### Ordered Changes

1. Build a Node 24 candidate from the same jj/pnpm image recipe. Keep existing
   runner labels on Node 22 and run the candidate explicitly, so rollback is
   an image selection rather than a host change.

   ```bash
   FORGEJO_CI_NODE_IMAGE=node:24.16.0-bookworm \
   FORGEJO_CI_NODE_MAJOR=24 \
   FORGEJO_CI_IMAGE=los-ci:node24.16.0-jj0.39.0 \
   FORGEJO_CI_TOOLCHAIN_IMAGE=los-ci:node22-jj0.39.0 \
   ./tools/build-forgejo-ci-image.sh
   ```

   The optional toolchain image supplies only the checksum-verified `jj`
   binary and the pinned pnpm Corepack payload. This avoids external downloads
   on the network-constrained runners without reusing application dependencies,
   mutable databases, browser profiles, coverage, secrets, or session data.

2. Compare Node 22 and Node 24 on the same source head. Record cold and warm
   dependency state separately and use three warm runs for the decision.
3. After compatibility passes, pin the selected Node 24 patch in the image and
   verify Node, pnpm, jj, PostgreSQL service DNS, and the full current gate.
4. Split package scripts into DB-free regression, DB integration, and coverage
   paths. Preserve the behavior-specific minimum gates in ADR 0014; full
   repository coverage is not required on every ordinary regression run.
5. Use Node 24 global test setup to provision migrated external DB resources
   once per package run. Namespace mutable state by test run, package, and
   shard; share only schema templates and immutable versioned fixtures.
6. Add persistent cache only for pnpm content, Turbo build/check outputs, and
   no-coverage module compilation. Keep test-result caching disabled for
   stateful DB tests.
7. Introduce a conservative change classifier and shorter preflight dependency.
   Run the complete suite on protected main and a scheduled workflow so a
   classifier omission cannot silently remove coverage.

### Stop Conditions And Initial Targets

- Do not remove `tsx`, raise package or Playwright concurrency, reuse mutable
  database rows, merge coverage across source heads, or reuse browser auth
  profiles as part of this work.
- Stop a phase on a test-count reduction without an explained consolidation,
  a new unchanged-head flake, schema leakage, PostgreSQL connection growth, or
  a material memory regression.
- The first structural target is to reduce Agent/Gateway database setup from
  hundreds of config/connection events to the number of package shards.
- The first duration target is a three-run median below 4m for `gate-test`,
  while retaining all current behavior assertions and critical coverage.
- Complete each item with a focused check before starting the next item. Only
  the final cross-package delivery requires the full gate and exact-head
  canaries.

### Node 22 And Node 24 A/B Result

The Windows Podman runner compared the two pinned job images on exact source
head `5db5df2742c77776e1c0ae5f0483eccaea96cddf`. Each image used its own source
volume and `node_modules`, the same persistent pnpm content store, the same
PostgreSQL 16 service, `LOS_TEST_CONCURRENCY=2`, and a unique
`LOS_TEST_RUN_ID`. Turbo test-result caching remained disabled.

| Runtime | Run 1 | Run 2 | Run 3 | Median |
| --- | ---: | ---: | ---: | ---: |
| Node `22.23.1` | 5m42.467s | 5m32.669s | 5m40.644s | 5m40.644s |
| Node `24.16.0` | 5m40.151s | 5m40.498s | 5m50.016s | 5m40.498s |

- [E] All six runs completed 16 of 16 Turbo tasks with zero cached tasks and
  no failures. Every run retained 832 Agent tests (831 passed, one skipped)
  and 126 passing Gateway tests.
- [E] Every run retained 227 Agent config loads, 197 Agent PostgreSQL
  connections, 118 Gateway config loads, and 73 Gateway PostgreSQL
  connections. The runtime upgrade did not alter the dominant initialization
  pattern.
- [E] Sampled test-container memory remained below about 550 MiB. PostgreSQL
  grew from about 216 MiB after the first run to about 707 MiB during the sixth
  run while the experiment deliberately retained one service across unique
  run namespaces. This is evidence for deterministic namespace cleanup, not
  for increasing test concurrency.
- [E] The Node 24 image passed Node, pnpm `9.0.0`, jj `0.39.0`, install, and
  the full workspace test smoke. Its install emitted Node's `DEP0169`
  deprecation warning from pnpm's use of `url.parse()`; this is a package
  manager compatibility observation, not a test failure.
- [J] The median difference is 0.146 seconds, about 0.04 percent. Node 24 is a
  compatible lifecycle upgrade but not a test-duration optimization. Keep the
  structural priority on separating ordinary regression from coverage,
  reducing repeated config and database setup, and cleaning run-scoped data.
- [J] Do not change the runner label until the Node 24 image is pinned in the
  repository-owned recipe and a full exact-head gate passes. Keep Node 22 as
  the rollback image during that canary.

### Agent Database And Test-Lane Result

- [E] Run-scoped Agent schema provisioning with per-file row truncation passed
  all 832 previously executed tests in 299.10s. The earlier Node comparison
  median was about 340.5s, so schema reuse alone reduced local Agent duration
  by about 12% without reusing mutable rows.
- [E] The explicit shared-process lane contains 69 DB-free files. The isolated
  PostgreSQL lane contains 52 files and passed 275 tests. The classifier checks
  all discovered `*.test.ts` files and fails on missing, stale, or duplicate
  classifications.
- [E] The combined ordinary Agent command passed all 853 tests in 135.76s with
  package concurrency still fixed at one. This is about 54% faster than the
  299.10s isolated coverage-shaped run.
- [E] Recursive discovery also restored three deep tests that the prior shell
  glob did not pass to Node: provider repair healing, provider repair storm,
  and the external MCP client test.
- [E] The separate coverage command passed 853 tests in 301.44s and reported
  86.62% line, 75.82% branch, and 81.53% function coverage.
- [J] Ordinary Agent regression no longer collects full repository coverage.
  `pnpm --filter @los/agent test:coverage` retains the isolated coverage path,
  and the repository coverage checker prefers `test:coverage` when a package
  defines it. Critical coverage remains a separate required Forgejo step.
- [J] Do not cache stateful DB test results or mutable rows. The next structural
  step is applying the same explicit classification and run-scoped schema
  pattern to the remaining DB packages before changing job order or
  concurrency.

### Gateway Database And Test-Lane Result

- [E] The explicit Gateway shared-process lane contains 18 DB-free files and
  passed 57 tests in 3.24s. The isolated PostgreSQL lane contains 39 files and
  passed 97 tests in 104.15s.
- [E] The combined ordinary Gateway command passed all 154 tests in 108.07s.
  The previous complete package run took about 170.0s, so the ordinary path is
  about 36% faster without increasing package or test concurrency.
- [E] The separate Gateway coverage command passed all 154 tests in 166.87s
  and reported 70.52% line, 62.62% branch, and 61.23% function coverage. The
  ordinary command therefore avoids about 59 seconds of instrumentation while
  preserving the full isolated coverage path for repository baselines.
- [E] Recursive discovery executes all 57 Gateway test files and restored seven
  deep route tests that the prior shell glob did not pass to Node, including
  provider CRUD, WebSocket, MCP, and skill route coverage.
- [E] The restored provider CRUD test exposed a teardown-order deadlock: the
  imported package setup attempted to close the PostgreSQL pool before the
  file-owned Fastify instance released its SSE listener client. Prepared-schema
  child processes now leave pool shutdown to process exit and global schema
  teardown; the test file owns only its Fastify lifecycle. The focused file
  passes 13 tests in 3.59s after the ownership correction.
- [I] One pre-existing memory-store initialization warning remains visible:
  concurrent `ensure` calls can race on PostgreSQL type creation inside a test.
  It did not fail the 154-test run, but it should not be presented as resolved
  by schema reuse.
- [J] The 39 isolated files still pay Node process startup, TypeScript loading,
  config discovery, and row truncation costs. Further improvement should first
  move demonstrably DB-free files into the explicit shared lane or replace
  expensive dependencies with focused fakes; it should not reuse mutable rows
  or raise concurrency.

### 2026-07-25 Gateway Isolated-Lane Audit, Batch 1

- [E] `managed-workspace-routes.test.ts` and
  `routes/providers/provider-crud-routes.test.ts` now run in the shared lane.
  The former loads configuration explicitly before testing authentication and
  release-confirmation early returns. The latter registers only
  `registerProviderCrudRoutes()` on a file-owned Fastify instance and restores
  a deep copy of the original provider configuration after the test.
- [E] A focused run with `DATABASE_URL` pointed at the deliberately
  unreachable `127.0.0.1:1` endpoint passed all 14 assertions. This verifies
  that neither moved file needs PostgreSQL for the behavior it owns.
- [E] The ordinary Gateway command now classifies 20 files as shared and 37 as
  isolated. It passed 71 shared assertions in 3.53s and 83 isolated assertions
  in 100.83s, retaining all 154 assertions; `/usr/bin/time` reported 105.01s
  elapsed.
- [J] The 3.06s difference from the earlier 108.07s package run is too small
  and too environment-sensitive to claim a material CI speedup. The evidenced
  benefit is two fewer Node processes with repeated configuration and database
  setup; CI impact needs exact-head Windows runner evidence.
- [E] `tool-gate-routes.test.ts` remains isolated because it verifies that a
  second Gateway instance restores tool feedback and fragile-file state from
  persisted session events. MCP and skill route tests also retain PostgreSQL
  where durable capability or version evidence is part of the contract.
- [J] Continue the remaining 37-file audit in bounded batches. Prefer direct
  route registration or focused fakes only when the owned assertion is
  DB-independent; do not fake persistence behavior or move cross-instance
  recovery tests into the shared lane.

### 2026-07-25 Gateway Isolated-Lane Audit, Batch 2

- [E] `execution-experiment-routes.test.ts` now injects file-owned in-memory
  create, load, and approve dependencies into the route registration. The
  production default remains the PostgreSQL-backed agent implementation, and
  the execute route still uses the persisted experiment, run-spec, transition,
  and verification paths.
- [E] The focused route test passed with `DATABASE_URL` pointed at the
  deliberately unreachable `127.0.0.1:1` endpoint. PostgreSQL persistence,
  immutable source evidence, explicit approval, and AP3 completion constraints
  remain covered by `packages/agent/src/execution-experiments.test.ts`.
- [E] The ordinary Gateway command now classifies 21 files as shared and 36 as
  isolated. It passed 72 shared assertions in 3.54s and 82 isolated assertions
  in 97.71s, retaining all 154 assertions; `/usr/bin/time` reported 101.94s
  elapsed.
- [J] The 3.07s difference from the Batch 1 local run is not sufficient to
  claim a stable CI speedup. This batch removes one isolated Node process plus
  its repeated config and database setup; the exact-head Windows CI run remains
  the delivery evidence for end-to-end effect.
- [I] The isolated run again logged a concurrent PostgreSQL type-creation
  warning without failing an assertion. This batch does not change or resolve
  that setup race; run-scoped store provisioning remains a separate follow-up.
- [J] Continue auditing the remaining 36 isolated files in bounded batches.
  Keep tests that own durable state, cross-process recovery, or state-machine
  evidence on PostgreSQL; use focused fakes only for route-level orchestration.

### 2026-07-25 Gateway Isolated-Lane Audit, Batch 3

- [E] `run-evals-pairwise-routes.test.ts` now injects file-owned record and
  list dependencies into the pairwise provider-evidence handlers. Production
  registration still defaults to the PostgreSQL-backed Agent store.
- [E] The focused route test passed with `DATABASE_URL` pointed at the
  deliberately unreachable `127.0.0.1:1` endpoint. The Agent package's
  `run-evals-pairwise.test.ts` retains PostgreSQL coverage for immutable rubric
  evidence, human/judge/deterministic channels, uniqueness, and persisted
  lookup semantics.
- [E] The ordinary Gateway command now classifies 22 files as shared and 35 as
  isolated. It passed 73 shared assertions in 3.44s and 81 isolated assertions
  in 94.35s, retaining all 154 assertions; `/usr/bin/time` reported 98.46s
  elapsed.
- [J] The 3.48s improvement from the Batch 2 local run is a single-machine
  observation, not a stable CI speedup claim. The deterministic gain is one
  fewer isolated Node process and repeated PostgreSQL setup cycle.
- [I] The isolated run again logged the existing concurrent PostgreSQL type
  creation warning without failing an assertion. Batch 3 does not change
  run-scoped store provisioning.
- [J] Continue auditing the remaining 35 isolated files with the same evidence
  boundary: persistence and recovery stay on PostgreSQL; duplicate route
  orchestration may use focused injected dependencies.

### Cocoon Reference Assessment

The comparison used `cocoonstack/cocoon` commit
[`65456b7f35d3b674c0bf35d642e73f44034edb8d`](https://github.com/cocoonstack/cocoon/commit/65456b7f35d3b674c0bf35d642e73f44034edb8d)
on 2026-07-24.

- [E] Cocoon has 100 Go test files. Fifty-six files use `t.TempDir()`, no test
  file calls `t.Parallel()`, and no `TestMain` or in-memory SQLite test store is
  present. `go test ./...` can still run packages concurrently, but stateful
  tests do not opt into test-level parallelism.
- [E] Its SQLite contract tests create a store under a test-owned temporary
  directory and register `t.Cleanup()` to close it. Multi-process tests
  initialize one store for the scenario and let worker processes only open it.
  This supports the LOS boundary of reusing immutable schema structure while
  keeping mutable state scoped to one test run; it does not support sharing
  mutable rows across tests.
- [E] Expensive multi-process correctness gates support `testing.Short()`, and
  constrained CI sets `COCOON_STORM_WORKERS=2` while retaining the full-scale
  storm for offline execution. LOS can adopt the same distinction for stress
  scale: bounded PR evidence plus a separately scheduled full stress gate.
- [E] Cocoon uses recording fake backends for image-pull policy and golden
  differential traces for storage compatibility. LOS should prefer the same
  patterns where a Gateway route only needs to prove orchestration decisions
  or where a store migration must preserve a serialized read model.
- [E] Cocoon's required CI runs `go test -race -count=1 -cover`; `-count=1`
  disables test-result reuse, while dependency caching remains separate. Its
  image workflow uses path-scoped matrices and content caches for immutable
  build inputs. These boundaries support pnpm/Turbo/build cache reuse, not DB,
  coverage, browser-profile, or stateful test-result reuse.
- [J] Cocoon couples race detection and coverage to every ordinary test run.
  That choice is not adopted here: the measured LOS bottleneck is repeated
  instrumentation and database setup, so ordinary regression and repository
  coverage remain separate commands under ADR 0014.

Historical local-only jj changes remain in the repository history. They do not
dirty the current working copy and are not part of this delivery. Review or
abandonment is a separate destructive-history decision and requires explicit
operator scope.

## 2026-07-19 jj Runtime Follow-up

The expanded agent suite includes a managed-workspace test that creates a real
temporary jj repository. Forgejo run `185`, job `667`, exposed the missing
runner dependency as `spawn jj ENOENT`; package concurrency was not the cause.

The `gate-test` job now targets an `ubuntu-jj` runner label. On node34 that
label maps to the host-local `los-ci:node22-jj0.39.0` image built from
`.forgejo/images/node22-jj/Dockerfile`. The image pins the Jujutsu release URL
and SHA-256 checksum, and `gate-test` verifies `jj --version` before running the
workspace suite. Building the image requires access to the upstream release
asset, but normal Forgejo CI execution does not depend on GitHub after the
image is provisioned.

## 2026-07-23 Resource Stop Event

### Observation

PR `#53`, head `93cd3321e1c0140a5de2d4a52e8e3fc85dd59177`, produced UI run
`210` (API run `235`). `gate-fast` failed after 19m47s while TypeScript builds
were still running, without a reported type error. `gate-test` continued for
about 27 minutes; its recorded assertions were passing, but package
build/coverage work had not completed when the run was cancelled. The Web E2E
and drift jobs were cancelled after the required fast job had already failed.

During the overlap on node34, the 3-vCPU host reached load averages of
17.29 / 44.09 / 40.99, available memory fell to 360 MiB, and all 6045 MiB of
swap was in use. The `gate-test` container alone consumed about 225% CPU,
952 MiB of memory, and 170 processes. Eight seconds after cancelling the run,
CI containers had exited and available memory recovered to 1514 MiB, while
about 6035 MiB of swap remained in use. The pnpm store was 357 MiB and the host
filesystem still had 53 GiB free, so dependency storage capacity was not the
bottleneck.

### Judgment

This met the documented resource stop condition. The operator cancelled the
remaining work after `gate-fast` failed because that exact head could no longer
be merged. The regression came from combining `LOS_TEST_CONCURRENCY=4` with a
concurrent `gate-fast` task on a 3-vCPU host, followed by independently
scheduled Chromium work while `gate-test` was still active. Splitting tests
into more simultaneous jobs on the same two-slot runner would multiply
checkout, install, PostgreSQL, and Node process overhead without adding CPU or
memory.

The first corrective configuration restored `LOS_TEST_CONCURRENCY=2`, retained
`TURBO_CONCURRENCY=1` for `gate-fast`, and made Web E2E depend on both
CPU-heavy jobs. While replacement head
`b2357646b0b98bd5923516a07e9c21da5f9fd740` ran fast and test concurrently,
both the Forgejo LAN API and the node34 SSH banner were unresponsive within
their bounded probes. A later SSH attempt took about 35 seconds to return and
reported load averages of 101.76 / 78.68 / 53.28, only 50 MiB available memory,
and all 6045 MiB of swap in use; `docker stats` still did not return promptly.
This confirmed that reducing only the test package limit did not leave enough
host headroom while the two clean jobs still overlapped.

The second correction made `gate-test` depend on `gate-fast`. This eliminated
the clean-job overlap: replacement UI run `212` (API run `237`) completed fast
in 4m27s and then started test at package concurrency two. During test,
available memory declined from 2681 MiB to 1174 MiB, swap grew from 3099 MiB to
3940 MiB, load reached 8.77, and the test container reached 225 processes. The
operator cancelled the run when it crossed the 1.5 GiB stop condition.

The final node34 correction retains that dependency and sets both expensive
stages to one advertised Turbo task. After they pass, Web E2E may overlap only
the short drift job. This preserves the existing test and browser coverage,
fails fast before allocating the test container, and removes duplicate
clean-job builds from the same CPU window. The bounded timeout increases remain
in place so a healthy but slower shared runner is not mistaken for a code
failure.

### Remaining Verification

The replacement exact head must pass `gate-fast`, `gate-test`, `gate-drift`,
and `gate-web-e2e`. During fast and Web E2E, node34 should retain at least 1.5
GiB available memory and keep the Forgejo API responsive. During test and
drift, the Windows Podman VM should avoid swap growth, keep the runner online,
and retain service-container DNS. Do not increase job or package concurrency,
or split the test suite into additional concurrent jobs, until that evidence
is recorded. Moving Web E2E should first provision Chromium in the runner
image instead of reinstalling it per run.

### Windows Runner Candidate

The online `DESKTOP-R45553O` candidate was inspected through its existing
`win-los` SSH identity. It has an AMD Ryzen 7 PRO 8845HS with 8 cores / 16
logical processors, 79.8 GiB of memory with 63.4 GiB free, and a 1.86 TiB
system disk with 858 GiB free. Tailscale reported a direct LAN path through
`192.168.31.5`; SSH and RDP were reachable. Its Realtek 2.5GbE adapter is armed
for wake events.

The host now has a repo-scoped Forgejo runner named `win-los-canary`. Its
rootful Podman 5.7 VM reports an effective 8 vCPU, about 16 GiB of memory, and
8 GiB of swap; the 2-GiB value shown by `podman machine list` is stale metadata
and does not match `podman info` or `free` inside the VM. The runner advertises
only `win-ci` and `win-ci-jj`, both backed by the pinned
`los-ci:node22-jj0.39.0` image. It has capacity two, cache actions disabled, and
an independent persistent pnpm store.

The runner container executes as root because it mounts the rootful
`/run/podman/podman.sock`; this grants container-administration authority inside
the Podman VM. The exposure is bounded to this private repository and the two
repo-scoped labels. Do not register the labels at organization or instance
scope without revisiting that trust decision.

This candidate is materially better suited to heavy CI than node34 and would
also separate Forgejo service availability from test resource consumption.
Forgejo's current runner documentation supports Podman through the runner's
`docker_host` configuration and supports OCI-backed labels:

- <https://forgejo.org/docs/latest/admin/actions/installation/binary/>
- <https://forgejo.org/docs/latest/admin/actions/configuration/>

Adopt it in stages:

1. run Forgejo Runner inside the existing rootful Podman VM with the socket
   authority documented above;
2. provision the pinned CI image, `postgres:16`, and a persistent pnpm store,
   then verify Node 22, jj 0.39.0, PostgreSQL health, service DNS, and TCP;
3. register repo-scoped candidate labels distinct from node34 labels, with
   runner capacity two and test package concurrency initially capped at two;
4. manually start or wake the machine before a canary, and prove that the
   runner and container backend start without an interactive desktop session;
5. require three unchanged-head canaries with all four jobs green, responsive
   Forgejo API, stable memory/swap, and recorded durations before merging the
   required-label change.

Steps 1-3 passed on 2026-07-23. The local service smoke reached PostgreSQL
`healthy` and resolved `postgres-smoke` from the pinned Node job container.
Docker Hub was not reachable from the VM, so the CI and PostgreSQL images were
built or exported from trusted existing hosts and imported over the LAN. npm
was reachable but showed high latency, and a Playwright Chromium range probe
through its redirect completed at only about 534 bytes/second. The initial PR
split therefore sends `gate-test` and `gate-drift` to Windows while retaining
`gate-fast` and Web E2E on node34. Moving Web E2E requires a pre-provisioned
Chromium image rather than a per-run browser download.

The first split canary, UI run `214` (API run `239`), passed `gate-fast` in
4m14s and assigned `gate-test` to `win-los-canary`. The Windows job failed in
27 seconds before dependency installation because `corepack prepare
pnpm@9.0.0` attempted to download the package-manager payload from npm. The
runner also rejected `forgejo-pnpm-store` because its volume allowlist was
empty. The corrected image embeds pnpm 9.0.0, Windows jobs only verify that
version, and the runner configuration explicitly allows the named store.

The next split canary, UI run `216` (API run `241`), passed `gate-fast` in
about 4m03s and `gate-test` in about 7m25s. The Windows test container reused
all 385 packages from its persistent pnpm store with no package downloads; it
used about 655-900 MiB, reached about 150 processes, retained about 14.3 GiB
available memory, and did not use swap. During the same stage, node34 retained
about 3.9 GiB available memory with load near 0.36, and the Forgejo API, DB,
and cache stayed responsive. This verifies that the Windows runner is a better
fit for the workspace test workload and that separating tests removes the
Forgejo co-host resource contention.

`gate-drift` in that run failed before connecting to PostgreSQL. The root-level
`tools/check-migration-drift.ts` entry was classified as CommonJS by `tsx`, so
the transitive `@los/agent` import attempted to `require()` the ESM-only
`@earendil-works/pi-agent-core` export. Renaming the entry to `.mts` makes its
ESM format explicit without changing module semantics for every root tool. A
no-database smoke then loaded the full dependency path and reached the expected
`SERVER_URL (or DATABASE_URL) env required` guard instead of the package export
error. A clean Windows drift job remains the required dual-database proof.

UI run `217` (API run `242`) then passed `gate-fast`, `gate-test`, and the real
dual-database `gate-drift`. Web E2E reused all pnpm packages but timed out at 10
minutes after 15 of 18 browser cases passed. Its log showed the main delay was
not Chromium itself: `playwright install --with-deps chromium` spent 7m13s
downloading 76.8 MiB of Debian browser dependencies into the clean container;
the browser downloads took about 80 seconds and the first 15 tests about 46
seconds. The immediate correction raises the Web E2E limit to 15 minutes and
starts it after `gate-fast`, in parallel with the isolated Windows test path.
A preloaded Playwright image was implemented as a derivative of the existing
node22/jj/pnpm image. `tools/build-forgejo-playwright-image.sh` builds it and
runs Node, pnpm, jj, browser-presence, and headless Chromium version smokes
before the `ubuntu-playwright` runner label is used.

### 2026-07-24 Playwright Image Provisioning

- [E] node34 built
  `los-ci:node22-jj0.39.0-playwright1.61.1` as image
  `sha256:1619965ee8252f6bbd97629a96379657aad3293a4dffbae776868868778c3b51`;
  Docker reports 2,154,892,565 bytes.
- [E] The image smoke reported Node `v22.23.1`, pnpm `9.0.0`, jj
  `0.39.0`, and `Google Chrome for Testing 149.0.7827.55`.
- [E] Playwright `1.61.1` launched that preloaded Chromium against
  `about:blank` and wrote a non-empty 4,254-byte screenshot.
- [E] node34 runner configuration was backed up to
  `/home/z/forgejo/runner-data/config.yaml.bak-20260724-playwright`. It then
  declared labels `[ubuntu-latest ubuntu-jj ubuntu-playwright docker]` with
  zero tasks running during the restart.
- [E] The Windows burst runner remained declared with labels
  `[win-ci win-ci-jj]`; its Podman VM reported 15 GiB total memory, about
  14 GiB available, 8 GiB swap, and no swap in use.
- [E] PR `#54` UI run `222` (API run `247`) executed exact head
  `377fdaa0ed3ea8f2f2acb64dd6a92a7d2dca6ff6` and completed in 11m26s. All
  four contexts passed: `gate-fast` in 4m27s, `gate-web-e2e` in 1m17s,
  `gate-test` in 6m20s, and `gate-drift` in 34s. This verifies the
  `ubuntu-playwright` label and removes the earlier end-to-end `[U]` gap.
- [E] During that run, sampled node34 available memory briefly fell to about
  1.42 GiB, below the 1.5 GiB stop condition, then recovered through roughly
  1.77-2.56 GiB. The non-CI `nmem-server` process used about 2.0-2.66 GiB
  during the samples.
- [E] A post-run audit classified PID `2357055` as the active, enabled
  `nmem.service` systemd unit (`nowledge-mem`), not an orphan process. The
  audit later reported about 2.5 GiB available memory, 5.75 of 5.90 GiB swap
  used, and zero 10-second PSI memory pressure. Because no pre-run swap sample
  exists for this head, the CI-attributable swap delta remains `[U]`.
- [E] `CI-OBS-01` is paused at the documented resource threshold. Do not kill
  `nmem-server` directly; resolve `CI-HOST-01` through an operator-owned
  service scheduling, memory-limit, or host-separation decision before using
  this run as a merge-readiness canary.

Because the machine is powered on only when needed, it is not unattended
always-available capacity. The required `win-ci*` jobs remain queued while its
exclusive labels are offline. The initial operating contract is therefore to
start the Windows host, Podman machine, and runner before opening or updating a
delivery PR; node34 continues to handle fast and Web E2E but is not a fallback
for the Windows labels. Wake-on-LAN and boot-time startup can be evaluated
after the manual canary, but they are not part of this change.

### 2026-07-24 10-GiB Host And Restart Validation

#### Observation

- [E] node34 recognized 9,945 MiB total memory and 6,045 MiB swap after the
  operator expanded the VM to 10 GiB.
- [E] Forgejo port `3022` was initially unavailable because
  `/etc/systemd/system/iptables-restore.service` restored a Docker DNAT rule
  for stale container address `172.26.0.2`. The current Forgejo address had
  changed, so the persisted rule bypassed Docker's generated destination.
- [E] The host backup set is
  `/root/iptables-before-forgejo-3022-fix-20260724.save`,
  `/etc/iptables/rules.v4.bak-20260724-forgejo-dynamic-rules`, and
  `/etc/systemd/system/iptables-restore.service.bak-20260724-forgejo-dynamic-rules`.
  The stale restore unit is disabled. `/usr/local/sbin/los-docker-firewall`
  now owns the `LOS-CONTAINER-FW` policy through
  `/etc/systemd/system/docker.service.d/los-docker-firewall.conf`; Docker
  continues to own dynamic container DNAT.
- [E] A real `systemctl restart docker` changed Forgejo to `172.26.0.3` and
  regenerated `3022 -> 172.26.0.3:3000` without restoring the stale `.2`
  destination. The Forgejo API returned HTTP `200` through `127.0.0.1:3022`,
  `192.168.31.34:3022`, and `100.68.106.96:3022`; the runner re-declared
  `[ubuntu-latest ubuntu-jj ubuntu-playwright docker]`.
- [E] Workflow-dispatch runs `252`, `253`, and `254` all executed exact head
  `5db5df2742c77776e1c0ae5f0483eccaea96cddf`. Each passed `gate-fast`,
  `gate-test`, `gate-web-e2e`, and `gate-drift`; total durations were 10m56s,
  10m56s, and 10m32s. Forgejo API probes remained HTTP `200`.
- [E] Run `252` sampled a minimum 4.80 GiB available memory with 524 KiB swap
  used. Run `254` sampled a minimum 3.73 GiB available memory with the same
  swap value. Run `253` had about 4.8 GiB available both before and after the
  run, no swap delta, and no OOM or Docker error, but its high-load SSH samples
  were not captured; it is a functional canary, not the third quantitative
  resource canary.
- [E] Replacement run `255` also passed all four jobs on the same exact head in
  11m30s. All SSH samples and API probes succeeded, and available memory stayed
  above the 1.5-GiB threshold with a sampled minimum of 2.65 GiB. Swap used,
  however, grew from 524 KiB to 483,844 KiB, a roughly 472-MiB peak delta that
  remained unchanged more than five minutes after completion.
- [E] During run `255`, `nmem-server` used about 4.85 GB RSS, 47.6% of host
  memory, while the Web E2E container used about 1.18 GiB. Effective
  `vm.swappiness` was `60`; memory PSI remained low and no OOM, runner, Docker,
  or Forgejo failure was recorded. After CI exited, `nmem-server` later reached
  about 5.48 GiB RSS while the swap delta remained present.

#### Judgment And Next Action

The Docker/Forgejo restart and firewall persistence fix pass. The 10-GiB host
expansion also removes the earlier available-memory failure: every observed
sample stayed above 1.5 GiB and Forgejo remained responsive. It does not close
`CI-HOST-01`, because the replacement resource canary produced a material swap
delta and `nmem.service` expanded to use more of the added memory.

Do not merge PR `#54` or resume `CI-OBS-01` from the green workflow results
alone. The next operator decision remains one of:

1. add a measured systemd `MemoryHigh` and `MemoryMax` boundary for
   `nmem.service`, with an independent nmem health and data-integrity check;
2. stop and restart `nmem.service` through systemd around the CI window, with
   explicit readiness checks before and after;
3. move either nmem or Forgejo CI to a separate host.

Changing only `vm.swappiness` is not sufficient evidence of restored capacity:
it can reduce swapping while leaving the same memory contention. After the
operator chooses one option, rerun three exact-head canaries with uninterrupted
memory and swap sampling, including the five-minute post-run swap value.

## 2026-07-25 Windows-Only CI Migration

### Decision

The operator selected host separation and explicitly excluded further nmem
limits, imports, restarts, or tuning from this work. node34 remains the Forgejo
archive host; the Windows Podman VM becomes the only LOS Forgejo Actions host.
This removes CI resource acceptance from the nmem working-set decision instead
of attempting to make both workloads fit the same memory envelope.

The migration preserves the four job names and their dependency graph:

```text
gate-fast (win-ci-jj)
├─ gate-test (win-ci-jj) ── gate-drift (win-ci)
└─ gate-web-e2e (win-ci-playwright)
```

Keeping the names stable avoids changing branch protection in the same rollout.
`push: main` is removed because the exact PR head already runs the complete
workflow. The dependency audit becomes manual-only so an offline Windows host
does not accumulate scheduled work. The PostgreSQL isolation canary also uses
`win-ci`, making its overlap result representative of the target runner.

### Provisioning Evidence

- [E] The Windows Podman VM reports 8 vCPU, 15 GiB effective memory, 8 GiB
  swap, and no current swap use.
- [E] The runner volume contains a backup at
  `/data/.runner.bak-20260725-windows-only-ci`.
- [E] The runner advertises `win-ci`, `win-ci-jj`, and
  `win-ci-playwright`; the new label maps to
  `los-ci:node22-jj0.39.0-playwright1.61.1`.
- [E] The Windows image store contains the pinned Node 24 CI image, the
  Playwright image, and PostgreSQL 16.
- [E] No action job container was running when the label file was changed and
  `forgejo-runner-win-canary` was restarted.

### Acceptance And Rollback

Run three manual exact-head workflows after the repository change is pushed.
Each run must pass `gate-fast`, `gate-test`, `gate-web-e2e`, and `gate-drift`,
remain on the same PR head, keep the runner online, and avoid Podman VM swap
growth or service-container DNS failures. Record run IDs and durations below
before stopping node34's LOS runner.

| Canary | Head | Run | Total | Fast | Test | Web E2E | Drift | Result |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| `1` | `da5fc6f10fd7` | `259` | 7m22s | passed | passed | passed | passed | green |
| `2` | `da5fc6f10fd7` | `260` | 7m32s | passed | passed | passed | passed | green |
| `3` | `da5fc6f10fd7` | `261` | 7m54s | passed | passed | passed | passed | green |

All three runs finished with Windows VM swap at zero. Sampled available memory
remained above about 13.5 GiB during the overlapping test and browser stages.
After run `261`, node34's `forgejo-runner` container was stopped and its restart
policy changed from `unless-stopped` to `no`. Forgejo `16.0.1`, repository ref
reads, and the separately owned `forgejo-runner-cantool` remained available.
The documentation update creates a new final head, so the same three-run rule
must be repeated on that head before merge; the earlier runs remain provisioning
evidence rather than final merge evidence.

Rollback keeps the node34 runner available until all three canaries pass. If a
Windows-only failure is caused by runner availability, image selection, Podman
networking, or resource pressure, restore the previous workflow labels and the
runner registration backup. Do not change nmem as a CI rollback action.

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
./tools/observe-pnpm-store.sh --json \
  --store /home/z/forgejo/runner-data/job-cache/pnpm-store
```

The initial persistent-store baseline is about 225 MiB. Size growth alone does
not authorize deletion; record the trend and filesystem pressure before choosing
a cleanup policy. The observer never prunes or deletes store content.

Before removing `gate-drift`'s `needs: gate-test` dependency, manually dispatch
`.forgejo/workflows/postgres-isolation-canary.yml` on a capacity-2 runner and
verify that both jobs overlap and report their distinct database/user identity.

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
| `1` | `26` | `2d00cc3262a02be175b25f7be053bfa8f3ada36b` | `140` | unknown | 13m15s | 7m47s | 12m21s | 49s | unknown | unknown | unknown | 225 | green | no rerun; runtime memory/swap telemetry not captured |
| `2` | `27` | `1061be7f6a169726b6a9a11568b29a21898cf7ac` | `142` | 2s | 12m23s | 7m30s | 12m23s | skipped | unknown | unknown | unknown | 225 | failed | code/test failure: timing-sensitive 40ms scheduler concurrency assertion; stabilized in PR `28`; no unchanged-head rerun |
| `3` | `28` | `a864f9d654fc44e9de79af683cc48ac25589504a` | `143` | 1s | 13m29s | 8m11s | 12m33s | 53s | unknown | unknown | unknown | 225 | green | no rerun; runtime memory/swap telemetry not captured |
| `4` | `53` | `93cd3321e1c0140a5de2d4a52e8e3fc85dd59177` | `210` | 2s | 27m03s | 19m47s | ~27m | cancelled | 360 | unknown | unknown | 357 | failed | resource failure: concurrency 4 plus independent Web E2E exhausted CPU, memory, and swap; operator cancelled after required fast failure |
| `5` | `54` | `377fdaa0ed3ea8f2f2acb64dd6a92a7d2dca6ff6` | `222` | 1s | 11m26s | 4m27s | 6m20s | 34s | ~1454 | unknown | unknown | unknown | green | Web E2E passed in 1m17s from the prebuilt image; resource stop condition triggered by the available-memory sample, with `nmem.service` using 2.0-2.66 GiB |

### Rolling Summary

Update this after samples 10 and 20.

| Eligible PRs | Queue P95 | Total P95 | Minimum available memory | Maximum swap peak delta | Maximum swap +5m delta | Flake rate | Judgment |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| `5 / 20` | pending | pending | 360 MiB | unknown | unknown | 0 / 5 eligible attempts | three green; one fixed timing-sensitive test failure; one superseded-envelope resource failure; observation paused after the new split still crossed the 1.5 GiB available-memory stop condition |

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
