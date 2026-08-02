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
| 6 | `todo-los-p1-otel-docs` | `done` | Health endpoints exist, but operator configuration and external-collector boundaries were undocumented | `.env.example` + `docs/operations/otel-bridge.md`; live health/status verified 2026-07-27 |
| 7 | `todo-los-p1-perf-metrics` | `backlog` | PostgreSQL telemetry and diagnostics are not a durable metrics export or trend surface | Metrics endpoint, documented labels, task/tool/provider/cache measures, and trend verification |
| 8 | `todo-los-p1-cbm-ab-inject` | `backlog` | Current in-memory alternating assignment is neither stable nor evidence-linked | Persisted deterministic cohort assignment, eligibility gate, and outcome comparison from execution projection |

## P1 Wave 4: Robustness And Governance

| Order | Todo | State | Priority reason | Completion evidence |
| --- | --- | --- | --- | --- |
| 9 | `todo-los-p1-context-reconstruction` | `backlog` | Interrupted sessions still lack a complete checkpoint-to-handoff reconstruction protocol | Golden failed-session reconstruction with source event and observation references |
| 10 | `todo-los-p1-stale-detection` | `backlog` | Compaction candidates lack decay and cross-session aggregation | Deterministic stale score, trigger policy, candidate-only output, and promotion consent boundary |
| 11 | `todo-los-p1-test-coverage` | `done` | Versioned package-local baseline now separates static inventory from V8-observed sources | Baseline update/check commands pass; media observes 5/5 implementation files; governance drift direct review reaches 96.37/73.68/83.33 line/branch/function coverage |
| 12 | `todo-los-p1-supply-chain-full` | `backlog` | Current audit covers install scripts, CVEs, and workspace references only | SBOM, license policy, freshness analysis, persisted audit trend, and focused tests |
| 13 | `todo-los-p1-turbo-cache` | `ready` | CI behavior is observable only from logs and expected cache semantics are undocumented | Documented inputs/outputs, clean and warm-run evidence, and explicit CI cache policy |

> 2026-07-31 归档:`todo-los-p1-los-ast-rules` 已完成(AP1 由内部 state-machine-bypass.yml 编码,AP3/AP5 确认不适用静态规则——运行时 gate 覆盖;rule.exclude 豁免、los scan 接入 ci-gate.sh Phase 7、可信度审计规则修复 4 条;见 `docs/governance/static-analysis-reliability.md`)。

## Immediate Action

Wave 0 alignment is complete as of 2026-07-27. Do not treat open P0 phase/plan
containers as missing feature work.

Next operator-contract candidates (not unattended dispatch):

1. `todo-los-execution-pairwise-sample-gate` (`ready`) — Execution Lab main line.
2. Async: continue `todo-los-ci-resource-baseline` to 10/10 unique-head samples.
3. `todo-los-p1-otel-docs` is `done` (2026-07-27).

Do **not** start: Pi K4 canary without consent; turbo/cache policy changes before
baseline maturity; optimization analysis before sample gate; full-repo file-size
refactors. Default todo dispatch tool mode remains read-only. [E]

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

## 2026-07-27 Queue Handling Addendum

The global ledger was re-queried after the CI/CD and Execution Lab P0 review,
then again after Wave 0 alignment. The persisted scope is `tenant=local`,
`project=los`, with 229 todos (132 seed items). Post-Wave-0 status counts are
41 `backlog`, 43 `ready`, 7 `in_progress`, 1 `blocked`, 134 `done`, and 3
`cancelled`. Reconciliation reports no status drift. [E]

CI/CD P0 correctness work is terminal: the single-root test rollout,
`ci-gate` result capture, and GitHub ruleset migration are all `done`, with the
focused CI gate, evidence collector, resource observer, and workflow-policy
checks passing (3/3, 4/4, 6/6, and 2/2). The DB-owned parent
`todo-los-ci-cd-observability-20260725` remains `in_progress` only because its
separate P1 resource baseline has 5/10 unique-head samples; it is a plan
container, not dispatchable P0 execution work. [E]

Execution Lab's P0 observability projection is `done`; the experiment contract
and pairwise rubric tasks are also `done`. Agent coverage passed 282/282 tests,
and Gateway coverage passed 73/73 tests, including the projection, experiment,
pairwise, and seed/reconciliation paths. The parent
`todo-los-execution-lab` remains an `in_progress` phase because the real
pairwise sample gate and later optimization analysis remain open; it is not a
dispatchable P0 task. [E]

The previous report-only priority drift on
`todo-los-execution-optimization-analysis` (DB `P1` vs seed `P2`) was resolved
by explicit operator decision on 2026-07-27: DB priority is now `P2`, with
`dependsOnIds` including the sample gate and `executionPolicy=
blocked_until_real_pairwise_sample_gate_passes`. [E]

### 2026-07-27 Wave 0 alignment (roadmap / outbox / todo)

This pass inventories agent entry surfaces, re-queries the live ledger, and
aligns planning docs with persisted Todo state. It does **not** execute Pi K4
canary work, publish CI P95, or auto-tune cache/runner policy.

#### Agent / skill / rule / MCP inventory

| Surface | Role | Current judgment |
| --- | --- | --- |
| `AGENTS.md` | Hard project rules, AP invariants, commands | Current; no change required for this alignment |
| `Claude.md` | Points at `AGENTS.md` + `SKILL.md` | Current entrypoint only |
| `SKILL.md` | Runtime truth, ADR reconciliation, closeout | Current operational workflows |
| `docs/governance/anti-patterns.md` | AP1–AP10 detail | Canonical constraint surface |
| `docs/governance/agent-doc-manifest.json` | Doc hygiene bounds | Entrypoint/skill/governance list still valid |
| Global `~/.claude/rules/*` | Cross-project execution discipline | Not project truth; do not copy into los |
| MCP: gateway/runtime | Live evidence when gateway is up | Gateway/executor healthy; outbox pending/claimed = 0 [E] |
| MCP: external design/memory tools | Non-los tools | Not ownership for P0 queue decisions |

Planning truth owners for this queue:

1. PostgreSQL todos (`tenant=local`, `project=los`)
2. Built-in seeds (`packages/agent/src/todo-seeds*.ts`) for status reconciliation only
3. This file + dated operations/governance docs for operator-facing sequencing
4. ADRs for design intent; implementation for runtime behavior

#### Live P0: containers vs dispatchable work [E]

Post-otel active counts: P0 = 4; P1 = 11; P2 = 73; P3 = 3
(`backlog+ready+in_progress+blocked`, non-archived). P1 dropped after
roadmap-sync completion, optimization demotion to P2, and otel-docs done.

| Todo | Kind | Status | Dispatchable? | Note |
| --- | --- | --- | --- | --- |
| `todo-los-ci-cd-observability-20260725` | plan | `in_progress` | No | Correctness children done; open for resource baseline 5/10 |
| `todo-los-execution-lab` | phase | `in_progress` | No | Projection/experiment/rubric done; sample gate next |
| `todo-los-daily-agent-product` | phase | `in_progress` | No | `p0AuthorizedScopeComplete=true`; holds roadmap/canary linkage |
| `todo-los-pi-k4-readonly-canary` | task | `backlog` | Only with consent | `authorization=not_granted`, `providerCanaryExecuted=false` |

#### Wave 0 evidence and todo mutations [E]

| Check | Result |
| --- | --- |
| `los governance todo-reconcile --tenant-id local --project-id los` | seed=132, db=229, seedOnly=0, dbOnly=97, statusDrift=0 |
| fieldDrift | none after operator P2 decision (was optimization-analysis priority) |
| Gateway `/health` outbox | pending=0, claimed=0, legacy=2658 through id 2817 |
| ADR 0028 / publisher | Accepted; gateway maintenance polls `publishExecutionOutboxBatch` every 1s |
| Pi K4 selection | `todo-los-pi-k4-readonly-selection` = `done` (Forgejo PR #78 / GitHub #180) |
| Pi K4 canary | still not authorized |

Todo ledger updates applied in this pass:

1. `todo-los-roadmap-outbox-todo-sync` → `in_progress` then `done` with alignment evidence.
2. `todo-los-execution-pairwise-sample-gate` → `ready` (depends on done rubric eval).
3. `todo-los-execution-lab` metadata `statusReview` refreshed with child matrix and next dispatch.
4. `todo-los-daily-agent-product` metadata `statusReview` refreshed; remains
   `in_progress` with `p0AuthorizedScopeComplete=true`.

Operator decision applied:

- **optimization priority** → **P2** (2026-07-27). Seed and DB agree. Task stays
  `backlog` until sample gate passes; output remains advisory-only.

#### Execution Lab / CI dependency design [E]

```text
projection (done) → experiment (done) → pairwise-rubric (done)
                                          ↓
                               pairwise-sample-gate (ready, P1)
                                          ↓
                         optimization-analysis (backlog, P2, advisory)

ci-correctness (done) → resource-baseline (in_progress, 5/10)
                                          ↓
                              turbo-cache (backlog, P1; blocked until 10/10)

otel-docs (done, P1)  ── Wave 1 complete 2026-07-27
pi-k4-canary (backlog, P0) ── consent-gated side track only
```

#### Recommended execution order after Wave 0 [I]

1. **Wave 1 (ops evidence, parallel)**  
   - `todo-los-p1-otel-docs` — **done** 2026-07-27 (`docs/operations/otel-bridge.md` + `.env.example`).  
   - `todo-los-ci-resource-baseline` (`in_progress`, 5/10 unique-head) — async only; no P95 or cache/runner tuning before 10 samples.  
   - `todo-los-p1-turbo-cache` stays blocked on baseline.

2. **Wave 2 (Execution Lab)**  
   - `todo-los-execution-pairwise-sample-gate` first: preregister thresholds/scenarios and immutable baseline/candidate/rubric refs; keep configured vs effective routes separate.  
   - Only then `todo-los-execution-optimization-analysis` (advisory only; no default profile/tool/context auto-tune).

3. **Wave 3 (reliability/governance)**  
   context-reconstruction → stale-detection → CBM A/B (after ~20 shadow sessions) → perf-metrics → supply-chain-full.

4. **Wave 4 (long tail)**  
   operator-gated CD release-contract discovery; file-size on touch only; structure-wiring-ratchet stays long-horizon P2; feed-analysis runtime todos and historical governance findings stay off the main line.

5. **Consent-gated side track**  
   `todo-los-pi-k4-readonly-canary` only after explicit operator consent; never inferred from green tests or selection delivery.

#### Doc surfaces updated with this pass

- this queue addendum
- `docs/governance/2026-07-22-lsclaw-los-pi-kernel-migration-plan.md` Active Work Ledger
- `docs/operations/2026-07-25-ci-cd-observability-priority-and-todo-plan.md` stale Execution Lab / wave rows
- `docs/governance/agent-workflow-roadmap.md` Stage F short-term K4 status

### 2026-07-31 operator decisions addendum

Operator decisions recorded (ask tool, 2026-07-31):

1. **K4 canary authorized (read-only)** — operator granted consent for the Pi
   K4 readonly canary (`todo-los-pi-k4-readonly-canary`). The todo row is not
   present in the current runtime DB ledger (213 rows; no `pi-k4` id), so the
   consent is recorded here as the owning governance surface. Execution
   requires: a source run spec with persisted plan, an execution experiment
   created with the exact K4 kernel candidate (configDiff executionKernel
   pi@0.81.1+los.3, disposition planning/inspection, toolMode read-only),
   candidate selection, `approveRunSpecPhase()`, and the
   `POST /execution-experiments/{id}/authorize-canary` + `/execute` path.
   Default LOS kernel stays production baseline; canary results remain
   advisory until a formal pairwise sample-gate pass and rollback gates.

2. **Flow DSL deferred** — ADR 0030 (declarative-flow-dsl) remains design
   intent only; no implementation is scheduled. The decision is recorded here
   so the dangling ADR does not block Execution Lab or daily-agent work.
   Revisit only if a concrete workflow requirement emerges.

### 2026-08-02 delivery addendum (queue reconciliation)

Queue states updated against code delivered in PRs #144–#147 (Forgejo,
merged 2026-08-02; GitHub mirror #206):

| Todo | Prior state | 2026-08-02 state | Evidence |
| --- | --- | --- | --- |
| `todo-los-p1-context-reconstruction` | backlog | **done** | #132/#136 checkpoint versioning + degraded recovery + loop continuation |
| `todo-los-p1-stale-detection` | backlog | **done** | #134 decay-driven stale observation auto-marking |
| `todo-los-p1-perf-metrics` | backlog | **done** | #138 Prometheus metrics endpoint |
| `todo-los-p1-supply-chain-full` | backlog | **done** | #139 SBOM/license/freshness audit |
| `todo-los-execution-pairwise-sample-gate` | ready (main line) | **done** | #131 pairwise sample gate (thresholds/scenarios preregistration, immutable refs, live evaluation, 9 tests); optimization-analysis stays P2/backlog |
| `todo-los-ci-cd-observability-20260725` | in_progress (plan) | unchanged | resource baseline still 5/10 unique heads; turbo-cache stays blocked |
| `todo-los-pi-k4-readonly-canary` | backlog (authorized) | unchanged | canary still not executed; path fully wired (`authorize-canary`/`execute` + `pi@0.81.1+los.3` validation) |

Active P1 set after this reconciliation: `todo-los-p1-turbo-cache` (blocked),
`todo-los-p1-cbm-ab-inject` (backlog), `todo-los-p1-otel-docs` (done, kept for
history), plus the DB-owned submodule extraction rows (chat-service.ts,
config.ts) unchanged. `todo-los-execution-optimization-analysis` remains P2
advisory with `executionPolicy=blocked_until_real_pairwise_sample_gate_passes`;
the gate mechanism now exists, sample production still depends on manual
`POST /run-evals/pairwise` ingestion.

Governance debt recorded in this pass (not todo-dispatched):
1. coverage baseline refreshed 2026-08-02 (629 impl / 252 test files); check
   requires `LOS_TEST_SKIP_PATTERN="executes shell commands"` on macOS for the
   known sandbox failure; baseline check still not wired into CI (ratchet
   dormant; operator decision pending).
2. ADR 0030–0034 duplicate-number pairs await operator archive decision.
3. known-failures baseline enforcement stays local-gate-only (operator
   decision pending).

### 2026-08-03 K4 canary addendum (executed, advisory)

`todo-los-pi-k4-readonly-canary` — **executed (advisory)**, 2026-08-03.
Full evidence: `docs/operations/2026-08-03-k4-canary.md`.

| Item | Value |
| --- | --- |
| Experiment | `experiment-k4-canary-20260803d` (configDiff `executionKernel=pi@0.81.1+los.3`, disposition planning, read-only) |
| Source run | `run-k4-source-1785704633832` (audit/heavyweight, plan persisted + plan_approved, AP2) |
| Candidate | `run-experiment-k4-canary-20260803d-candidate` (plan_approved, canary granted) |
| Pi kernel evidence | `kernel.started`/`kernel.finished` session events; 1 loop, 287 completion tokens [E] |
| Outcome | experiment blocked (`candidate_plan_awaiting_approval`); results remain advisory until formal pairwise sample-gate pass and rollback gates |
| Defects fixed (PR #154) | approve no longer auto-dispatches K4 candidates; kernel assertion accepts running experiments |
| Todo row | Not present in runtime DB ledger (per 2026-07-31 note); status recorded here as the owning governance surface |

The todo is considered closed for dispatch purposes: canary execution is
complete and advisory. Do not re-dispatch; revisit only for the formal
sample-gate comparison and any rollback exercise. Default kernel stays
production baseline; `POST /execution-experiments/:id/rollback` remains wired.
