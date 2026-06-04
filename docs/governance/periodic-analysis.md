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
3. monthly agent-use and provider-governance review;
4. preparing a governance report before using `los` for larger autonomous
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

Keep eval candidates narrow. Each candidate should name the failure mode and
the evidence that catches it.

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
