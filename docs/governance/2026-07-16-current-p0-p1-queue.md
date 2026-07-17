# Current P0/P1 Queue (2026-07-16)

## Purpose

This document records the current P0/P1 work set after reconciling todo seeds,
PostgreSQL rows, implementation, tests, ADR intent, and live runtime evidence.
It is a planning view, not execution-success evidence. `task_runs`,
`session_events`, verification records, Forgejo CI, and live service state remain
the owning truth surfaces for work that has executed.

## Observed State

Before reconciliation:

1. The built-in seed contained 123 todos; PostgreSQL contained 255 rows.
2. The seed had 25 non-terminal P0/P1 items; PostgreSQL had 38 active P0/P1 rows.
3. Eighteen todos were `done` in the seed but still active in PostgreSQL.
4. Four new Execution Lab P0/P1 seeds were not yet present in PostgreSQL.

Implementation review found eleven additional P1 items whose original problem
was already satisfied by current code, focused tests, or a live evidence query:

- HTTP idempotency, DeepSeek behavior parity, Codex/PackyCode behavior parity,
  run/tool state persistence, file-sync settle/concurrency tests, provider CRUD,
  and hotspot/tool drift governance;
- PostgreSQL data scale, 30-day provider evidence, executor topology, and the
  current absence of an external OTel collector configuration.

After seed reconciliation, the active work set is 2 P0 items and 13 P1 items.
The PostgreSQL ledger must be updated after this change merges; until then, the
runtime DB still contains the older statuses.

### 2026-07-17 live ledger calibration

The current live PostgreSQL ledger contains 164 active todos. Filtering the
persisted rows to non-terminal P0/P1 work returns 14 items: one P0 phase
container, three ready P1 seed tasks, and ten backlog P1 seed tasks. No
non-terminal P0/P1 DB-only todo or GA finding is present. [E]

Seed reconciliation now has an explicit field ownership policy:

1. `id` is the seed identity; `tenantId/projectId` select reconciliation scope.
2. `status` remains the only automatically reconciled field.
3. `title/priority` are canonical seed planning fields, but differences are
   report-only and require an explicit operator update.
4. Description, classification, provenance, hierarchy/dependencies, execution
   references, and metadata remain operator/runtime-owned and are not compared
   by seed reconciliation.

`consistency_audit` includes the report-only field count, items, and ownership
policy in its result summary. These differences do not trigger GA auto-fix or
the consistency circuit breaker. [E]

After that policy and its regression tests were in place,
`todo-los-multi-gateway-entry` was explicitly updated through `updateTodo()` to
the current recovery-smoke title and P1 priority. Its status remained `backlog`,
and its title/priority drift is now zero. Three unrelated report-only historical
differences remain for later review: `todo-los-idempotency-keys` priority plus
the titles of `todo-los-p1-otel-docs` and
`todo-los-run-spec-stream-replay`. [E]

## Priority Judgment

P0 is restricted to the Execution Lab phase and its read-only observability
projection. The projection changes no execution state, but every later
experiment, comparison, and optimization claim depends on trustworthy run
fingerprints, waterfall timing, failure facets, and evidence references.

P1 is ordered in four waves:

1. Prove existing recovery behavior through multi-gateway operation smokes.
2. Add the experiment and pairwise-evaluation contracts after the P0 projection.
3. Complete operational observability and controlled CBM measurement.
4. Address context, memory, test, CI, policy, and supply-chain robustness.

This ordering is dependency-based. It does not imply that every earlier item is
larger or more valuable than every later item.

## P0

| Order | Todo | State | Why P0 | Completion evidence |
| --- | --- | --- | --- | --- |
| 0 | `todo-los-execution-lab` | `in_progress` | Phase container for the work below; it is not dispatchable execution work | All child work is terminal or explicitly deferred with evidence |
| 1 | `todo-los-execution-observability-projection` | `done` | Required to compare runs without inventing missing prompt, spec, memory, or tool versions | Pure read-only projection, five golden fixtures, route coverage, full agent/gateway tests, and `pnpm gate` |
| 2 | `todo-los-context-engineering-phase` | `in_progress` | Grok comparison exposed context-fill, eviction, and procedural-gate gaps | Fill monitoring, semantic eviction, and pre-action gate are done; compaction lifecycle remains P1 work |

## P1 Wave 1: Recovery Evidence

| Order | Todo | State | Priority reason | Completion evidence |
| --- | --- | --- | --- | --- |
| 2 | `todo-los-multi-gateway-entry` | `backlog` | The P1 replay claim cannot be verified in one process | Two gateways share PostgreSQL; drain and ready routing work; interrupted chat replays through the second gateway |
| 3 | `todo-los-run-spec-stream-replay` | `backlog` | The read model exists, but cross-process interruption recovery is unverified | Operation smoke fixes run id, cursor, `Last-Event-ID`, and idempotency replay behavior |

## P1 Wave 2: Controlled Experiments

| Order | Todo | State | Priority reason | Completion evidence |
| --- | --- | --- | --- | --- |
| 4 | `todo-los-execution-experiment-contract` | `backlog` | Adds new provenance and lifecycle semantics, so it must follow the P0 projection and remain contract-first | ADR, contract, generated types, migration, store, API, and AP2/AP3 harness |
| 5 | `todo-los-execution-pairwise-rubric-eval` | `backlog` | A candidate cannot be judged against a baseline without immutable experiment provenance | Baseline/candidate pair, rubric revision snapshot, separate human/judge/deterministic sources, and evidence-linked UI/API |

## P1 Wave 3: Operational Observability

| Order | Todo | State | Priority reason | Completion evidence |
| --- | --- | --- | --- | --- |
| 6 | `todo-los-p1-otel-docs` | `ready` | Health endpoints exist, but operator configuration and external-collector boundaries are undocumented | `.env.example` and operations doc cover port, protocol, health, status, collector boundary, and failure checks |
| 7 | `todo-los-p1-perf-metrics` | `backlog` | PostgreSQL telemetry and diagnostics are not a durable metrics export or trend surface | Metrics endpoint, documented labels, task/tool/provider/cache measures, and trend verification |
| 8 | `todo-los-p1-cbm-ab-inject` | `backlog` | Current in-memory alternating assignment is neither stable nor evidence-linked | Persisted deterministic cohort assignment, eligibility gate, and outcome comparison from execution projection |

## P1 Wave 4: Robustness And Governance

| Order | Todo | State | Priority reason | Completion evidence |
| --- | --- | --- | --- | --- |
| 9 | `todo-los-p1-context-reconstruction` | `backlog` | Interrupted sessions still lack a complete checkpoint-to-handoff reconstruction protocol | Golden failed-session reconstruction with source event and observation references |
| 10 | `todo-los-p1-stale-detection` | `backlog` | Compaction candidates lack decay and cross-session aggregation | Deterministic stale score, trigger policy, candidate-only output, and promotion consent boundary |
| 11 | `todo-los-p1-test-coverage` | `ready` | Tests emit coverage, but no owned baseline artifact identifies high-risk blind spots | Repeatable package coverage report and focused additions for the named high-risk modules |
| 12 | `todo-los-p1-supply-chain-full` | `backlog` | Current audit covers install scripts, CVEs, and workspace references only | SBOM, license policy, freshness analysis, persisted audit trend, and focused tests |
| 13 | `todo-los-p1-turbo-cache` | `ready` | CI behavior is observable only from logs and expected cache semantics are undocumented | Documented inputs/outputs, clean and warm-run evidence, and explicit CI cache policy |
| 14 | `todo-los-p1-los-ast-rules` | `backlog` | AP1/AP3/AP5 checks are split across scripts and human workflow; AP5 is not statically enforced | los-ast rules with positive/negative fixtures and a documented repo gate boundary |

## Immediate Action

The P0 projection and context-engineering child tasks are complete. Select the next P1 only after reconciling dependency readiness; current candidates are recovery evidence, compaction lifecycle, and the execution experiment contract.

Live dispatch gates currently admit three ready P1 seed tasks because they are
`kind=task` with completed dependencies: OTel documentation, coverage baseline,
and Turbo cache documentation. None has a persisted run contract, and the
default todo dispatch tool mode is read-only, so they are candidates for a new
bounded operator contract rather than unattended execution. The 41 preserved
DB-only todos are all ready P2 `governance-file-size` findings. [E]

Completed implementation used this gate sequence:

1. Reload specs for the exact agent/gateway/web files.
2. Read AP1, AP2, AP3, AP5, AP7, and AP10 plus ADRs 0002, 0014, 0015, and 0025.
3. Reconcile `session-trace.ts`, `run-evals.ts`, contracts, and existing route/UI read models.
4. Define the read-only projection type and golden fixtures before adding a route or UI consumer.
5. Run focused tests after each meaningful edit and the full gate before delivery.

## Remaining Verification

After this calibration change merges:

1. Seed missing todos without `overwrite=true`.
2. Update PostgreSQL statuses only for ids backed by the evidence recorded here.
3. Re-query the DB and require the active P0/P1 set to match the seed work set.
4. Preserve any DB-only todo that has independent runtime ownership; do not
   delete or overwrite it merely because it is absent from the built-in seed.
