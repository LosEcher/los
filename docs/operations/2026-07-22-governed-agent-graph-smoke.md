# Governed Agent Graph Smoke — 2026-07-22

## Scope

This smoke validates the local bounded graph path after fixing final run-spec
status ownership between the verifier task and graph scheduler. It does not
deploy or promote a remote executor, merge code, push a bookmark, or integrate
the graph automatically.

## Observed Runtime

- Gateway: PID `86848`, health `ok`, port `8080`.
- Executor: PID `86730`, health `ok`, node `mbp-executor-1`,
  `status=online`, `candidate=true`, `active=0` before the smoke.
- Gateway, executor, and working source fingerprint:
  `0.1.0+b8c7af717c4af`.
- Execution mode: provider `deepseek`, tool mode `read-only`, two workers with
  non-overlapping editable surfaces, one verifier, and required check
  `./tools/check-contracts.sh`.

Runtime checks:

```bash
pnpm run status
pnpm run executor:status
curl -fsS http://127.0.0.1:8080/health
curl -fsS http://127.0.0.1:8090/health
```

## Regression Cause And Fix

The earlier live graph completed both workers and the verifier, then returned
HTTP 422 because two components attempted to own the final run-spec transition:

1. `runVerificationRecordsForRunSpec()` moved the run spec to `succeeded`.
2. `applyGraphCompletionRunSpecTransition()` then tried to re-enter
   `verifying` before applying graph completion.

The graph verifier now calls the verification runner with
`updateRunSpecStatus: false`. Verification records remain verifier-owned;
graph-level final status remains scheduler-owned.

Focused regression evidence:

```text
scheduler verifier success/failure tests: 2 passed, 0 failed
gateway graph route tests: 2 passed, 0 failed
@los/agent typecheck: passed
```

Final workspace validation:

```text
pnpm check: passed
pnpm run gate: 9 phases passed, 0 failures, 329s
```

The success-path regression also asserts one `run_spec.succeeded` event, reason
`graph_completion:succeeded`, and no `succeeded -> verifying` transition.

## Live Run Evidence

| Surface | Identifier |
|---|---|
| Run spec | `smoke-governed-run-17846958873N` |
| Session | `smoke-governed-session-17846958873N` |
| Graph | `smoke-governed-graph-17846958873N` |
| Verification record | `verification-smoke-governed-run-17846958873N-r1-1` |

Observed result:

- `POST /agent-graphs/:id/run` returned HTTP `200`.
- Both executor tasks and the verifier task reached `succeeded` (`3/3`).
- Graph completion returned `status=succeeded` and `canComplete=true`.
- The persisted run spec reached `status=succeeded`, phase `succeeded`.
- The event ledger contains one final run-spec transition:
  `running -> succeeded`, reason `graph_completion:succeeded`.
- The event ledger contains zero `succeeded -> verifying` transitions.

An initial authenticated-write preflight omitted the operator credential and
received HTTP `401`. Its unexecuted run spec
`smoke-governed-run-17846958333N` was retained as audit evidence and moved to
`cancelled` through `transitionExecutionState()` with reason
`smoke_preflight_missing_operator_auth`; no row was deleted directly.

## Todo Reconciliation

The persisted Todo `todo-los-daily-agent-small-governed-graphs` was updated
from `backlog` to the seed-owned status `done`. A post-update dry reconciliation
left one unrelated status drift (`todo-los-p1-test-coverage`), three report-only
field drifts, and 72 independently owned DB-only todos unchanged.

## Judgment And Next Verification

The bounded local graph execution baseline is operational: creation, strict
surface ownership, parallel worker execution, verifier evidence, and graph-owned
completion are now demonstrated by tests and a persisted live run.

Remaining verification before increasing autonomy:

1. graph-level provenance display across run, task attempt, provider, node, and
   verification records;
2. interrupted graph resume and lease-recovery smoke;
3. serial-versus-bounded-graph eval comparison for latency, retries, conflicts,
   and operator intervention;
4. an operator-reviewed live integration action; automatic merge and release
   remain out of scope.
