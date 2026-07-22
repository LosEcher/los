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

Status: implemented. Current-state declaration in
`docs/adr/0021-stage-b-operator-contract-implemented-state.md`.

Goal: make the intended agent behavior explicit before the task starts.

#### Implemented

| Capability | Source | Test | Smoke |
|------------|--------|------|-------|
| `RunContractMetadata` (21 fields) | `packages/agent/src/run-contract.ts` | `run-contract.test.ts` (E14/E15/E16) | B0 smoke |
| `RunPhase` 10-state lifecycle + `PHASE_TRANSITIONS` | `run-contract.ts` | `scheduler.test.ts` (phase gate) | B0 smoke |
| `validatePhaseTransition()` | `run-contract.ts` | Via scheduler phase gate | — |
| `canStartExecution()` B0 gate | `run-contract.ts` | `scheduler.test.ts` | B0 smoke |
| `canMarkSucceeded()` verification gate | `run-contract.ts` | Via verification-records test | B0 smoke |
| `PlanStep` + `VerificationRequirement` types | `run-contract.ts` | `run-contract.test.ts` (E16) | — |
| `normalizeRunContractMetadata()` | `run-contract.ts` | `run-contract.test.ts` | — |
| `run_specs.run_contract_json` JSONB storage | `run-specs.ts` | `run-specs.test.ts` | B0 smoke |
| `approveRunSpecPhase()` operator approval | `run-specs.ts` | Indirect (scheduler phase gate) | — |
| `reviseRunSpecPlan()` plan revision + lineage | `run-specs.ts` | — | — |
| Scheduler B0 enforcement (pre-exec + pre-completion) | `scheduled-task-runner.ts` | `scheduler.test.ts` | B0 smoke |
| `POST /runs/:id/approve` | `gateway/run-routes.ts` | — | — |
| `POST /runs/:id/revise-plan` | `gateway/run-routes.ts` | — | — |
| `POST /runs/:id/verify` + `POST /runs/:id/recover` | `gateway/run-routes.ts` | `run-events-routes.test.ts` | Recovery smoke |
| CLI: `los run approve\|revise-plan\|verify\|recover` | `cli/run-operations.ts` | — | — |
| `contracts/run-spec.yaml` runContract definition | `contracts/` | — | — |
| Mode contract (audit/execution/closeout/governance) | `run-contract.ts` | `run-contract.test.ts` | — |
| Completion contract (required/allowed skips/stop conditions) | `run-contract.ts` | `run-contract.test.ts` | — |
| Scope contract (editable surfaces, owner layer) | `run-contract.ts` | Agent task graph/scheduler tests | — |
| Closeout contract (commit boundary, evidence) | `run-contract.ts` | `run-contract.test.ts` | — |
| Basic run contract propagation to child/executor runs | `agent-tools.ts`, `scheduled-task-runner.ts` | `registry.test.ts`, `scheduler.test.ts` | — |

#### Remaining Gaps

1. Direct unit tests for `approveRunSpecPhase()` and `reviseRunSpecPlan()`
2. Gateway route integration tests for `POST /runs/:id/approve` and `/revise-plan`
3. End-to-end smoke covering audit→execution→closeout full mode lifecycle
4. Durable child run-spec lineage and child attempt linkage
5. Active execution resume with attempt/retry contract
6. Phase latency and rejection metrics
7. Operator approval UI in Web console
8. Stop-condition runtime enforcement (types exist, enforcement does not)
9. Commit-boundary reporting automation

#### Exit Criteria

1. a governance report can say which mode was used — **satisfied** (mode persisted in run_contract_json)
2. todos can track missing contracts as a failure class — **satisfied** (todos store runContract metadata, E14 covers missing-contract case)
3. repeated mode failures have eval candidates — **satisfied** (E14/E15/E16 in eval backlog, covered by run-contract.test.ts)

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

Status: bounded baseline implemented as of 2026-07-22. The runtime supports
operator-created graphs with 2-4 workers, strict editable-surface ownership,
bounded parallel execution, dependency blocking, an independent verifier, and
an explicit integration owner. A persisted local smoke returned HTTP 200 with
three of three tasks succeeded and one legal graph-owned final transition; see
`docs/operations/2026-07-22-governed-agent-graph-smoke.md`.

This status does not mean general multi-agent autonomy is complete. Remaining
work is graph-level provenance display, interrupted-run recovery evidence,
serial-versus-graph eval comparison, and operator-reviewed live integration
before increasing scale or reducing consent gates.

Goal: support planner, executor, and verifier roles without turning the runtime
into unconstrained peer chat.

Required sequencing:

1. finish run specs and state transitions first — implemented;
2. add a minimal DAG only after retry and verification states are observable — implemented;
3. let independent tasks run in parallel — implemented with strict non-overlapping editable surfaces;
4. make verifier tasks capable of blocking completion — implemented and covered by success/failure regression tests;
5. use memory compression and procedural rule candidates only with evidence
   pointers and review gates.

Exit criteria:

1. a graph run shows dependencies, attempts, verifier outcomes, and final
   state — satisfied in the gateway read model and persisted smoke evidence;
2. procedural memory has provenance and owner-layer placement;
3. autonomy improvements can be compared with eval metrics.

### Stage F: Pluggable Execution Kernel And Pi Adoption

Status: architecture decision accepted and K1 completed on 2026-07-22.
ADR 0039 and `contracts/execution-kernel.yaml` define LOS as the authoritative
governance harness and Pi as the first external execution-kernel candidate.
`packages/agent/src/execution-kernel.ts` now wraps the current LOS loop, and the
gateway-local scheduler path calls it while recording exact kernel provenance.
`kernel-event-projection.ts` now persists bounded audit evidence to the existing
`session_events` ledger without duplicating raw transcript, tool arguments, or
checkpoint contents. The current loop now executes through `LosToolBroker`,
preserving phase, pre-action, capability, state, retry, and evidence controls.
The scheduler and executor resolve the same fail-closed registry, while HTTP
and SSH transports carry the selected kind and return canonical kernel events
for scheduler-owned projection. K2a now pins Pi `0.81.1`, aligns the Node engine
floor, and provides an unregistered deterministic adapter with faux-provider
golden traces. K2b now maps LOS-resolved provider/auth/model inputs, canonical
history, and the governed tool catalog; a bounded live DeepSeek probe passed.
The Pi transport also records LOS-owned provider-call telemetry. Unsupported
fallback, architect-editor, context, model-setting, and child-execution
semantics now have explicit fail-closed or LOS-owned decisions. K3 adds an
explicit read-only scheduler shadow with derived evidence lineage; its first
live no-tool DeepSeek comparison completed with equal output hashes and no
tools. Corrected corpus `1.0.1` and rubric `pi-shadow-readonly-v1` preregistered five
scenario families and 17 required observations. The first full corpus run is
complete with 16 passing and one failing observation; the failure is in
the live read-only-tool output-hash assertion, while tool sequence, successful
tool state, terminal state, and isolated lineage passed. The report therefore
remains `collecting`; corpus `1.1.0` / rubric `pi-shadow-readonly-v2` then
completed 14/17 against candidate `0.81.1`, exposing two real candidate reads
versus one LOS read in every live tool scenario. Candidate `0.81.1+los.1` maps
the profile parallel-tool policy and has no observations; the pre-corpus smoke and superseded corpus `1.0.0` remain
ignored, and K4
policy review is blocked. Pi remains unavailable as a selected production
kernel. The current LOS loop stays the production baseline until a
preregistered evaluation revision, canary, formal pairwise evaluation, and
rollback gates pass.

Goal: consume Pi's provider and turn-loop improvements without moving Work Item,
RunContract, policy, tool execution, durable evidence, recovery, verification,
or final-transition ownership out of LOS.

Required sequencing:

1. wrap the current loop behind a provider-neutral `ExecutionKernel` protocol;
2. route all kernel tool requests through an LOS-owned ToolBroker;
3. add an exact-version Pi adapter with deterministic golden traces;
4. run read-only shadow and canary comparisons before project writes;
5. admit managed-workspace and graph-worker execution only after AP, lease,
   transcript, and verifier parity;
6. promote Pi by preregistered pairwise evidence, not by dependency wiring;
7. retain `LosKernelAdapter` as rollback and future replacement candidate.

Exit criteria:

1. gateway and scheduler use no Pi-native event, message, or checkpoint types;
2. every attempt records exact kernel and protocol provenance;
3. Pi cannot write LOS state or execute tools outside ToolBroker;
4. deterministic and real-task pairwise evidence covers completion, recovery,
   operator intervention, governance violations, cost, and latency;
5. default promotion has a per-run rollback and an accepted observation window.

The owning migration record is
`docs/governance/2026-07-22-lsclaw-los-pi-kernel-migration-plan.md`. The parent
daily-agent product remains in progress until its existing Web-first acceptance
and graph integration work plus the kernel baseline are complete.

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
| Mode contracts | `run-contract.ts` + `run_specs.ts` + ADR 0021 | CLI/UI entrypoints, Web approval UI |
| Completion contract | `run-contract.ts` (canStartExecution, canMarkSucceeded) + `scheduled-task-runner.ts` (B0 gate) + ADR 0014 | Stop-condition runtime enforcement, commit-boundary automation |
| Scope contract | `run-contract.ts` (editableSurfaces, ownerLayer) + agent task graph/scheduler | — |
| Toolchain matrix | `docs/governance/toolchain-matrix.md` | future redacted ingestion adapter ADR |
| Eval corpus | `docs/governance/eval-backlog.md` + todos | tests, compat harnesses, operation smokes |
| Runtime recovery | ADR 0012 + `run_specs`/`tool_call_states`/`verification_records`/runtime evidence graph + verifier/recovery core modules | API/CLI entrypoints, scheduler follow-up attempts, and DAG verifier tasks |
| Procedural learning | skills/docs/todos | memory compaction with review gate |
| Execution gap planning | `docs/governance/agent-execution-gap-plan.md` | future ADRs for run specs, tool state, provider evidence, or ingestion |
| Module readiness | `docs/governance/module-readiness.md` + `tools/check-readiness.sh` | `todo-los-provider-config-crud-readiness` for provider create/update/delete tests and Web state alignment |

## Current Short-Term Work Items

2026-06-19 architecture inventory produced one actionable readiness gap:

1. Providers module is not ready to be treated as fully `live` even though
   `packages/web/src/App.tsx` currently marks the NAV item as `live`.
2. Code evidence shows `PATCH /providers/:name` and `DELETE /providers/:name`
   exist, but `POST /providers`, CRUD lifecycle route tests, and Web write
   controls are still missing.
3. The owner todo is `todo-los-provider-config-crud-readiness`; the tracking
   checklist lives in `docs/governance/module-readiness.md`.

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
