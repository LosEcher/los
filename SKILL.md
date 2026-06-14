---
name: los-project-operations
description: Use for repeated los-specific workflows that require current runtime evidence, ADR/source reconciliation, provider compatibility gates, gateway/executor lifecycle checks, or jj-aware closeout in /Users/echerlos/projects/los-workspace/projects/los.
---

# los Project Operations

Use this skill only inside the active `projects/los` repo. Keep global toolchain
rules, generic coding habits, and legacy project facts out of this file.

## Before Acting

1. Read `AGENTS.md` — including the Unconditional Pre-Action Gate and self-check.
2. For workspace-boundary questions, read `../../AGENTS.md` and `../../WORKSPACE.md`.
3. If `.jj/` exists, use `jj status` for local version-control truth.
4. Identify the affected surface before editing:
   - `contracts/` for API or package boundary changes
   - `docs/adr/` for design intent
   - implementation source for runtime behavior
   - persisted DB/API/session evidence for execution truth

### Complexity-Aware Task Dispatch

Before starting a task, gauge scope. Choose the workflow that matches — do not
over-instrument a one-line fix or under-instrument a cross-package refactor.

| Scope | Mode | Required Gates |
|-------|------|----------------|
| 1 file, <20 lines, no API change | Direct edit | `loadSpecsForFiles` + `pnpm check` |
| 2-3 files, same package | Bounded change | Above + read matching ADR + check after each file |
| 4+ files or crossing package boundaries | Plan mode | Above + `contracts/` review + full `pnpm gate` |
| >400 lines net new | Extract sub-module | Above + stay under 400-line warn threshold |
| New package or route module | ADR + plan | All above + operator approval + test harness |
| Provider, scheduler, or execution state change | ADR review + harness gate | All above + compat probe + golden trace update |

For investigations (read-only, no file changes), audit mode is the default:
read-first, lead with evidence, do not patch unless the operator switches mode.

## Workflow: Runtime Truth

Trigger when investigating gateway, executor, node registry, mesh readiness,
local process state, stale `online` rows, or "is los really running" questions.

Steps:

1. Check local process and health surfaces:
   - `pnpm run status`
   - `pnpm run executor:status`
   - `curl -fsS http://127.0.0.1:8080/health`
2. Check persisted truth separately from process truth:
   - `service_instances`
   - `executor_nodes`
   - relevant API responses such as `/nodes` and `/services`
3. Do not treat SOCKS/proxy reachability as gateway or executor health.
4. If stop/start behavior is involved, verify the stop path writes offline state
   before claiming registry truth is synchronized.

Evidence to report:

- command names used
- process/health result
- DB row or API row status
- whether heartbeat freshness, `candidate=true`, and `capabilities.run_agent`
  agree with the claim

**Evidence confidence markers** — append one to every claim:

- `[E]` = verified by exact command output, API response, or DB row value.
  Reproducible by running the same command.
- `[I]` = inferred from partial or indirect evidence. Name the missing surface.
  Example: `[I] gateway healthy inferred from /health 200; process RSS not checked`.
- `[U]` = unverified. Treat as hypothesis, not fact. Must be upgraded to `[E]`
  or `[I]` before a closeout or publish decision.

Stop when process truth, DB/API truth, and the user-facing claim agree, or when
the remaining mismatch is named with a confidence marker as residual risk.

## Workflow: ADR And Source Reconciliation

Trigger when reviewing recent changes, unfinished docs, ADR drift, contracts,
test coverage claims, or next work items.

Steps:

1. Read the relevant ADR and current implementation before judging status.
2. Treat implementation as current runtime behavior and ADR as design intent
   until verified.
3. For API or package boundary changes, read `contracts/` before source.
4. Use `./tools/check-contracts.sh` as the first workspace contract gate.
5. Verify broad test claims from source, excluding `node_modules/` and `dist/`.

Evidence to report:

- ADR path and implementation path
- contract files read, if any
- exact check command used
- current `jj status` when discussing closeout or publish readiness

Stop when docs, contracts, source, and checks either agree or the remaining
drift is turned into a concrete next work item.

## Workflow: Provider Compatibility And Harness Gates

Trigger when changing provider profiles, compatibility probes, CLI fallback,
tool policy, scheduler behavior, todo dispatch, node classification, session
replay, or advisory-provider promotion.

Steps:

1. Read the matching ADR first:
   - provider loop: `docs/adr/0007-provider-loop-first-model-profiles.md`
   - service/node readiness: `docs/adr/0010-node-connectivity-capability-taxonomy.md`
   - cluster roadmap: `docs/adr/0012-service-cluster-and-stateful-agent-roadmap.md`
   - testing gates: `docs/adr/0014-testing-strategy-and-regression-gates.md`
   - provider promotion: `docs/adr/0017-advisory-provider-promotion-playbook.md`
   - CLI fallback: `docs/adr/0018-cli-fallback-gate.md`
2. Update or add the focused harness, compatibility probe, or regression test
   when durable agent behavior changes.
3. Prefer targeted package checks first, then root checks when the blast radius
   crosses package boundaries.

Evidence to report:

- ADRs consulted
- focused harness/probe/test touched or intentionally left unchanged
- package-level checks and root checks run
- explicit residual risk when a live provider or quota surface was not verified

Stop when the changed behavior is covered by a harness/probe/test or the gap is
documented as an intentional follow-up.

## Workflow: Periodic Governance

Trigger when using `los` for daily runtime checks, weekly doc/source
reconciliation, monthly agent-use analysis, or recurring governance reports.

Steps:

1. Read `docs/README.md` and
   `docs/governance/periodic-analysis.md`.
   For stage-goal or personal agent-workflow questions, also read
   `docs/governance/agent-workflow-roadmap.md`.
2. Choose the cadence:
   - daily: process, health, node registry, and persisted readiness truth
   - weekly: docs, contracts, ADR/source drift, tests, and jj status
   - monthly: agent-use patterns, provider gates, eval candidates, operator
     contracts, toolchain matrix drift, and safety risks
3. Keep external agent logs and los-owned evidence separate. Use external
   Codex/Claude/OpenCode/Reasonix summaries only after redaction and provenance
   review.
4. Convert unresolved drift into a concrete doc, ADR, test, operation smoke, or
   todo item.

Evidence to report:

- cadence and date
- commands or data sources used
- config truth versus runtime truth
- persisted `task_runs`, `session_events`, `executor_nodes`, or
  `service_instances` evidence when relevant
- checks run and residual risks

Stop when the report either has no action with evidence, creates an owning
follow-up item, or names the blocked verification surface.
