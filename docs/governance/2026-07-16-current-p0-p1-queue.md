# Current P0/P1 Queue (2026-07-19)

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

### 2026-07-19 post-merge ledger calibration

The live PostgreSQL ledger now contains 179 rows, of which 82 are non-terminal:
36 `backlog`, 45 `ready`, and 1 `in_progress`. Filtering those rows to active
P0/P1 work returns 17 items: one active P0 phase and sixteen P1 tasks. [E]

The active P1 set includes the three previously admitted ready seed tasks
(`todo-los-p1-otel-docs`, `todo-los-p1-test-coverage`, and
`todo-los-p1-turbo-cache`) plus two ready file-size findings and one backlog
governance reflection finding that are DB-owned runtime work:

| Todo | State | Ownership note |
| --- | --- | --- |
| `todo-120765c8-8926-485b-a9cf-e32e78bc55aa` | `ready` | Extract a submodule from `packages/gateway/src/chat-service.ts` |
| `todo-47bf8a56-ea57-4028-b58a-6804495fc58d` | `ready` | Extract a submodule from `packages/infra/src/config.ts` |
| `todo-8864a76d-84ea-46f2-9f83-43573972f11f` | `backlog` | Governance reflection metadata is missing for one blocked/failed task |

These three rows are not present in the built-in planning seed and must not be
deleted or overwritten by seed reconciliation. Their status and ownership stay
in the PostgreSQL ledger until the owning task records completion evidence. [E]

The historical `todo-los-context-engineering-phase` row remains
`in_progress` but is archived (`archivedAt=2026-06-23`); it is therefore not
part of the active P0 count. This is a preserved historical row, not a newly
dispatchable P0 task. [E]

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
| 2 | `todo-los-context-engineering-phase` | `archived / in_progress` | Historical phase row retained for audit continuity | Excluded from active P0 dispatch because it is archived; remaining compaction work is represented by the current P1 items |

## P1 Wave 1: Recovery Evidence

| Order | Todo | State | Priority reason | Completion evidence |
| --- | --- | --- | --- | --- |
| 2 | `todo-los-multi-gateway-entry` | `done` | The P1 replay claim cannot be verified in one process | Drain/promote smoke plus repeatable active-session failover harness: stale gateway fencing, run claim, and replay evidence |
| 3 | `todo-los-run-spec-stream-replay` | `done` | The read model exists, but cross-process interruption recovery is unverified | Operation smoke fixes run id, cursor, `Last-Event-ID`, and idempotency replay behavior; active-session regression test covers the interrupted path |

## P1 Wave 2: Controlled Experiments

| Order | Todo | State | Priority reason | Completion evidence |
| --- | --- | --- | --- | --- |
| 4 | `todo-los-execution-experiment-contract` | `backlog` | Adds new provenance and lifecycle semantics, so it must follow the P0 projection and remain contract-first | ADR, contract, generated types, migration, store, API, and AP2/AP3 harness |
| 5 | `todo-los-execution-pairwise-rubric-eval` | `done` | A candidate cannot be judged against a baseline without immutable experiment provenance | Baseline/candidate pair, rubric revision snapshot, separate human/judge/deterministic sources, filtered API, dedicated Pairwise UI, and operator-gated Web e2e |

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

The active P0 container remains open for Execution Lab child work. Select the next
P1 only after reconciling dependency readiness; the current highest-value path is
recovery evidence, followed by the execution experiment contract. The three ready
seed tasks remain bounded operator-contract candidates rather than unattended
dispatch work.

Live dispatch gates currently admit five ready P1 tasks: OTel documentation,
coverage baseline, Turbo cache documentation, and the two file-size findings.
None has a persisted run contract, and the default todo dispatch tool mode is
read-only, so they are candidates for a new bounded operator contract rather
than unattended execution. The separate reflection finding remains backlog. [E]

Completed implementation used this gate sequence:

1. Reload specs for the exact agent/gateway/web files.
2. Read AP1, AP2, AP3, AP5, AP7, and AP10 plus ADRs 0002, 0014, 0015, and 0025.
3. Reconcile `session-trace.ts`, `run-evals.ts`, contracts, and existing route/UI read models.
4. Define the read-only projection type and golden fixtures before adding a route or UI consumer.
5. Run focused tests after each meaningful edit and the full gate before delivery.

## Remaining Verification

After this calibration change:

1. Keep seed reconciliation status-only and scoped by `tenantId/projectId`.
2. Do not update or archive the three DB-owned rows without owner evidence.
3. Re-query the DB after each bounded task and record the resulting status here.
4. Preserve any DB-only todo that has independent runtime ownership; do not
   delete or overwrite it merely because it is absent from the built-in seed.
