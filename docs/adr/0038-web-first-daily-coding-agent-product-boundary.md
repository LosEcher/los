# ADR 0038: Web-first Daily Coding Agent Product Boundary

- Status: Accepted
- Date: 2026-07-21

## Background

Cursor's July 2026 agent-swarm report showed that useful multi-agent scale came
from bounded task decomposition, shared decisions, independent review, and a
version-control model that reduced duplicate work and conflicts. The result does
not establish that a large swarm is the correct first step for LOS: the SQLite
task had unusually complete documentation and an automated held-out evaluator.

LOS already persists the main records needed for governed agent execution:
Work Items in `todos`, immutable execution input in `run_specs`, attempts in
`task_runs`, interaction evidence in `sessions` and `session_events`, required
checks in verification records, and isolated changes in managed jj workspaces.
The current default product paths do not yet compose those records into one
daily coding workflow:

1. `/chat` creates a run spec and immediately dispatches one scheduled task.
2. ordinary Chat requests may omit a run contract;
3. Work Item execution enters Chat with a draft contract, but a standard
   contract in `created` or `planning` cannot pass the scheduler's AP2 execution
   gate;
4. planning output is emitted as text and is not yet persisted as structured
   `PlanStep[]` evidence before approval;
5. review, verification, revision, and workspace integration exist as separate
   capabilities rather than one default user path.

The product direction therefore needs to distinguish the immediate replacement
target from later breadth and swarm work.

## Decision

LOS will first become a **Web-first, persistent, verifiable daily coding and
project agent**. The first replacement target is the core daily workflow of Pi
and Codex. Hermes-style messaging-channel, consumer-tool, media, browser, and
remote-backend breadth remains a separate product track.

The primary Web path is a Work Item lifecycle, not an unstructured write-enabled
chat session:

```text
goal intake
  -> contract draft
  -> planning attempt
  -> persisted structured plan
  -> operator approval
  -> execution attempt
  -> required verification
  -> managed workspace diff review
  -> accept or revise
  -> persisted resume
```

Direct Chat remains available for conversation and bounded lightweight work.
A project-write request that needs standard or heavyweight execution must be
bound to a Work Item and run contract before code execution starts. The Web UI
may make that binding low-friction, but it must not synthesize `plan_approved`
or treat client state as execution truth.

## Record Ownership

The daily workflow composes existing records instead of adding a second state
machine:

| Concern | Source of truth |
| --- | --- |
| User goal and current product status | Work Item in `todos` |
| Scope, plan, checks, and stop conditions | `run_specs.run_contract_json` |
| Planning, execution, verification, and recovery attempts | `task_runs` |
| Conversation and operator actions | `sessions` and `session_events` |
| Required-check outcomes | verification records |
| Isolated code changes and reviewable diff | managed jj workspace and artifacts |
| Work-to-run history | `work_item_runs` |

One Work Item may own multiple run specs. A plan revision or recovery attempt
must preserve lineage; it must not overwrite a historical attempt or infer
success from the latest assistant message.

## Planning Boundary

Planning is a first-class, non-writing attempt rather than an exception to the
execution gate.

1. A planning attempt may inspect the declared workspace with read-only tools.
2. It must return structured `PlanStep[]` plus the verification mapping needed
   by `approveRunSpecPhase()`.
3. The plan is persisted while the run remains in `planning`.
4. Planning completion leaves the planning `task_run` blocked with reason
   `planning_awaiting_approval` and creates `approval_required`; it does not
   mark the Work Item, task attempt, or run spec succeeded.
5. Code-writing tools remain unavailable until the persisted phase is
   `plan_approved`.
6. Approval dispatches or resumes a distinct execution attempt using the
   persisted contract.

This requires a dedicated planning disposition in the scheduler/coordinator.
It must not weaken `canStartExecution()` or label a standard coding task as
`lightweight` merely to bypass AP2.

## Delivery Order

### P0: One Reliable Daily Agent Loop

1. make planning a supported scheduled disposition and persist structured plan
   evidence;
2. route a new Web coding goal through Work Item intake by default;
3. dispatch execution after approval without requiring the user to reconstruct
   request parameters;
4. run required verification and expose its records with the workspace diff;
5. turn `revision_requested` and failed verification into a persisted revised
   plan or recovery attempt;
6. resume every step from database evidence after process or browser restart.

### P1: Quality And Model Economics

Build a scenario corpus for the P0 path and measure completion, elapsed time,
model cost, retries, verification failures, and operator interventions. Planner,
worker, and reviewer model routing may become automatic only after these
scenarios show a policy is better than the configured baseline. Requested and
effective provider/model values remain separately recorded.

### P2: Small Governed Task Graphs

Introduce dynamic graphs for tasks that benefit from decomposition, initially
with two to four workers, non-overlapping editable surfaces, an independent
verifier, and an explicit integration owner. General parallel graph creation,
neutral conflict reconciliation, and automatic workspace integration are not
prerequisites for P0.

### Separate Track: Hermes Breadth

Installer/desktop packaging, broad messaging channels, consumer browser/media
tools, and additional remote execution backends require their own product
contracts and acceptance evidence. They do not delay the daily coding path and
must not change its state ownership.

## Module Placement

- `contracts/task-intake.yaml`, `contracts/run-spec.yaml`, and
  `contracts/work-item.yaml` own public contract changes.
- `packages/agent` owns planning disposition, plan persistence, task attempts,
  verification, recovery, and graph execution.
- `packages/gateway` owns authenticated intake, approval, dispatch, and replay
  routes.
- `packages/web` owns the Work-first interaction and evidence presentation.
- `packages/infra` remains limited to shared DB/config/logger primitives and
  migrations; no new infra module is authorized by this ADR.

## Non-goals

This decision does not authorize:

1. a 1000-agent or unrestricted parallel swarm;
2. heuristic provider/model promotion without scenario evidence;
3. automatic acceptance, merge, push, bookmark deletion, or release;
4. automatic memory or skill promotion;
5. replacing PostgreSQL evidence with transcript summaries;
6. building a full TUI, SDK, extension marketplace, or Hermes-compatible
   channel catalog before the P0 Web path is validated.

## Evaluation And Acceptance

The P0 path is not considered a Codex/Pi replacement from implementation
evidence alone. A representative scenario corpus must report, per scenario:

- completion and required-verification result;
- elapsed and operator-wait time;
- planning, execution, retry, and revision attempt counts;
- requested and effective provider/model;
- token and estimated cost by role;
- operator steering, approval, and correction count;
- diff acceptance or revision outcome;
- recovery result after an interrupted run.

The replacement claim requires repeated daily evidence with no bypass of AP1,
AP2, or AP3. Hermes breadth is evaluated independently.

## References

- `docs/adr/0025-conversation-run-coordinator-boundary.md`
- `docs/adr/0033-web-first-work-item-read-model.md`
- `docs/adr/0037-daily-agent-quality-snapshots.md`
- `docs/governance/2026-07-19-web-first-daily-agent-workflow-design.md`
- `docs/governance/2026-07-18-los-pi-harness-capability-and-operability-audit.md`
- `contracts/agent-task-graph.yaml`
- <https://cursor.com/blog/agent-swarm-model-economics>
