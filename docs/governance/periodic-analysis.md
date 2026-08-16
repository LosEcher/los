# Periodic Analysis And Governance

## Purpose

`los` should become the primary local surface for agent execution evidence,
runtime inspection, and recurring governance reports. Other tools such as
Codex, Claude, OpenCode, Reasonix, and OMX can remain execution entrypoints or
comparison sources, but `los` should own the project-specific evidence model
when a run, provider gate, node state, or document decision is claimed as
current.

This document defines a lightweight recurring workflow. It is intentionally
operational: it tells an agent what to inspect, what evidence to record, and
where follow-up work belongs.

## Scope

Use this workflow for:

1. daily runtime and execution-health checks;
2. weekly documentation and ADR/source drift review;
3. weekly Controlled Operator Language audit (`language_audit` job — see
   `docs/governance/language-contract-observation.md`); promote to monthly
   after clean windows;
4. monthly agent-use and provider-governance review;
5. preparing a governance report before using `los` for larger autonomous
   execution.

Do not use it to store raw transcripts, auth snapshots, API keys, local browser
cookies, or full external-agent logs.

## Baseline Read Order

1. `AGENTS.md`
2. `SKILL.md`
3. `docs/README.md`
4. `docs/governance/agent-workflow-roadmap.md`
5. `docs/adr/0012-service-cluster-and-stateful-agent-roadmap.md`
6. `docs/adr/0014-testing-strategy-and-regression-gates.md`
7. `docs/adr/0016-omx-tool-level-logging-scope.md`
8. `docs/adr/0017-advisory-provider-promotion-playbook.md`
9. `docs/adr/0018-cli-fallback-gate.md`

For workspace-boundary questions, read `../../../../WORKSPACE.md` and
`../../../../AGENTS.md` before inspecting legacy projects.

## Daily Runtime Check

Question: is the local `los` runtime usable today?

Run:

```bash
pnpm run status
pnpm run executor:status
curl -fsS http://127.0.0.1:8080/health
```

If the claim involves registry truth, also inspect the persisted or API-backed
state for:

1. `service_instances`
2. `executor_nodes`
3. `/nodes`
4. `/services`

Report:

```text
Date:
Runtime:
- gateway process:
- gateway health:
- executor process:
- executor health:

Persisted evidence:
- service_instances:
- executor_nodes:
- stale heartbeat rows:
- candidate=true rows:

Judgment:
- usable for local execution: yes/no
- residual risk:
```

Stop only when process truth, API/DB truth, and the user-facing claim agree, or
when the mismatch is named as residual risk.

## Weekly Documentation And Source Review

Question: do docs, contracts, source, tests, and live checks still agree?

Run the minimum read-only pass first:

```bash
jj status
find docs -maxdepth 2 -type f | sort
find contracts -maxdepth 2 -type f | sort
rg -n "TODO|FIXME|Status|Partially implemented|unverified|advisory|required" docs contracts packages tools
```

Then choose checks by changed surface:

```bash
./tools/check-contracts.sh
pnpm check
pnpm test
```

### Backlog Inspection (weekly)

Question: are eval backlog cases with automated probes still passing?

```bash
# Run only the eval backlog probes
node --import tsx --test --test-name-pattern="E0[238]" packages/agent/src/eval-probes.test.ts

# Record a snapshot into run_evals for the dashboard
# (operator endpoints require the x-los-operator-token header, not Bearer)
source .env 2>/dev/null
TOKEN="${LOS_OPERATOR_TOKEN:-$LOS_AUTH_TOKEN}"
curl -X POST http://127.0.0.1:8080/eval-backlog/run \
  -H "x-los-operator-token: $TOKEN" \
  -H "Content-Type: application/json"
```

Check the dashboard at `#evals` with `runSpecId=eval-backlog` to see which cases have
probes and whether the automated ones pass.

If a previously passing probe now fails, treat it as P1: the guarded failure pattern
may have regressed.

Use ADR 0014 to decide whether a package-level test, compatibility harness, or
operation smoke is also required.

Report:

```text
Date:
Changed or risky surfaces:
- docs:
- contracts:
- packages:
- tools:

Drift found:
- doc vs source:
- config vs runtime:
- ADR intent vs implementation:
- test claim vs source truth:

Checks:
- command:
- result:

Next work items:
- P0:
- P1:
- P2:
```

Turn unresolved drift into a concrete doc, ADR, test, or todo item. Do not leave
it as an unowned observation.

## Execution-Record Driven Review (weekly)

Question: what do the persisted execution records and telemetry say about
provider health, scheduling, node capacity, and run quality this week?

The daily governance jobs already audit these surfaces automatically
(adversarial_review, performance_audit, hotspot, fleet alerts in the daily
digest). The weekly review synthesizes them into an operator-facing judgment
instead of re-running the same probes. Evidence surfaces and exact SQL are in
`docs/operations/2026-08-16-execution-record-weekly-review.md`.

Minimum pass (read-only, ~10 minutes):

```bash
# 1. Governance job results — any escalation / paused / circuit state?
export $(grep -E '^(DATABASE_URL|TEST_DATABASE_URL)=' .env | head -2)
psql "$DATABASE_URL" -c \
  "select job_type, cadence, status, circuit_state, consecutive_failures, last_run_at \
   from governance_jobs order by job_type"

# 2. Provider call telemetry — zero-call providers, latency outliers, error spikes
psql "$DATABASE_URL" -c \
  "select provider, count(*), count(*) filter (where error is not null) as errs \
   from provider_call_telemetry where created_at > now() - interval '7 days' \
   group by provider order by 2 desc"

# 3. Dead-letter — new unrecoverable events since last review
psql "$DATABASE_URL" -c \
  "select reason, count(*) from dead_letter_events \
   where created_at > now() - interval '7 days' group by reason"

# 4. Fleet — node status, retired nodes, resource findings from the digest
psql "$DATABASE_URL" -c \
  "select node_id, node_kind, status, updated_at::date \
   from executor_nodes order by status, node_id"
```

Then answer three questions and convert each answer into an owned item
(doc / ADR / test / todo / provider-gate change):

1. **Provider**: is every discovered provider either used or retired from the
   discovery list? (2026-08-15 finding: packycode/custom/deepseek-anthropic
   were "ready but unused" — the finding's 7-day window itself was unreliable,
   so re-check with a wider window before acting.)
2. **Scheduling**: are there stuck approvals, lease-expired retries, or
   circuit-state changes that the daily jobs merely reported?
3. **Node capacity**: do light nodes (<=2GB RAM, e.g. oracle-executor) show
   absolute-memory warnings (`memory_available_abs`)? Is any node retired and
   should its registry row be removed?

Closeout: the review either has no action with evidence, creates an owning
follow-up, or names the blocked verification surface. Record the review in
`docs/operations/` with the same evidence markers as other dated smokes.

## Monthly Agent-Use Governance Review

Question: how should `los` improve the user's agent workflow next?

Inputs:

1. `task_runs` and `session_events` summaries from `los`;
2. operation smoke records under `docs/operations/`;
3. project docs and ADR changes from the month;
4. external tool summaries only after redaction and provenance review.

Analyze these dimensions:

1. task type distribution: review, implementation, runtime diagnosis, docs,
   provider compatibility, VCS closeout;
2. execution quality: success, retry, failure class, missing evidence;
3. verification quality: unit tests, `pnpm check`, `pnpm test`, compat harness,
   live smoke;
4. model/provider behavior: required targets, advisory targets, blocked
   credentials, quota or route risk;
5. governance drift: stale ADRs, config mismatch, TODOs without owner,
   operation smokes that should become tests;
6. safety: raw transcript risk, auth leakage risk, over-broad tool access,
   external CLI fallback risk.
7. operator contracts: whether the run was audit, execution, or closeout mode,
   and whether completion criteria were stated before execution.
8. toolchain matrix drift: whether Codex, Claude, OpenCode, Reasonix, OMX, or
   browser tools changed model route, permissions, memory location, or evidence
   quality.
9. eval backlog coverage: how many backlog cases have automated probes, whether
   automated probes pass, which manual-only cases should be promoted next.

Report:

```text
Month:
Evidence sources:
- los:
- docs:
- external summaries:

Findings:
1.
2.
3.

Decisions:
- keep:
- change:
- promote to ADR:
- promote to test/harness:
- keep advisory:

Next month's checks:
1.
2.
3.
```

Use `agent-workflow-roadmap.md` to decide whether findings should become mode
contracts, toolchain-matrix entries, eval candidates, runtime work, or a
non-actionable note.

## Agent Evaluation Backlog

The canonical backlog is `docs/governance/eval-backlog.md`. Automated probes for
E02, E03, and E08 live in `packages/agent/src/eval-probes.test.ts`. Results are
recorded into the `run_evals` table via `POST /eval-backlog/run` and are visible
in the evals dashboard.

Keep eval candidates narrow. Each candidate should name the failure mode and
the evidence that catches it.

To promote a backlog case to an automated probe:

1. add a test in `packages/agent/src/eval-probes.test.ts` following the existing
   pattern (case ID in test name, `eval-backlog-runner.ts` already knows about it);
2. update `packages/agent/src/eval-backlog-runner.ts` to mark `hasProbe: true`;
3. record a snapshot: `curl -X POST http://127.0.0.1:8080/eval-backlog/run`.

Useful initial candidates:

1. broad formatting modifies unrelated files in a dirty worktree;
2. runtime health is inferred from config instead of process/API/DB truth;
3. provider readiness is treated as compatibility proof;
4. an ADR status is repeated without checking source;
5. external transcripts are treated as los replay evidence;
6. `jj` repos are judged from Git detached-HEAD state instead of `jj status`;
7. operation smoke evidence is not promoted into a regression test when it
   protects durable behavior.

Each eval should record:

```text
Name:
Trigger:
Bad answer pattern:
Required evidence:
Passing answer pattern:
Owner surface:
```

## Loop / Scheduled-Task Candidates

Repeated work from session history that is a fit for `scheduled_work_items`
(interval/cron, persisted `result_summary_json`) or `governance_jobs`
(cadence + circuit breaker). Register via the Web Schedules page or
`scheduled-work-routes.ts`; keep the same item idempotent (interval +
`dedupeKey`).

| Candidate | Cadence | Template/type | What it does | Provenance |
|---|---|---|---|---|
| Runtime readiness snapshot | 5-10m | `runtime_readiness` | Node/service online snapshot to `scheduled_work_item_runs` | live since 08-05 (`schedule-c86f9f56`) |
| Doc drift sweep | weekly | `scheduled_execution` or manual | Run the `los-doc-drift-sweep` skill checklist: doc anchors, command surface, ADR numbering, memory vs persisted truth | skill `los-doc-drift-sweep`; 2026-08 analysis |
| Todo/task_run reconciliation | daily | governance-style | Detect zombie `in_progress` todos (AP12) and machine-generated `ready` floods; demote with metadata note | 08-05/08-08 cleanups |
| DB instance guard | on-demand (doctor) | deterministic check | Verify `lsof :55432` owner + `.env` comment before inventory queries | 08-05 dual-postgres incident |
| Session theme summary | monthly | `scheduled_execution` (audit mode) | Summarize recent session topic distribution (inventory/gaps/fixes/scenario validation) and feed the monthly governance review | 2026-08 periodic analysis |

Keep promotion rules: a candidate becomes a persisted schedule only when it is
idempotent, has a bounded blast radius (audit/read-only first), and its
evidence lands in a queryable table. Do not create parallel schedulers —
`governance_jobs` owns governance cadences, `scheduled_work_items` owns
work-item execution.

## Placement Rules

1. Global agent habits stay in global `AGENTS.md` only when they are
   cross-project defaults.
2. `los` runtime contracts, provider gates, node readiness, and execution
   evidence stay in this repo.
3. Legacy-project observations stay in `los-workspace` docs unless a current
   `los` ADR copies the behavior into `los`.
4. Repeated los-specific workflows belong in `SKILL.md`.
5. Dated live evidence belongs in `docs/operations/`.
6. Durable architecture decisions belong in `docs/adr/`.

## Closeout Rule

A periodic governance pass is complete only when it ends with one of these:

1. a clean "no action" report with commands and evidence;
2. a doc/ADR/test/todo change that owns the drift;
3. an explicit residual risk that names the blocked verification surface.
