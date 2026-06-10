# Agent Workflow Roadmap

## Purpose

`los` should first become a local evidence and governance harness for
high-autonomy agent work. It should not try to replace Codex, Claude, OpenCode,
Reasonix, OMX, or browser-based tools immediately.

The current design target is narrower:

1. describe the work mode before execution starts;
2. collect enough evidence to judge whether a run was responsible;
3. turn repeated failures into eval candidates, tests, harness probes, docs, or
   todos;
4. keep external tool summaries separate from `los`-owned run evidence.

## Input Status

This roadmap is based on the 2026-06-05 agent-use analysis provided by the
operator plus current `los` repo docs. The external counts for Codex, Claude,
Reasonix, OpenCode, and Gemini should be treated as external analysis input
until a future ingestion adapter redacts, validates, and stores provenance.

Current repo evidence consulted for this direction:

1. `AGENTS.md`
2. `SKILL.md`
3. `docs/README.md`
4. `docs/governance/periodic-analysis.md`
5. `docs/adr/0012-service-cluster-and-stateful-agent-roadmap.md`
6. `docs/adr/0014-testing-strategy-and-regression-gates.md`
7. `docs/adr/0016-omx-tool-level-logging-scope.md`
8. `docs/adr/0017-advisory-provider-promotion-playbook.md`
9. `docs/adr/0018-cli-fallback-gate.md`

## Current Judgment

The operator pattern is not "blind vibe coding." It is high-autonomy
AI-assisted engineering with evidence requirements:

1. agents may execute large parts of the workflow;
2. claims must be grounded in code, config, runtime, DB/API rows, tests, logs,
   or explicitly marked inference;
3. work often ends with validation, docs, version-control closeout, and
   residual-risk reporting;
4. durable lessons should move to the smallest owner layer that can enforce
   them.

That means the immediate `los` product goal is not full multi-agent autonomy.
The immediate goal is to make autonomous work inspectable, recoverable, and
gradable.

## Stage Design

### Stage A: Evidence Harness

Status: complete as of 2026-06-10. Evidence and residual risk are recorded in
`docs/governance/2026-06-10-stage-a-exit-audit.md`.

Goal: make a single agent run, provider probe, runtime check, or governance
review explainable from bounded evidence.

Required surfaces:

1. `task_runs` and `session_events` for `los`-owned execution;
2. operation smokes for live runtime proof;
3. compatibility harnesses for provider/model/tool-policy behavior;
4. docs and todos for unresolved drift;
5. external tool summaries only as redacted comparison input.

Exit criteria:

1. every current-state claim names its truth surface;
2. a run can be reviewed without relying on UI state alone;
3. periodic governance reports create owned follow-up items instead of loose
   observations.

### Stage B: Operator Contract Layer

Status: partially implemented early. `run_specs.run_contract_json`, mode/phase
metadata, plan revision, approval, verification requirements, and scheduler
completion gates exist. Remaining work is to make the operator contract
consistently visible in UI/CLI workflows and to keep eval coverage aligned with
the contract fields.

Goal: make the intended agent behavior explicit before the task starts.

Required contracts:

1. mode contract: audit, execution, or closeout;
2. completion contract: required checks, allowed skipped checks, and stop
   conditions;
3. scope contract: editable paths, owner layer, and legacy/project boundary;
4. closeout contract: diff review, validation evidence, commit boundary, and
   residual risks.

Exit criteria:

1. a governance report can say which mode was used;
2. todos can track missing contracts as a failure class;
3. repeated mode failures have eval candidates.

### Stage C: Personal Eval Corpus

Status: short-term to mid-term target.

Goal: turn repeated agent failure modes into 20-50 narrow eval cases before
adding more autonomy.

Initial eval families:

1. broad formatter modifies unrelated files in a dirty worktree;
2. runtime health inferred from config instead of process/API/DB truth;
3. provider readiness treated as compatibility proof;
4. ADR status repeated without reading current implementation;
5. external transcripts treated as `los` replay evidence;
6. `jj` repo judged from Git detached-HEAD state;
7. operation smoke not promoted into a regression test when it protects
   durable behavior;
8. task marked done from UI/todo state without persisted execution evidence;
9. legacy repo treated as an implementation target instead of a reference;
10. route, model, quota, credential, and cost truth flattened into one claim.

Exit criteria:

1. each eval has a trigger, bad-answer pattern, required evidence, passing
   pattern, and owner surface;
2. at least the highest-risk cases are represented in tests, harness probes,
   docs, or review checklists;
3. monthly governance reports update the backlog.

### Stage D: Stateful Runtime

Status: partially implemented early, aligned with ADR 0012. Durable run specs,
task runs, session events, stream checkpoints, tool-call recovery, verification
records, service heartbeat, and failover recovery surfaces exist. Remaining
work is to prove resume behavior across real interrupted `/chat` sessions and
to keep provider/model evaluation separate from runtime recovery evaluation.

Goal: move from audit-grade evidence to recovery-grade execution.

Required runtime work:

1. durable run specs;
2. stream replay;
3. run state transitions;
4. tool call state records;
5. eval metrics for success, latency, retries, tool errors, verification, cost,
   and user feedback.

Exit criteria:

1. `/chat` and scheduled runs are not tied to one gateway stream for review;
2. failed or interrupted work can be inspected and resumed through durable
   state;
3. provider/model changes can be evaluated without confusing them with runtime
   recovery changes.

### Stage E: Controlled Multi-Agent Execution

Status: partially implemented early. The DAG store, dependency claims, bounded
parallel execution, verifier tasks, provider/model task selection, and
procedural memory candidates exist. Remaining work is to harden graph-level
operator UX, provenance display, and eval comparisons before increasing
autonomy.

Goal: support planner, executor, and verifier roles without turning the runtime
into unconstrained peer chat.

Required sequencing:

1. finish run specs and state transitions first;
2. add a minimal DAG only after retry and verification states are observable;
3. let independent tasks run in parallel;
4. make verifier tasks capable of blocking completion;
5. use memory compression and procedural rule candidates only with evidence
   pointers and review gates.

Exit criteria:

1. a graph run shows dependencies, attempts, verifier outcomes, and final
   state;
2. procedural memory has provenance and owner-layer placement;
3. autonomy improvements can be compared with eval metrics.

## Operating Modes

### Audit Mode

Use for source-grounded review, architecture analysis, drift checks, and risk
reports.

Default behavior:

1. read-only first;
2. lead with findings and evidence;
3. do not patch unless the operator explicitly switches mode;
4. turn unresolved drift into a doc, ADR, test, or todo recommendation.

Stop condition: findings are supported by file paths, commands, runtime
surfaces, or named inference.

### Execution Mode

Use for bounded implementation work.

Default behavior:

1. inspect current source and owner layer;
2. make scoped edits;
3. update focused tests, harnesses, or docs when durable behavior changes;
4. run the minimum required gates from ADR 0014;
5. report diff scope and residual risk.

Stop condition: the requested change is implemented and verified, or the
blocked verification surface is named.

### Closeout Mode

Use when the task is to finish a phase, reconcile docs, clean a worktree, split
commits, publish, or confirm remote state.

Default behavior:

1. inspect `jj status` in `projects/los`;
2. separate unrelated dirty changes from the current closeout;
3. run required checks;
4. keep commits scoped to one bounded context;
5. verify remote state only when publishing is requested.

Stop condition: the worktree, validation state, and remaining risks are
reported with exact commands.

## Validation Contract Template

Before starting a larger task, use
`docs/governance/run-contract-template.md`.

That template should become a UI/CLI/task metadata shape only after the doc
workflow is stable and focused agent/gateway tests prove the fields.

## Toolchain Matrix

`los` should keep a lightweight matrix for external agent tools, but it should
not import their raw logs by default.

Track at least:

1. tool name and role;
2. default provider/model route when known;
3. permission and sandbox mode;
4. memory or transcript location;
5. evidence quality: raw transcript, summarized log, tool ledger, or no ledger;
6. when to use it;
7. when not to use it;
8. ingestion status: external-only, verified summary, or future adapter.

The first durable artifact is `docs/governance/toolchain-matrix.md`. A runtime
ingestion adapter requires a separate ADR and redaction contract.

## Implementation Mapping

| Goal | Current owner | Next owner |
| --- | --- | --- |
| Mode contracts | `docs/governance/agent-workflow-roadmap.md` + `docs/governance/run-contract-template.md` | task/todo metadata, then CLI/UI field if proven |
| Completion contract | ADR 0014 + `docs/governance/run-contract-template.md` | task/todo metadata |
| Toolchain matrix | `docs/governance/toolchain-matrix.md` | future redacted ingestion adapter ADR |
| Eval corpus | `docs/governance/eval-backlog.md` + todos | tests, compat harnesses, operation smokes |
| Runtime recovery | ADR 0012 + `run_specs`/`tool_call_states`/`verification_records`/runtime evidence graph + verifier/recovery core modules | API/CLI entrypoints, scheduler follow-up attempts, and DAG verifier tasks |
| Procedural learning | skills/docs/todos | memory compaction with review gate |
| Execution gap planning | `docs/governance/agent-execution-gap-plan.md` | future ADRs for run specs, tool state, provider evidence, or ingestion |

## Non-Goals

1. Do not store raw external transcripts, auth snapshots, browser cookies, API
   keys, or provider account dumps in `los`.
2. Do not promote every useful habit into a global skill.
3. Do not treat a toolchain matrix as proof of runtime behavior.
4. Do not add a CLI fallback because another tool exists; ADR 0018 still
   requires a capability gap, ledger parity, permission parity, budget, and an
   exit strategy.
5. Do not start with a full workflow engine before run specs, state
   transitions, and verification states are durable.
