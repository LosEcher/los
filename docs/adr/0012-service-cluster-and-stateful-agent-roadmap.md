# ADR 0012: Service Cluster And Stateful Agent Roadmap

## Status

Partially implemented.

As of 2026-06-02:

1. Phase 1 is implemented for the service registry, gateway heartbeat,
   `/live`, `/ready`, `/services`, drain, promote, and service-route tests.
2. Phase 2 has a readiness baseline smoke for two gateways sharing PostgreSQL,
   but it has not validated real `/chat` failover or cross-gateway stream
   replay.
3. Phases 3-7 remain roadmap work.

## Background

ADR 0008 defined the first execution order as single-node but mesh-ready. ADR
0010 separated node connectivity, node capability, and probe verification. ADR
0011 then separated four runtime contracts:

1. agent run surface
2. node registry surface
3. node operations surface
4. artifact transfer surface

The next design question is broader than executor node failover. `los` also
needs service-level failover: if a gateway or service process fails, another
service instance should be able to accept new requests and keep the durable
state readable.

There is a second related direction: mature agent systems are not only
`LLM + prompt`. The stable shape is closer to:

```text
LLM
+ state machine
+ task graph
+ memory layers
+ scheduler
+ tool runtime
+ verification
+ feedback metrics
```

For `los`, these two directions should be handled together. Service failover
without durable agent state only moves new HTTP requests. Stateful agent
execution without service failover still leaves the gateway as a single
operational point.

## Current State

The current implementation already has useful pieces:

1. PostgreSQL is the only los-owned persistence backend.
2. `task_runs` records task lifecycle, node ownership, heartbeat, and lease.
3. `session_events` is an append-only event ledger.
4. `idempotency_keys` can replay completed `/chat` responses when callers use
   idempotency headers.
5. `executor_nodes` records executor visibility, node kind, connect modes,
   capabilities, verification state, rollout state, queue depth, and active
   task count.
6. The local executor exposes `/health`, `/v1/tasks/run-agent`,
   `/v1/artifacts`, and node command endpoints.
7. Gateway-local execution and local executor execution both write task and
   session evidence.

The current implementation is still missing several cluster-grade pieces:

1. Service visibility currently covers gateway instances. Web, scheduler,
   artifact proxy, and worker services are still future service kinds.
2. `/live`, `/ready`, `/services`, drain, and promote exist, but no production
   load balancer or routing config consumes readiness yet.
3. Gateway startup recovery has advisory-lock protection in code and tests, but
   concurrent production startup recovery still needs a live multi-gateway
   validation record.
4. `/chat` still runs as a request-bound stream. A gateway crash interrupts the
   live stream even though durable evidence remains in PostgreSQL.
5. `task_runs` stores a prompt preview, not a full durable run spec. Another
   service cannot safely re-run or resume a task without the original execution
   contract.
6. Tool execution emits events, but the tool call lifecycle is not yet its own
   durable state machine.
7. Memory exists as observations and session events, but working, episodic,
   semantic, and procedural memory are not yet separate retrieval surfaces.
8. There is no first-class DAG/task graph model. Current execution is still a
   single scheduled agent run.
9. Evaluation exists as compatibility probes and operation smokes, not as a
   unified success, latency, cost, retry, and quality metrics surface.

## Inference

If `los` only adds more executor nodes, it improves compute placement but does
not protect the user-facing gateway service.

If `los` only adds more gateway services, it can route new requests around a
failed process, but active agent work remains fragile because `/chat` is still
tied to one streaming request.

If `los` jumps directly to a full graph/workflow engine, it will add too many
new contracts before the current run, node, service, and tool states are stable.

The safer path is staged:

1. Make services visible and drainable.
2. Make run specs durable.
3. Move live streams from request ownership to event replay.
4. Add state machines around run and tool execution.
5. Add DAG scheduling only after state and recovery are observable.

## Decision

`los` should add a service cluster plane and evolve agent execution through a
stateful upgrade path.

The target architecture has three runtime planes:

1. **Service plane**
   - Owns gateway, web, scheduler, artifact proxy, and future API service
     instances.
   - Tracks liveness, readiness, drain state, service role, version, priority,
     capabilities, and service-level load.

2. **Execution plane**
   - Continues to use `executor_nodes`.
   - Owns agent task execution, executor heartbeat, task lease, artifact
     endpoints, and node command runners.

3. **Run orchestration plane**
   - Owns durable run specs, run state, tool state, task graph, checkpoints,
     retries, verification, and evaluation metrics.
   - Starts simple and remains PostgreSQL-first.

The design rule is:

```text
service availability protects request entry
executor availability protects compute placement
run state protects recovery and quality
```

## Service Cluster Model

### `service_instances`

Add a new store owned by `packages/agent` or a small shared runtime package:

```text
service_id          stable instance id
service_kind        gateway | web | scheduler | artifact_proxy | worker
node_id             physical or virtual host node, optional
host_label          human-readable host label
bind_url            local bind URL
public_url          URL reachable by peers or load balancer
status              online | draining | offline
role                active | standby | worker
version             running version
target_version      rollout target
rollout_state       idle | draining | upgrading | verifying | failed
capabilities_json   chat_api, web_ui, scheduler, artifact_proxy, node_registry
health_json         db_ok, provider_config_ok, executor_registry_ok
load_json           active_requests, active_streams, queued_runs
priority            lower number wins for active routing
region              optional region or network zone
last_heartbeat_at
last_probe_at
last_probe_error
metadata_json
created_at
updated_at
```

This is intentionally separate from `executor_nodes`. A machine may run both a
gateway service and an executor node, but service availability and executor
eligibility are different claims.

### Health Endpoints

Gateway should expose three checks:

1. `/live`
   - Process is alive.
   - Does not check PostgreSQL or providers.
   - Used by local supervisors.

2. `/ready`
   - Service can accept new requests.
   - Requires status not `draining`, PostgreSQL reachable, schema initialized,
     and required runtime dependencies healthy enough for configured mode.
   - Used by load balancers and mesh ingress.

3. `/health`
   - Backward-compatible summary.
   - Should include `serviceId`, `serviceKind`, `status`, `ready`, `uptime`,
     and dependency summaries.

### Drain Rule

`draining` means:

1. `/live` remains OK.
2. `/ready` returns non-ready.
3. New `/chat` and write-heavy requests should be rejected or redirected by the
   load balancer.
4. Existing streams may continue until completion or configured timeout.
5. Service heartbeat continues so operators can see the drain state.

## Stateful Agent Model

The agent upgrade should treat model calls as one part of a controlled runtime,
not as the runtime itself.

### Run State Machine

Introduce durable run states before introducing a full DAG scheduler:

```text
created
analyzing
planned
queued
running
verifying
retrying
succeeded
failed
cancelled
```

Minimum state transition evidence:

```text
run_id
task_run_id
session_id
state_before
state_after
reason
service_id
executor_node_id
request_id
trace_id
created_at
```

The first implementation can project these states from `task_runs` and
`session_events`. A separate `run_state_events` table should be added before
state transitions become scheduler inputs.

### Durable Run Specs

Add `run_specs` before retry or cross-service resume:

```text
run_id
session_id
tenant_id
project_id
user_id
request_id
trace_id
prompt
system_prompt
provider
model
workspace_root
tool_mode
allowed_tools_json
tool_retry_json
executor_hints_json
metadata_json
created_at
```

`task_runs` should represent attempts. `run_specs` should represent the desired
work. This separation is required for failover, replay, retry, and eval.

### Task Graph

Do not introduce a complex graph engine first. Add a minimal DAG only after run
specs and state transitions are durable.

Suggested tables:

```text
agent_tasks
task_edges
task_attempts
```

Minimum semantics:

1. A task has a stable id, kind, priority, status, and run id.
2. A task edge represents a dependency.
3. Scheduler can claim only ready tasks whose dependencies succeeded.
4. Failed tasks can retry according to policy.
5. Verification tasks can block completion.

This allows research, code, test, and verification work to run in parallel
without turning all agents into a peer-to-peer chat system.

### Memory Layers

Separate memory by purpose:

1. **Working memory**
   - Current run state, recent tool results, open questions, partial plan.
   - Lifetime: one run or one session.
   - Storage: `run_state`, `session_events`, or a compact working-memory table.

2. **Episodic memory**
   - Prior sessions, task outcomes, failures, user decisions.
   - Lifetime: days or months.
   - Storage: existing `session_events` and observations.

3. **Semantic memory**
   - Stable facts: project structure, user preferences, architectural decisions.
   - Lifetime: long-term.
   - Storage: observations plus curated project docs.

4. **Procedural memory**
   - Repeatable workflows: how to debug a provider issue, how to verify node
     connectivity, how to recover a failed rollout.
   - Lifetime: long-term.
   - Storage: skills, ADRs, operation docs, and later a procedural memory index.

Memory should be compressed, not appended blindly. A later memory compactor
should convert repeated events into stable rules with evidence pointers.

### Tool Runtime State

Tool calls should become stateful records:

```text
tool_call_id
run_id
task_run_id
tool_name
state              requested | running | succeeded | failed | retrying | skipped
input_hash
input_json
output_summary_json
error
attempt
idempotent
retry_policy_json
started_at
completed_at
```

This is the difference between "the model asked for a tool" and "the runtime
can recover or audit a tool execution".

### World State

Introduce a compact run world state after tool state exists:

```json
{
  "project": {
    "workspaceRoot": "...",
    "changedFiles": [],
    "testStatus": "unknown"
  },
  "env": {
    "gatewayReady": true,
    "databaseReachable": true
  },
  "run": {
    "state": "running",
    "openQuestions": [],
    "verificationRequired": true
  }
}
```

World state must be derived from events and probes where possible. It should not
replace the source events.

### Verification And Eval

Verification should be a required state for durable work:

1. Code work: focused tests, typecheck, contract check, or documented inability
   to run.
2. Node work: health, heartbeat, candidate state, command evidence.
3. Service work: `/ready`, service heartbeat, failover probe.
4. Provider/model work: compatibility harness and session event ledger.
5. Docs/design work: source references, explicit open questions, task split.

Eval metrics should be stored separately from raw events:

```text
run_id
task_run_id
success
latency_ms
model_cost
retry_count
tool_error_count
verification_status
user_feedback
created_at
```

## Progressive Upgrade Plan

### Phase 0: Analysis And Baseline

Goal: prove the current truth surfaces before changing contracts.

Tasks:

1. Inventory current gateway, executor, PostgreSQL, and node registry state.
2. Split current mixed `node34` identity into separate MBP executor and VM SSH
   target records before using node data for failover decisions.
3. Document which surfaces are configured state, runtime state, DB truth, probe
   truth, and client-observed behavior.
4. Define service id conventions:
   - `mbp-gateway-1`
   - `mbp-executor-1`
   - `node34-ssh`
   - future `node34-gateway-1` or `node34-executor-1`
5. Add operation smoke expectations for gateway readiness and executor
   candidate selection.

Upgrade condition:

1. `pnpm check` passes.
2. Current `/nodes` no longer conflates MBP local executor with node34 VM.
3. Gateway and executor health checks are recorded with exact URLs.
4. PostgreSQL URL and schema initialization are verified.

### Phase 1: Service Registry And Readiness

Goal: make service processes visible and drainable.

Tasks:

1. Add `service_instances` store and types.
2. Add gateway service heartbeat on startup and periodic interval.
3. Add `/live`, `/ready`, and expanded `/health`.
4. Add service drain/promote commands.
5. Add service registry API:
   - `GET /services`
   - `GET /services/:id`
   - `POST /services/:id/drain`
   - `POST /services/:id/promote`
6. Add read-only Service tab or Mesh page.

Upgrade condition:

1. One gateway self-registers as `online`.
2. Drain makes `/ready` fail while `/live` remains OK.
3. Promote restores `/ready`.
4. Service status survives process restart through PostgreSQL evidence.
5. Tests cover readiness, drain, and stale heartbeat classification.

### Phase 2: Multi-Gateway Entry

Goal: allow multiple gateway services to accept new requests safely.

Tasks:

1. Run two gateway instances on different ports or hosts against the same
   PostgreSQL.
2. Ensure schema initialization is idempotent under concurrent startup.
3. Add advisory lock or leader guard for startup recovery jobs that must not
   run concurrently.
4. Add load balancer or local routing config that uses `/ready`.
5. Add failover smoke: stop or drain gateway A, prove gateway B accepts new
   `/chat`, `/sessions`, `/tasks`, `/nodes`, and `/services` requests.

Upgrade condition:

1. Two gateways are visible in `service_instances`.
2. Draining one gateway removes it from readiness routing.
3. New requests succeed on the other gateway.
4. Idempotent `/chat` replay works through either gateway.
5. No duplicate recovery events are written during concurrent startup.

### Phase 3: Durable Run Specs And Stream Replay

Goal: decouple user-facing streams from one gateway process.

Tasks:

1. Add `run_specs`.
2. Make `/chat` create or reuse a durable run spec before execution.
3. Add `GET /runs/:id/events?since=...`.
4. Add SSE reconnect support using stored session/run events.
5. Persist stream checkpoints for model deltas and tool events.
6. Add CLI/browser reconnect behavior that can resume display after gateway
   switch.

Upgrade condition:

1. A run can be inspected without the original HTTP stream.
2. A client can reconnect through a different gateway and read prior events.
3. Idempotency returns the same run id instead of duplicating work.
4. Active request interruption no longer hides already-written evidence.

### Phase 4: Run State Machine And Tool State

Goal: constrain execution and make retries auditable.

Tasks:

1. Add run state transitions.
2. Add tool call state records.
3. Route tool execution through state transitions:
   - requested
   - running
   - succeeded
   - failed
   - retrying
4. Add retry policy at tool runtime first, then task runtime.
5. Add verification state before marking durable work complete.

Upgrade condition:

1. Every run has a final state.
2. Every tool call has a state record or explicit skip reason.
3. Failed tool calls can be retried without losing attempt evidence.
4. Verification failure produces a retry or failed state, not a silent success.

### Phase 5: DAG Scheduler

Goal: move from one linear agent run to task graph execution.

Tasks:

1. Add minimal `agent_tasks`, `task_edges`, and `task_attempts`.
2. Add ready-task claim query with dependency checks.
3. Add priority, confidence, cost, deadline, and retry scoring fields.
4. Allow independent tasks to run in parallel.
5. Add verifier tasks as graph nodes.

Upgrade condition:

1. DAG execution can run at least two independent tasks in parallel.
2. A failed dependency blocks downstream tasks.
3. Retry policy is visible in task attempts.
4. Completion requires verifier success when a verifier exists.

### Phase 6: Memory Compression And Procedural Learning

Goal: reduce context size and preserve reusable lessons.

Tasks:

1. Add memory layer labels for working, episodic, semantic, and procedural
   records.
2. Add a compaction job that summarizes repeated failures and successes into
   candidate rules with evidence pointers.
3. Keep human approval or review gate before promoting procedural rules.
4. Add retrieval policy that selects memory by task state and run kind.

Upgrade condition:

1. Retrieval does not blindly append all prior memory.
2. Compacted rules cite source evidence.
3. Procedural memory is separated from user preference and project facts.
4. Prompt context size can be measured before and after retrieval.

### Phase 7: Evaluation And Quality Gates

Goal: optimize agent quality with metrics rather than model changes alone.

Tasks:

1. Add run eval records. Minimal `run_evals` records now exist.
2. Track success, latency, retry count, tool error count, verification status,
   model cost, and user feedback. These fields are present in the minimal
   record/list surface.
3. Add compatibility probes for service failover, run replay, tool retry, and
   DAG recovery.
4. Add dashboards or API views for failure causes. A summary API/CLI view now
   exists; UI dashboarding remains future work.

Upgrade condition:

1. A release can compare quality before and after a runtime change.
2. Failed runs can be grouped by cause.
3. Service failover and executor failover have separate metrics.
4. Model/provider changes can be evaluated without confusing them with runtime
   changes.

## Scheduler Policy Direction

The scheduler should not become "many agents chatting". It should stay a
controlled runtime.

Recommended hierarchy:

```text
coordinator
planner
executor
verifier
```

Scoring can start simple:

```text
score = priority * confidence / estimated_cost
```

Later fields:

1. deadline
2. retry budget
3. node capability
4. service readiness
5. tool availability
6. model/provider cost
7. historical success rate

## Non-Goals

1. Do not replace PostgreSQL with an embedded local-only mode.
2. Do not treat gateway service availability as executor eligibility.
3. Do not treat SSH reachability as agent execution capability.
4. Do not add full DAG scheduling before durable run specs and state
   transitions.
5. Do not claim live task migration until run specs, checkpoints, and stream
   replay are implemented.
6. Do not promote memory compaction output into procedural rules without
   evidence and review.
7. Do not optimize by changing model/provider first when state, verification,
   scheduling, or recovery evidence is missing.

## First Implementation Slice

The first bounded implementation slice was Phase 1:

1. `packages/agent/src/service-instances.ts`
2. gateway heartbeat from `packages/gateway/src/server.ts`
3. `/live`, `/ready`, expanded `/health`
4. `GET /services`
5. `POST /services/:id/drain`
6. `POST /services/:id/promote`
7. service registry tests
8. one operation smoke doc

This did not change `/chat` execution. It created the evidence surface required
before multi-gateway failover.

## Implementation Status

Evidence checked on 2026-06-02:

| Area | Status | Evidence |
|------|--------|----------|
| `service_instances` store | Implemented | `packages/agent/src/service-instances.ts` |
| `/live` and `/ready` | Implemented | `packages/gateway/src/service-routes.ts` |
| `GET /services` and `GET /services/:id` | Implemented | `packages/gateway/src/service-routes.ts` |
| Drain/promote commands | Implemented | `POST /services/:id/drain`, `POST /services/:id/promote` |
| Service route tests | Implemented | `packages/gateway/src/service-routes.test.ts` |
| Multi-gateway readiness smoke | Partially implemented | `docs/operations/2026-06-01-multi-gateway-readiness-smoke.md` |
| Real `/chat` failover | Not validated | The smoke explicitly excludes real `/chat` model execution |
| Cross-gateway stream replay | Not implemented | Requires durable `run_specs` and replay endpoints |
| DAG scheduler / memory compaction / eval metrics | Partially implemented | DAG store, dependency claim, verifier tasks, UI read model, editable-surface checks, bounded parallel claims, provider/model graph-task selection from compat evidence, minimal `run_evals` record/list surfaces, and eval summary API/CLI views exist; memory compaction, first-class release comparison, UI dashboards, and failover-specific metrics remain roadmap work |

## Verification

Minimum verification for the first slice:

```bash
pnpm check
./tools/check-contracts.sh
curl -fsS http://127.0.0.1:8080/live
curl -fsS http://127.0.0.1:8080/ready
curl -fsS http://127.0.0.1:8080/services
```

Additional smoke:

1. Drain gateway and confirm `/ready` is non-ready.
2. Promote gateway and confirm `/ready` is ready again.
3. Restart gateway and confirm service heartbeat returns with the same service
   id or a clearly new instance id according to the configured policy.
4. Confirm executor node candidate selection is unchanged by service registry
   changes.

## Open Questions

1. Should service ids be configured explicitly, generated from host plus port,
   or both?
2. Should service registry live in `packages/agent` or a new runtime package?
3. Should startup recovery use PostgreSQL advisory locks immediately in Phase 1,
   or wait until Phase 2 multi-gateway validation?
4. Should `/chat` continue to be the primary run creation endpoint after
   `run_specs`, or should a new `/runs` API become canonical?
5. Which service should own future DAG scheduling: gateway, a dedicated
   scheduler service, or executor-side workers?
