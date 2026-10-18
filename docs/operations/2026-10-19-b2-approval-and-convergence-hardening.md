---
subject: B2 approval and scheduled-convergence hardening
auditedRev: 6fbe4499 (los git HEAD at batch start, 2026-10-19)
readOnly: false
method:
  - focused unit test (stateless approval gate)
  - PostgreSQL integration test (succeeded orphan sweep)
  - package typechecks (agent/executor/gateway)
  - source reading (broker, executor, reaper, task-complete route)
---

# B2 — approval and scheduled-convergence hardening

Date: 2026-10-19
Batch: B2 (close the three gaps recorded by ADR 0050)

## 1. Acceptance criteria (written before the change)

### A1 — Stateless execution blocks approval-required tools by construction

- A stateless executor (`EXECUTOR_DB_MODE=none`) passes
  `executionMode=stateless` into the agent kernel.
- The tool broker treats `executionMode=stateless` as `block` **before** the
  env flag/`warn` default; the handler must not run.
- Interactive/local runs keep `warn` by default (no broad behavior change).
- A focused test proves: stateless + `needsApproval` tool → `denied=true`,
  handler count 0, `tool.approval_required` payload `enforcementMode=block`.

### A2 — Succeeded tasks converge their scheduled run to succeeded

- The orphan scheduled-run sweep scans `succeeded` tasks in addition to
  `failed`/`cancelled`/`blocked`, and **never touches a run that has an active
  (`queued`/`running`) task** (retry guard).
- It picks the latest task attempt per run (`DISTINCT ON (r.id) ... ORDER BY
  t.created_at DESC`), so an old failed attempt cannot converge a live retry.
- A succeeded task converges its run to **succeeded** (with
  `completionResult` as `resultSummary` when present), not failed, including
  the `claimed → succeeded` path.
- A PostgreSQL integration test creates a succeeded task + **claimed** run and
  asserts the run ends `succeeded`; a second fixture has an old failed task plus
  an active running retry and asserts the sweep leaves it alone; a third has a
  claimed retry with a **live lease and no new task yet**, then expires the lease
  and asserts only the expired run converges.

### A3 — Completion convergence failure is observable

- `POST /tasks/:id/complete` still returns 200 (the task is already terminal),
  but on scheduled convergence failure it sets
  `scheduledConvergencePending: true` in addition to `scheduledWarning`.
- The periodic orphan sweep is the backstop (A2), not a silent 200.

### A4 — Reaper does not swallow run_spec block failures

- The reaper's `transitionExecutionState(run_spec → blocked)` failure path logs
  a warning naming the run_spec and task; it is no longer `.catch(() =>
  undefined)`.
- The 30-minute stale sweep remains an eventual backstop, but the failure is
  visible.

### A5 — No default change and no fleet rollout

- `EXECUTOR_DB_MODE=none` is still a canary; no default flip, no scheduling
  change, no gateway restart.
- The new behavior takes effect on a node only after the normal rollout; the
  evidence must say so.

### A6 — Checks

- `pnpm --filter @los/{agent,executor,gateway} check` pass.
- The focused approval test and the orphan-sweep integration test pass.
- `pnpm check:doc-anchors`, `pnpm check:workspace-docs`, `git diff --check`
  pass.
- One intent, Forgejo PR, exact-head checks, merge without `force_merge`;
  GitHub mirror untouched.

## 2. Implementation

| Area | Change |
| --- | --- |
| Agent config | `AgentConfig.executionMode: 'interactive' \| 'stateless'` (host-injected, not a user flag); propagated to `spawn_agent` children. |
| Broker | `executionMode=stateless` forces `block` before the env/`warn` default; `tool.denied` with `reasonCode=tool_approval_required`. |
| Executor | `runAssignedAgentTask`/`streamAssignedAgentTask` take `stateless` (= `dbDisabled`); the kernel config gets `executionMode=stateless|interactive`, overriding a dispatch config. |
| Orphan sweep | `DISTINCT ON (r.id)` latest attempt, `NOT EXISTS` active-task guard, **expired/absent run-lease guard**, scans `succeeded` too; target is `succeeded` for succeeded tasks (carrying `completionResult`), `failed` otherwise; records schedule outcome counters after the run transition. |
| Completion route | `_convergeScheduledRunForCompletion()` transitions the linked run, records the schedule outcome, and creates the recovery work item when a failed outcome opens the circuit. Sets `scheduledConvergencePending: true` if convergence throws. |
| Reaper | run_spec block failure now logs a warning with run_spec/task ids. |
| Transitions | `claimed → succeeded` is a legal scheduled-run transition (explicit completion / backstop can finish without a synthetic `running` step). |

## 3. Evidence

### 3.1 Approval gate `[E]`

```text
$ cd packages/agent && node --import tsx --test src/los-tool-broker-approval.test.ts
✔ warn mode lets a needsApproval tool run but records the missing channel
✔ block mode refuses a needsApproval tool before the handler runs
✔ stateless execution blocks approval-required tools by construction
# tests 3, pass 3, fail 0
```

### 3.2 Succeeded orphan sweep `[E]`

```text
$ cd packages/gateway && node --import tsx --import ./src/test-setup.ts \
    --test --test-global-setup=./src/test-global-setup.mjs \
    --test-name-pattern='orphan sweep' src/execution-reliability.test.ts
✔ orphan sweep converges a claimed run with a succeeded task to succeeded
✔ orphan sweep never touches a run with an active retry
✔ orphan sweep respects a claimed retry lease before its task exists
✔ completion-route convergence records the schedule outcome and opens the circuit
# tests 4, pass 4, fail 0
```

The tests run in the package's isolated test schema (the `test-setup` import is
what selects it). They also assert `current_schema() <> 'public'`, so a bare
`node --test <file>` fails safely instead of touching the live schema. They assert `run.status === 'succeeded'` +
`resultSummary === { ok: true, fixture: true }`, and that an active retry run
stays `claimed` with `converged === 0`.

### 3.3 Executor execution-channel mapping `[E]`

```text
$ cd packages/executor && node --import tsx --import ./src/test-setup.ts \
    --test --test-concurrency 1 src/execution-mode.test.ts
✔ stateless executor maps to the stateless approval channel
✔ DB-mode executor maps to the interactive channel
# tests 2, pass 2, fail 0
```

Both HTTP and NDJSON call sites pass `dbDisabled` into
`runAssignedAgentTask`/`streamAssignedAgentTask`, which calls
`executionModeForExecutor(stateless)`.

### 3.4 Typechecks `[E]`

```text
pnpm --filter @los/agent check    -> 0
pnpm --filter @los/executor check -> 0
pnpm --filter @los/gateway check  -> 0
```

### 3.5 Docs gates `[E]`

```text
pnpm check:doc-anchors    -> OK (baseline debt 28, stale 0)
pnpm check:workspace-docs -> OK (12 docs scanned)
git diff --check          -> clean
```

## 4. What this does not prove

1. **Not deployed to node34.** The canary still runs the previous build until a
   normal rollout; the live `/health` cannot show the new approval behavior.
   This is deliberate: no fleet restart in this batch.
2. **Only `EXECUTOR_DB_MODE=none` is forced to block.** A gateway-local
   scheduled run and a remote **DB-mode** executor are also headless (no
   interactive channel), but they remain warn-by-default in this batch. That is
   a separate behavior decision; the docs now say so instead of calling all
   remote executors "interactive".
3. **The sweep is periodic (30s), not synchronous.** `scheduledConvergencePending`
   means "the sweep will retry", not "converged now".
4. **The backstop records run status + schedule outcome counters and creates
   the recovery work item when a failed outcome opens the circuit.** It does
   **not** create a succeeded-result work item; that remains the normal
   runner's job, so a converged succeeded run may have no user-visible result
   artifact.
5. **Executor call-site wiring is typechecked, not integration-tested.**
   `executionModeForExecutor()` is unit-tested; the HTTP/NDJSON call sites pass
   `dbDisabled`, but a future omission would only be caught by review/typecheck.
5. **No event/gap metric** was added; the run_spec warning is a log line.

## 5. Adversarial review (post-delivery, PR #377)

An independent reviewer found two blockers, four majors and three minors in the
first draft. The corrections are recorded here.

| Finding | Correction |
| --- | --- |
| **B1** Sweep could converge an active retry: it joined every task row for a run with no active-task guard, and retries reuse the run row. | Added `AND NOT EXISTS (active task queued/running)`, `DISTINCT ON (r.id) ... ORDER BY t.created_at DESC` (latest attempt), and an **expired/absent run-lease guard** for the window where a retry is `claimed` before its new task exists. Tests cover the active-task case and the live-lease/expired-lease cases. |
| **B2** Documented test command ran against the live `public` schema. | The B2 evidence command now includes `--import ./src/test-setup.ts` and `--test-global-setup=./src/test-global-setup.mjs`; the tests were rerun that way. |
| **M1** `claimed → succeeded` was illegal, so claimed+succeeded runs could never converge. | Added `succeeded` to the `claimed` legal transitions; the integration test now starts from `claimed`. |
| **M2** Sweep bypassed schedule counters/circuit and the completion route never recorded the outcome on the main no-DB path. | The sweep records `recordScheduledRunOutcome`; `_convergeScheduledRunForCompletion()` in the completion route now does the same and creates the circuit-open recovery work item. A new route-level test asserts `consecutiveFailures=1`, `circuitState=open`, and a recovery work item. Succeeded-result work items remain the runner's job (documented). |
| **M3** `spawn_agent` children did not inherit `executionMode`. | `SpawnAgentRunnerOptions.executionMode` is threaded from the parent config into both background and sync child configs. |
| **M4** DB-mode remote executors are headless but remain warn. | Scoped the claim: only `EXECUTOR_DB_MODE=none` forces block in this batch; gateway-local and DB-mode remote stay warn. Documented in `.env.example`, B2 §4, ADR 0050. |
| **M5** No test proved the executor wiring (`dbDisabled` → `executionMode`). | Added `executionModeForExecutor()` + `execution-mode.test.ts`; both HTTP/NDJSON call sites pass `dbDisabled` (typechecked). A full HTTP/NDJSON integration test remains a residual. |
| m1 `scheduledConvergencePending` not logged | It is a response field only; documented. |
| m2 duplicate attempts could starve `LIMIT 50` | `DISTINCT ON` latest attempt fixes the per-run duplication. |
| m3 docs overclaimed closure / placeholder | This section replaces the placeholder; the ADR markers now name the B2 evidence and the remaining DB-mode scope. |
