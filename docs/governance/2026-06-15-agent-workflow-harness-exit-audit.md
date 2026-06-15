# 2026-06-15 Agent Workflow Harness — Stage Exit Audit

## Background

`docs/governance/agent-workflow-roadmap.md` defined a five-stage plan (A through E) for making high-autonomy agent work inspectable, recoverable, and gradable. The `todo-los-agent-workflow-harness` phase tracked 19 sub-tasks across the chain: governance artifacts, run contract metadata, runtime state reconciliation, external summary adapter, planner-executor-verifier DAG, and six runtime evaluation tasks (static graph, run events replay, NDJSON tool state parity, DAG serial scheduler, verifier runtime gate, runtime evidence graph).

All 19 sub-tasks are `status: done`. This audit verifies the chain is complete and cross-references evidence against the roadmap's exit criteria.

## Task Chain Evidence

### Governance Artifacts (5 done)

| Task | Evidence |
|------|----------|
| `agent-workflow-harness` | `agent-workflow-roadmap.md` Stages A-E, `run-contract-template.md`, `toolchain-matrix.md`, `eval-backlog.md` |
| `agent-execution-gap-plan` | `agent-execution-gap-plan.md` — tool comparison table (Codex, Claude Code, Reasonix, OpenCode, OMX) |
| `agent-mode-contracts` | `run-contract-template.md` — audit/execution/closeout modes |
| `run-contract-template` | `run-contract-template.md` — template with mode, goal, editable surfaces, required checks, stop conditions, evidence |
| `toolchain-matrix` | `toolchain-matrix.md` — 8-tool comparison with promotion gates |
| `personal-eval-corpus` | `eval-backlog.md` — 20 eval cases across 6 families |

### Run Contract Metadata (4 done)

| Task | Evidence |
|------|----------|
| `run-contract-metadata` | `run-contract.ts` — 21-field `RunContractMetadata`, `normalizeRunContractMetadata()`, `canMarkSucceeded()`, E14/E15/E16 tests |
| `run-spec-contract-reconciliation` | `run-specs.ts` — `run_contract_json` JSONB storage, `/chat` creation path |
| `tool-call-state-loop-wiring` | `tool-call-states.ts` + `loop.ts` + `scheduler.ts` — tool state transitions in execution path |
| `verification-state-records` | `verification-records.ts` — required checks with status tracking, `verification-runner.ts` — command execution |

### Runtime State Reconciliation (2 done)

| Task | Evidence |
|------|----------|
| `provider-promotion-evidence-record` | `provider-compat-evidence.ts` — verified advisory summaries; `los provider promote` CLI |
| `agent-eval-harness-wire` | `eval-backlog.test.ts` — E01-E06 wired as runnable tests |

### External Summary Adapter (2 done)

| Task | Evidence |
|------|----------|
| `external-tool-summary-adapter` | `external-tool-summary.ts` — redaction fixtures, provenance, bounded `external_summary` records |
| `planner-executor-verifier-dag` | `planner-executor-verifier-dag-contract.md`, `agent-task-graph.ts` — verifier task type, completion gate |

### Runtime Evaluation (6 done)

| Task | Evidence |
|------|----------|
| `static-execution-graph-ast` | `execution-static-graph.ts` — CLI commands, gateway routes, agent exports, core call chain |
| `run-events-replay-read-model` | `server.ts` — `/runs/:id/events?since=` endpoint, `run-events-routes.test.ts`, `contracts/run-stream.yaml` |
| `executor-ndjson-tool-state-parity` | `executor/src/index.ts` + `scheduler.ts` — NDJSON stream carries `tool_call_state` transitions |
| `dag-claim-scheduler-serial` | `scheduler.ts` — serial `claimReadyAgentTasks()` → execute → attempt cycle |
| `verifier-completion-runtime-gate` | `scheduler.ts` — `requireVerifier` gates graph completion transition |
| `runtime-evidence-kg` | `runtime-evidence-graph.ts` — cross-table projection (run_specs→task_runs→session_events→tool_call_states→verification_records→agent_tasks) |

## Roadmap Stage Cross-Reference

| Stage | Status | Evidence Summary |
|-------|--------|-----------------|
| A: Evidence Harness | **Complete** | `2026-06-10-stage-a-exit-audit.md` |
| B: Operator Contract | **Implemented** | ADR 0021, 21-field `RunContractMetadata`, B0 gates + goal self-check |
| C: Personal Eval Corpus | **Implemented** | 20 eval cases, 6 families, `eval-backlog.test.ts` |
| D: Stateful Runtime | **Partially done** | Run specs, stream replay, tool-call recovery, verification records all exist; cross-gateway resume gap remains |
| E: Multi-Agent | **Partially done** | DAG store, verifier tasks, provider/model task selection, tool-call recovery exist; graph hardening not done |

## Remaining Gaps (Post-Harness)

1. **Stage D: Cross-gateway resume.** `/chat` can replay via `/runs/:id/events?since=`, but active execution resume on a different gateway instance hasn't been smoke-tested.
2. **Stage C exit criteria #3**: Monthly governance report automation (requires `governance-periodic-sweeper`, currently backlog).
3. **Stage E**: Graph-level parallel execution hardening, editable-surface conflict resolution at >1 parallel task.
4. **Goal self-check quality metrics** (added 2026-06-15): No automated measurement of self-check accuracy vs operator overrides yet.

## Verdict

The agent workflow harness is **operationally complete**. All 19 planned sub-tasks have implementation evidence in source, tests, and contracts. The harness itself (the ability to define, execute, verify, and audit agent work) is in place. Remaining work falls under the "hardening" and "automation" categories that are downstream of the harness itself — specifically Stages D and E of the roadmap and the `governance-periodic-sweeper`.

The `todo-los-agent-workflow-harness` phase can be marked `done`.
