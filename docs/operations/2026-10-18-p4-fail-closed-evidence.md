---
subject: P4 fail-closed semantics — acceptance criteria and live evidence
auditedRev: 66f28263 (los git HEAD at batch start, 2026-10-18)
readOnly: false
method:
  - live node34 /health and gateway /health
  - live PostgreSQL reads (scheduled_work_item_runs, task_runs)
  - source anchors for reaper / convergence / approval
  - decision record ADR 0050
---

# P4 fail-closed semantics — acceptance and evidence

Date: 2026-10-18
Batch: B (ratify fail-closed as the final P4 semantics; do **not** promote `none`)

## 1. Acceptance criteria (written before the change)

### A1 — Decision is explicit and binding

- `docs/adr/0050-p4-stateless-executor-fail-closed-semantics.md` is `Accepted`,
  states that **fail-closed is the final P4 semantics for lease/restart**, and
  states that `EXECUTOR_DB_MODE=none` remains a **canary, not the remote
  default**. Approval is explicitly outside that scope: it is warn-by-default
  and remains an open gap/promotion gate.
- The ADR replaces the open item "either prove restart-survival or ratify
  fail-closed" with a decision; it does not leave both branches open.

### A2 — Failure semantics are enumerated with code anchors

- The ADR has a table for lease expiry/restart, orphaned scheduled runs,
  explicit completion, headless approval, and 401/403/409/503.
- Every row cites a source path and line; the rows do not rely on prose alone.
- The accepted outcomes are: task failed + dead letter, scheduled run failed,
  run_spec blocked, approval denied, no DB fallback. Silent retry, failed-as-
  succeeded, permanently-running scheduled run, or auto-approved headless tool
  are explicitly rejected.

### A3 — Promotion gate is explicit and measurable

- The ADR lists all six gates: controlled restart survival, bounded startup
  budget, event gap detection, exactly-once convergence, fleet-wide deploy gate
  coverage, and enforced headless/stateless approval.
- The gates say **all** must hold and a new ADR must supersede this one; a
  wording change alone is insufficient.

### A4 — Existing docs stop presenting P4 as undecided

- `docs/architecture/2026-10-18-executor-db-mode-and-state-ownership.md`
  "Next required work 1" points to ADR 0050 instead of repeating the open
  either/or.
- The node runbook's canary paragraph cites ADR 0050.
- `docs/README.md` indexes both this evidence doc and ADR 0050.

### A5 — Live evidence matches the decision

- node34 `/health` still reports `db=none`, `taskTokenMode=required`,
  `leaseTransport=http-when-token`, `eventBacklog=0`, `spoolBacklog=0`.
- `scheduled_work_item_runs` has **0** rows in `running`/`claimed`;
  `task_runs` has **0** rows in `running`/`queued`.
- Recent failed scheduled runs show convergence evidence
  (`lease expired: …` and `… running without scheduled convergence`), not empty
  errors or permanent running rows.
- The headless approval path is **not** claimed as fail-closed: the test
  proves the `block` mechanism denies before the handler, while the runtime
  default is `warn` (handler runs). No `LOS_TOOL_APPROVAL_ENFORCEMENT=block` is
  set on the gateway or node34; this is recorded as an open gap and promotion
  gate 6. (Refined after adversarial review: the first draft claimed the test
  proved the shipped default, which it does not.)

### A6 — No runtime behavior change

- This batch is documentation/decision only. It does not change scheduling,
  placement, executor startup, tokens, storage retention, or the `none` default.
- It does not restart the gateway, roll the fleet, or promote `none`.

### A7 — Repository gates

- `pnpm check:doc-anchors` and `pnpm check:workspace-docs` pass.
- `bash -n` not applicable (no shell change); `git diff --check` clean.
- One intent, Forgejo PR, exact-head checks, merge without `force_merge`;
  GitHub mirror untouched.

## 2. Decision summary

ADR 0050 accepts fail-closed. `none` stays canary. The concrete consequences:

- A gateway restart during a no-DB task is expected to **lose that task**; the
  task is reaped as failed, the linked scheduled run is converged to failed,
  and the run_spec is blocked. That is the contract, not an incident.
- Promotion requires a new ADR with the six gates in §3 of ADR 0050.
- The deploy gate (`EXECUTOR_DB_MODE` contract) remains the precondition for a
  node to run `none`; it does not make `none` the default.

## 3. Live evidence

All commands ran on 2026-10-18 from the gateway host. `[E]` = exact output.

### 3.1 node34 remains a healthy canary `[E]`

```json
{"status":"ok","nodeId":"node34-executor-1","version":"0.1.0+bc63799a80f0c",
 "taskTokenMode":"required","db":"none","eventBacklog":0,"spoolBacklog":0,
 "leaseTransport":"http-when-token","lifecycle":"online","activeTaskCount":0}
```

`ss -tnp | grep -E ':(55432|5432)\b'` on node34: `none`.

### 3.2 No stranded work `[E]`

```text
running_scheduled=0
running_tasks=0
node34_tasks_24h=25
failed_scheduled_24h=19
```

### 3.3 Recent failed scheduled runs show convergence, not silence `[E]`

```text
schedule-run-17d4537b-…|failed|task_run task-cc9aaa4c-… is running without scheduled convergence
schedule-run-f85a8bdd-…|failed|task_run task-reaper-1792330292 lease expired: manual_reaper_test
```

Both rows are **manual/backfill evidence**, not produced by the current
committed sweep:

- row 1's text "is running without scheduled convergence" cannot be produced by
  `execution-lease-reaper.ts:25-26` (it selects failed/cancelled/blocked and
  interpolates the terminal status), and its scheduled run was updated before
  the current gateway process started and before the orphan-sweep commit;
- row 2's task metadata is `recoveryReason=manual_reaper_test`.

They show that convergence has been exercised and what the error text looks
like; they do **not** prove the automatic sweep ran. The automatic task-level
failure is visible as `metadata.recoveryReason=gateway_periodic_reaper` on
`task-cc9aaa4c`. Capturing an automatic post-fix scheduled convergence is a
follow-up.

### 3.4 Source anchors `[E]`

- `packages/gateway/src/execution-lease-reaper.ts:44` — reaper entry;
  `:51` dead letter; `:58` scheduled convergence; `:66-72` run_spec block +
  swallowed error.
- `packages/gateway/src/execution-lease-reaper.ts:18` — orphan scheduled-run
  sweep.
- `packages/gateway/src/routes/orchestration/task-complete-routes.ts:78-101` —
  explicit completion attempts convergence (transition at `:83`) and swallows
  failure into `scheduledWarning`.
- `packages/agent/src/los-tool-broker.ts:219-243` — `warn` is the default;
  only `block` denies.
- `packages/agent/src/los-tool-broker-approval.test.ts:50-63` — warn mode runs
  the handler; `:75` — block mode denies before the handler runs.
- `packages/executor/src/lease-fencing.ts:67-70` — 401/403/409/503 abort reasons.

### 3.5 Repository gates `[E]`

```text
pnpm check:doc-anchors   -> OK (baseline debt 28, stale 0)
pnpm check:workspace-docs -> OK (12 docs scanned)
git diff --check          -> clean
```

## 4. What this does not prove

1. It does **not** prove restart survival; it records that restart survival is
   not required for P4's accepted semantics.
2. It does **not** make `none` safe for a second production node; promotion
   still requires the ADR 0050 §3 six gates.
3. It does **not** prove the event sink has global gap detection; that remains
   a promotion gate.
4. It does **not** close three approval/convergence gaps found in review:
   approval is warn-by-default; explicit completion swallows scheduled
   convergence errors and can leave a **succeeded** task's run stuck; the
   reaper's run_spec block transition is swallowed (the 30-minute
   `recoverStaleRunningRunSpecs` sweep is only an eventual backstop).
5. It does **not** change the deploy surface or roll the fleet.

## 5. Adversarial review (post-delivery, PR #375)

An independent reviewer falsified the first draft. The findings and the
corrections are recorded here because the draft had repeated a pre-existing
false claim from the P4 close note.

| Finding | Correction |
| --- | --- |
| **B1** ADR said headless approval is fail-closed and cited the test as proof | Runtime defaults to `warn` (`los-tool-broker.ts:219-243`); only `block` denies. ADR row, architecture doc, A5 and §3.4 now say warn-by-default and list approval enforcement as promotion gate 6 / open gap. `.env.example` documents `LOS_TOOL_APPROVAL_ENFORCEMENT`. |
| **M1** Explicit completion claimed to converge before returning | It catches the transition error into `scheduledWarning` and returns 200; a succeeded task's stuck run is not swept. ADR now says "attempts", records the gap, and gate 4 requires extending the sweep. |
| **M2** Evidence called the two rows "orphan sweep"/"lease reaper" | Both are manual/backfill; row 1's text cannot come from the committed query. §3.3 now labels them manual and points to `gateway_periodic_reaper` for the automatic task-level failure. |
| **M3** Reaper claim said run_spec "进入 blocked" | The transition is `.catch(() => undefined)`; only the 30-minute stale sweep is an eventual backstop. ADR now states the swallow. |
| **M4** Orphan sweep said "task 已终态" | Code covers only failed/cancelled/blocked. ADR says that explicitly and calls out the succeeded gap. |
| m1 anchor drift | Anchors corrected: `:51`, `:58`, `:83`, `:67-70`. |
| m2 promotion gates vague | Gate 1 now names 20/20 and three fault classes; gate 2 requires ≥20 samples and p50/p95/max; gate 3 requires a gap count over 20 restarts; gate 6 added. |
| m3 0049 cleanup | README note now says 0049 is retired/do-not-reuse; the 10-11 architecture doc points to that note. |
| n1 placeholder | This section replaces it. |
