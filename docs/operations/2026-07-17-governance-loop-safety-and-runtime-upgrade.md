# Governance Loop Safety And Runtime Upgrade

Date: 2026-07-17

## Scope

This operation changed two governance jobs from unsafe ownership assumptions
to bounded behavior, reconciled todo state after earlier sweeps, verified the
new execution persistence migrations, and upgraded all three active executor
nodes to one runtime build.

No bookmark, commit, push, PR, merge, or remote branch deletion was performed.

## Observed Problems

1. `branch_cleanup` could check out a branch, push a mirror, and delete remote
   branches from an automatic governance loop. [E]
2. `consistency_audit` treated every DB-only todo as seed drift and could
   archive todos owned by runtime governance, operators, or external ingestion.
   [E]
3. Six planning seed todos were absent from the active reconciliation view
   because a previous sweep had archived their existing DB rows. Calling
   `seedLosPlanningTodos({ overwrite: false })` alone returned the archived rows
   and restored none of them. [E]
4. Two draft procedural candidates described the failed reconciliation as a
   durable auto-fix lesson even though the failure was caused by the unsafe old
   behavior. [E]
5. The local gateway and executor had been restarted before the final source
   fix, while `node34-executor-1` and `oracle-executor` still ran build
   `0.1.0+bd17c4594f759`. [E]

## Code And Policy Changes

### Branch governance

`branch_cleanup` is report-only. It may fetch and classify refs, but it no
longer checks out a branch, pushes a mirror, or deletes a remote branch. The
seed has no `autoFix` configuration. Approved origin deletion remains an
explicit operator action through:

```bash
tools/branch-prune-origin.sh --apply
```

The old job `govjob-bf520cc1-73d8-442d-b25c-24bcc5355214` remains paused with
its historical auto-fix configuration. The replacement active job
`govjob-70d2ba75-be47-48cf-ac03-fdec1e64528e` has
`auto_fix_config_json=NULL`. [E]

### Todo reconciliation

`consistency_audit` now owns only these mutations:

1. restore archived seed todos;
2. create genuinely missing seed todos in seed dependency order;
3. align seed-owned status drift;
4. preserve DB-only todos without mutation.

`checkHasFindings()` ignores DB-only-only reports. Static imports replace the
dynamic imports that could initialize a second DB pool during the audit. A
failed seed restoration now returns `applied=false` instead of recording a
false successful fix. [E]

The old job `govjob-a64f112c-cf6f-4949-bf27-01557f61e31e` remains paused. The
replacement active job `govjob-f83e4335-7a24-4d57-bdcc-829477f0acc8` has the
stop condition `0 seedOnly and 0 statusDrift; DB-only todos are preserved`.
[E]

### Dead-letter governance

The hourly `dead_letter` job now declares its requeue behavior through
`autoFix`. `runJobAudit()` always returns a report-only candidate snapshot;
`applyDeadLetterFix()` owns the explicit requeue step; the GA loop then audits
again and requires no remaining requeue-eligible lease-expired event. Existing
`requeueDeadLetterEvent()` state transitions, fencing, scheduler, AP3 gate, task
metadata, session events, and outbox evidence remain the execution path. [E]

The active job `govjob-0af39778-0b4b-46fe-9c22-11d5d7bfdf0d` was backfilled
with `autoFixEnabled=true`, one attempt, and the stop condition `no
unacknowledged lease-expired dead-letter event remains requeue-eligible`. Its
circuit is closed and its next scheduled run is `2026-07-17T02:00:23Z`. [E]

The first post-change scheduled cycle was claimed by the gateway fallback wake
at `2026-07-17T02:03:03Z`. The audit remained report-only (`dryRun=true`),
reported zero candidate ids and zero requeue-eligible rows, created no task run
or todo, and left the circuit closed. The dead-letter totals remained 25 total,
15 unacknowledged, 10 acknowledged, and 2 requeued. [E]

That cycle exposed one evidence bug: the persisted job `resultSummary` omitted
the `_gaLoop` classification even though the in-memory sweep result added it.
`runGaLoop()` had persisted the raw audit summary before the wake/manual sweep
decorated its return value. The source now uses one `buildGaLoopSummary()` path
for the runner, wake loop, and manual sweeper, and persists the classified
summary for clean and fix/verify outcomes. A DB regression verifies that the
stored classification matches the actual `GaLoopResult`. [E]

The running gateway was not restarted after this source fix, and remote SSH
was unavailable, so the next live scheduled cycle will still use the previous
process image until a separate delivery/rollout. [U]

At closeout, `pnpm run status` computed workspace source version
`0.1.0+b5d7b13881ed3`, while the persisted gateway service and all three executor
heartbeats still reported effective runtime version `0.1.0+b7752f3489a97`.
This is the expected source/runtime split for an un-deployed fix; do not report
the new source hash as the running build. [E]

## Persisted State Reconciliation

Before the final reconciliation:

| Surface | Value |
| --- | ---: |
| active DB todos | 158 |
| seed-only | 6 |
| DB-only | 41 |
| status drift | 0 |

After restoring the six archived seed rows:

| Surface | Value |
| --- | ---: |
| active DB todos | 164 |
| seed-only | 0 |
| DB-only | 41 |
| status drift | 0 |

The 41 DB-only todos were not archived or rewritten. The two draft candidates
`pc-ga-auto-auto-fix-escalation-consistency_audit` and
`pc-ga-auto-repeated-fix-failure-consistency_audit` were moved to `retired` so
their audit trail remains available without treating them as reviewable
learning candidates. [E]

## Execution Persistence

The current PostgreSQL `schema_migrations` table records these migrations as
applied at `2026-07-16T23:30:29Z`: [E]

| Sequence | Migration |
| --- | --- |
| 033 | `033_dead_letter_requeue.sql` |
| 034 | `034_dual_lease_fencing.sql` |
| 035 | `035_execution_outbox_delivery.sql` |

Post-migration verification: [E]

- `task_runs.lease_version` exists;
- `agent_tasks.lease_version` exists;
- execution outbox pending count is 0;
- execution outbox claimed count is 0;
- legacy rows are 2,658 through outbox id 2,817.

## Runtime Rollout

The default Tailscale SSH preflight failed because the current local Tailscale
peer list did not expose `oracle` or `node34`. Existing OpenSSH aliases were
then verified with `BatchMode=yes` and used without changing credentials. [E]

Both remote installs used `--low-resource`: [E]

- Oracle: 954 MiB RAM, 2 GiB swap, constrained executor;
- node34: 5.8 GiB RAM, about 1.0 GiB available, 4.6 GiB swap already used.

Oracle's first deploy verifier observed the service while it was still
`deactivating`; the old process took about 70 seconds to stop. Independent
systemd, journal, health, and registry checks then passed, followed by a second
successful deploy verification. This was a verifier timing false negative, not
a failed final runtime. [E]

Final active executor evidence: [E]

| Node | Version | Runtime | Registry | Active tasks |
| --- | --- | --- | --- | ---: |
| `mbp-executor-1` | `0.1.0+b7752f3489a97` | local managed process healthy | online, fresh heartbeat | 0 |
| `node34-executor-1` | `0.1.0+b7752f3489a97` | systemd active, `NRestarts=0` | online, fresh heartbeat | 0 |
| `oracle-executor` | `0.1.0+b7752f3489a97` | systemd active, `NRestarts=0` | online, fresh heartbeat | 0 |

The local gateway service is online and reports the same build. Its health
projection reports outbox pending 0 and claimed 0. [E]

At `2026-07-17T01:37:49Z`, PostgreSQL executor-node evidence still showed all
three nodes `online`, `candidate=true`, with no blockers, zero active tasks,
zero queue depth, the same build, and heartbeat ages below eight seconds. The
reported resource snapshot was 1,729 MiB available and 5,352 MiB swap used on
node34, 416 MiB available and 353 MiB swap used on Oracle, and 19,005 MiB
available on the MBP. [E]

Fresh OpenSSH checks to the `node34` and `oracle` aliases were closed by the
remote endpoints before a command ran. The persisted heartbeats prove executor
activity, but this recheck did not independently verify current systemd state
or `NRestarts`; retain the earlier rollout evidence and mark the fresh
process-manager surface unverified. [U]

## Architecture Progress

ADR 0012 defines service, execution, and run-orchestration planes. Current
progress after this operation is:

| Plane | Current evidence | Judgment |
| --- | --- | --- |
| Service plane | gateway service registry, `/live`, `/ready`, `/health`, heartbeat and persisted service identity work locally | partially implemented; production load-balancer routing and live `/chat` failover remain unverified [I] |
| Execution plane | three active executors share one immutable build; capability registry, health, task load and lease fencing are present | current node rollout and fencing baseline verified [E] |
| Run orchestration plane | durable run state, dual lease fencing, execution outbox, dead-letter requeue and governance jobs are persisted | persistence safety advanced; request-independent stream replay and full failover validation remain roadmap work [I] |

The next architecture change should not add more autonomous mutation to
governance jobs. New loops should first define ownership, report/fix boundaries,
persisted evidence, and a focused regression harness. [I]

## Live Queue Calibration

At `2026-07-17T01:24Z`, the active PostgreSQL ledger contained 164 todos. The
non-terminal P0/P1 view contained 13 rows: one P0 phase container, three ready
P1 seed tasks, and nine backlog P1 seed tasks. There were no non-terminal P0/P1
DB-only todos or GA findings. The 41 preserved DB-only rows were all ready P2
`governance-file-size` findings. [E]

The P0 row is `todo-los-execution-lab`, which is a non-dispatchable phase
container. The immediately gate-eligible P1 rows are `todo-los-p1-otel-docs`,
`todo-los-p1-test-coverage`, and `todo-los-p1-turbo-cache`; all are tasks with
completed dependencies. None has a persisted run contract, and todo dispatch
defaults to read-only tool mode, so no unattended dispatch was started. [E]

The recovery priority has a persisted/configured mismatch:
`todo-los-multi-gateway-entry` is P1 in the current seed and architecture queue,
but the live DB row still has its older P2 priority and title. The status is
`backlog` on both surfaces, so the current status-only consistency audit reports
zero status drift and does not expose this mismatch. `todo-los-run-spec-stream-replay`
remains blocked on this row plus the already-done transport recovery todo. [E]

The next architecture sequence remains recovery evidence first, then the
execution experiment contract. Before changing the live priority or expanding
consistency auto-fix, define whether seed priority/title/dependencies are
canonical or operator-overridable. First use of the experiment execution mode
still requires explicit operator consent. [I]

## Dead-Letter Triage

The 15 unacknowledged `unrecoverable_error` rows divide into these historical
groups: [E]

| Group | Count | Evidence | Owner / next check |
| --- | ---: | --- | --- |
| xAI transport burst | 9 | `fetch failed` between `2026-06-30T07:05Z` and `07:40Z`, all on `grok-composer-2.5-fast` | provider compatibility; require a fresh same-model probe or an explicit retirement decision |
| Provider or credential routing | 4 | provider incorrectly recorded as `los`, model alias recorded as provider `deepseek-v4-flash`, xAI missing configuration, and an expired xAI token | provider/model request validation and credential-resolution harness |
| JSON/tool-call parsing | 2 | malformed JSON errors at positions 46 and 60 | focused malformed-arguments fixture through the provider and tool-runner entrypoints |

Every associated task run is `failed`, while each associated run spec remains
at the legacy `created` state. This is historical AP4/state-reconciliation debt,
not a reason to retry an `unrecoverable_error` automatically. [E]

The latest persisted compatibility evidence in scope is a passing
`verified_advisory` DeepSeek `deepseek-v4-flash` read-context probe and a failed
`advisory` xAI `grok-4.3` probe, both from `2026-07-10`. There is no newer passing
evidence for the xAI model in the nine-row transport burst. Keep all 15 rows
unacknowledged until the owning checks above either reproduce the issue or
justify acknowledgment as historical evidence. [E]

## Post-Sweep Drift Observation

The long-lived gateway fallback tick ran at `01:23:03Z` and `01:33:03Z` with
no due governance job, but `sweepGovernanceDrift()` still re-read jobs that had
run in the previous two hours and logged the same two high-severity
`consistency_audit` findings on each tick. [E]

A direct read-only report showed `jobsChecked=3`, `jobsWithDrift=1`, and these
two metrics for `govjob-f83e4335-7a24-4d57-bdcc-829477f0acc8`: [E]

- `seedOnly`: previous 0, current 6;
- `dbOnly`: previous 0, current 41.

Those values come from the job's stale `23:37Z` pre-reconciliation summary and
an older same-type job, not the current live reconciliation of `seedOnly=0`,
`dbOnly=41`, and `statusDrift=0`. The report also returns `totalFindings=1`
because it currently counts jobs with drift rather than the two findings. No
todo was created and the active todo count remained 164. [E]

This should be a separate bounded governance fix: compare only jobs executed in
the current sweep (or an explicitly refreshed checkpoint), exclude paused or
superseded job baselines, and count findings rather than jobs. Add a no-due-job
fallback regression before changing the long-lived gateway. [I]

## Verification

- branch and loop focused tests: 43 passed, 0 failed. [E]
- dead-letter ownership and loop focused tests: 20 passed, 0 failed. [E]
- DB-backed `governance-sweeper.test.ts`: 10 passed, 0 failed after adding the
  archived-seed regression. [E]
- `pnpm --filter @los/agent check`: passed. [E]
- `pnpm check`: passed with 48 grandfathered structure warnings. [E]
- latest `pnpm gate`: 9 phases, 15 test tasks, 0 failures, 267 seconds. [E]
- state-machine bypass check: clean; wiring topology: 0 new unwired exports;
  static los-ast governance audit: 0 findings. [E]
- codebase-memory MCP was healthy enough to list indexed projects, but `los`
  was not indexed. The analysis stopped after the first project-not-found and
  used local AST/source checks instead. [E]
- a final live-DB dry-run explicitly selected `branch_cleanup` with 0 stale
  candidates, 0 remote branches, 0 findings, and no branch mutation. The
  `consistency_audit` job was not due and did not run. [E]
- the 10-minute fallback wake then ran the scheduled `branch_cleanup` job at
  `00:05:23Z`: 0 stale candidates, 0 remote branches, 0 failures, and next run
  `01:00:23Z`. [E]
- the same wake ran `dead_letter`, requeued two `lease_expired` events, and
  both replacement task runs succeeded on `gateway-local`. The current summary
  is 25 total, 15 unacknowledged `unrecoverable_error`, 2 requeued, and 0
  requeue-eligible; outbox pending and claimed returned to 0. [E]
- the `02:03:03Z` scheduled dead-letter cycle was report-only with zero
  candidates, zero requeue-eligible rows, no new task run, no new todo, and a
  closed circuit; it exposed the missing persisted `_gaLoop` classification.
  [E]
- GA classification focused tests passed 31/31; the agent package check,
  `pnpm check`, and the full gate passed after the persistence fix. [E]
- gate retained 48 grandfathered structure warnings and one broad security-scan
  warning; neither was introduced by this change. [E]

## Remaining Work

| Priority | Work | Evidence / stop condition |
| --- | --- | --- |
| P0 | Observe 10-20 real Forgejo PRs under runner capacity 2 | record queue time, total P95, minimum available memory, swap peak and +5m delta, pnpm store size, and unchanged-head flake rate |
| P1 | Isolate PostgreSQL DNS/network per CI job | prove test and drift jobs cannot resolve or share another job's PostgreSQL service before removing the drift dependency |
| P1 | Add periodic pnpm store capacity checks | record weekly and every fifth eligible PR; do not re-enable unstable `actions/cache` |
| P1 | Observe two clean `consistency_audit` cycles | require `seedOnly=0`, `statusDrift=0`, and DB-only preservation before retiring the paused historical jobs |
| P1 | Define seed-owned todo field drift policy | decide canonical versus operator-overridable title, priority, kind, source, metadata, and dependencies; then reconcile the live multi-gateway P2 row without broad overwrite |
| P1 | Resolve 15 unacknowledged dead letters by owner | run same-model xAI compatibility evidence, add provider/model request validation and malformed-arguments fixtures, then decide acknowledgment; never auto-requeue these `unrecoverable_error` rows |
| P1 | Deliver and observe classified dead-letter GA output | the first safe cycle proved report-only/no-task behavior but exposed missing `_gaLoop`; after rollout, require the persisted classification on a natural zero-eligible cycle |
| P1 | Extend remote deploy verification grace handling | avoid reporting failure while a constrained node is still completing a bounded graceful stop |
| P1 | Make the post-sweep drift helper awaitable in command-line runs | the long-lived gateway path is verified; a `withInitDb()` dry-run can still close the DB before the detached helper completes |
| P1 | Scope post-sweep drift to current work | stop repeated comparison of stale replacement summaries against paused historical jobs; fix finding counts and add a no-due-job fallback regression |
| P1 | Correct the documented infra migration command | `pnpm --filter @los/infra db:migrate` is not currently a package script; document or add the supported `migrateDir()` entrypoint in a separate bounded change |

Keep node34 runner capacity at 2. Its current 3-core/6-GB resource profile and
high swap use do not support a third concurrent runner. [E]
