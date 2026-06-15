# Governance Module Boundary

## Status

Accepted (2026-06-15). This document defines the boundary between los's existing execution ledger (`todos`, `task_runs`, `session_events`) and future recurring governance automation.

## Problem

The `todos` and `task_runs` models already serve as a dual execution ledger:

- `todos` — planning, dependency tracking, archival, and evidence requirements
- `task_runs` — per-execution lifecycle records with session events, verification records, and run contracts

If periodic governance work (consistency audits, hotspot detection, architecture drift sweeps, tool drift sweeps, provider compatibility surveillance) is pushed directly into `task_runs` as if it were "just another task," three things break:

1. **Evidence surface collapse.** A governance sweep that discovers 50 stale files does not benefit from being stored as a single `task_run` row with a 10,000-character summary blob. It needs a structured result shape (file list, matched rules, severity, timestamps) that is queryable across runs.

2. **Scheduling collision.** Periodic sweeps have their own cadence (daily, weekly, release-gate), retry strategy (skip if not ready), and dedupe semantics (one sweep of a given type per day). Overloading `task_runs` with these scheduling concerns dilutes the model.

3. **Accountability confusion.** When an operator reviews `/tasks`, they should see agent execution work — not maintenance noise. Governance sweeps belong in a separate view with their own pass/fail/action-required taxonomy.

## Design

### Three-Layer Governance Model

**Layer 1 — Planning and Dependencies (todos)**

`todos` store governance plans, dependency chains, priority, stage grouping, and metadata (ADRs, reference docs, evidence expectations). This is where governance work is planned and tracked at the roadmap level. Examples:

- "define governance module boundary" → `todo-los-governance-module-boundary` (plan, ready)
- "implement periodic sweeper" → `todo-los-governance-periodic-sweeper` (task, backlog)

When governance work is ready for execution, it is dispatched as a `task_run` — just like any other agent task. The dispatch bridge (`/todos/:id/dispatch`) creates the `task_run` with run contract metadata, dependency checks, and trace linkage.

**Layer 2 — Execution Evidence (task_runs + session_events)**

Every governance action that runs through the agent loop writes standard execution evidence:

- `task_runs` — lifecycle (queued → running → succeeded/failed/cancelled), node assignment, lease, metadata
- `session_events` — audit trail of agent actions (tool calls, model responses, errors)
- `verification_records` — required checks and their outcomes

This is the **only** path through which governance work produces los-owned execution evidence. The agent does the auditing, and the evidence is the same structured event stream as any other task.

**Layer 3 — Recurring Configuration and Results (governance_jobs)**

The `governance_jobs` concept (future implementation, now in `todo-los-governance-periodic-sweeper`) is a configuration and results store, **not** an alternative execution path:

| Field | Purpose |
|-------|---------|
| `job_type` | audit, hotspot, drift, provider_surveillance |
| `cadence` | daily, weekly, release_gate |
| `tenant_id` / `project_id` | scope |
| `config` | rules to apply, thresholds, directories to scan |
| `last_run_at` | when the job last executed |
| `last_task_run_id` | link to the most recent execution evidence |
| `result_summary` | structured outcome (pass/fail/counts) |
| `dedupe_key` | prevents duplicate runs within a cadence window |

A sweeper (scheduled or operator-triggered) reads `governance_jobs`, determines which are due, dispatches them as `task_runs`, and writes the result summary back to the job record. The execution evidence lives in `task_runs`/`session_events`. The job config and cadence live in `governance_jobs`. They reference each other but do not merge.

### What Belongs Where

| Surface | Owns | Does NOT own |
|---------|------|-------------|
| `todos` | Governance plans, dependency chains, ADR references | Execution lifecycle, run-level evidence |
| `task_runs` | Per-run lifecycle, session events, verification records | Cadence, recurring config, sweep result shape |
| `session_events` | Audit trail of agent actions during a governance run | Job-level scheduling metadata |
| `governance_jobs` (future) | Cadence, scope, thresholds, result summary, dedupe key | Raw execution evidence (that lives in task_runs) |

### Governance Categories

The following categories of recurring governance are in scope for `governance_jobs`:

1. **Consistency audit** — checks that todo statuses, ADR claims, and implementation files are not drifting apart
2. **Hotspot detection** — identifies files exceeding size/change-frequency thresholds; flags them as todo candidates
3. **Architecture drift** — checks that import boundaries, package dependencies, and contract files match ADR declarations
4. **Tool drift** — checks that tool capability declarations in the registry match actual runtime behavior
5. **Provider compatibility surveillance** — periodic re-run of `los compat` with enforced gates; flags providers that have regressed

### Non-Goals

- `governance_jobs` does **not** replace cron, systemd timers, or external scheduling. It is a configuration and results store that a scheduler reads.
- `governance_jobs` does **not** store raw agent transcripts or tool outputs. Those belong in `session_events` (redacted) or external tool summaries (bounded, per ADR 0019).
- Governance sweeps do **not** mutate production data. They read and report. The agent may create follow-up todos, but destructive actions require operator gates (per the operator consent model in AGENTS.md).

## Implementation Status

| Component | Status | Evidence |
|-----------|--------|----------|
| Todo governance dependency graph | Done | `todo-seeds-governance.ts`, `todos.ts` dependency tracking |
| Drift detection prototype | Done | `governance-reconciliation.ts`, `governance-status-constraints.ts`, `governance-runtime-cleanup.ts` |
| Static execution graph | Done | `execution-static-graph.ts` — drift baseline |
| Runtime evidence graph | Done | `runtime-evidence-graph.ts` — cross-table projection |
| External tool summary adapter | Done | `external-tool-summary.ts` — bounded, redacted ingestion |
| Hotspot detection | Backlog | `todo-los-governance-hotspot-and-tool-drift` |
| Periodic sweeper implementation | Backlog | `todo-los-governance-periodic-sweeper` |
| SaaS todo dispatch bridge | Backlog | `todo-los-governance-saas-todo-bridge` |

## Relationship to Self-Bootstrapping

The governance module boundary is a prerequisite for autonomous agent self-improvement. When the agent can autonomously detect drift, propose corrections, dispatch verification runs, and track whether its own corrections improved the baseline — all without collapsing governance evidence into the same surface as execution evidence — the Memory 闭环 and Reflection 闭环 become implementable on a stable foundation.
