# ADR 0011: Node Operations And Artifact Transfer

## Status

Proposed.

## Background

ADR 0008, ADR 0009, and ADR 0010 set the direction for moving from one local
agent process to mesh-ready execution:

1. A single-node deployment is still a mesh deployment with one active node.
2. `los` client commands should submit run specs and read event streams.
3. `los-node` should execute assigned work and report heartbeat, lease, and
   result evidence.
4. Node connectivity, node capability, and probe verification must stay
   separate.

The implementation has already moved beyond the first written plan. The current
code has:

1. `executor_nodes` with `node_kind`, `connect_modes`, `capabilities`,
   `verified`, rollout state, queue depth, and active task count.
2. An executor process with `/health` and `/v1/tasks/run-agent`.
3. Scheduler support for gateway-local execution and executor HTTP/NDJSON
   execution.
4. Agent tools for workspace file read/write, patch, directory listing, and
   shell execution.
5. A local `tools/executor.sh upgrade` flow that drains, restarts, verifies,
   promotes, and marks the node idle.

## Current State

The current runtime has four truth surfaces that must not be merged:

1. **Agent run surface**
   - Owned by `RunSpec`, `RunStream`, `task_runs`, and `session_events`.
   - Executes prompt-driven work through `runAgent()`.
   - May use `run_shell`, but only inside the configured tool policy.

2. **Node registry surface**
   - Owned by `executor_nodes`.
   - Records liveness, node classification, connectivity, capability, probe
     state, queue pressure, and rollout state.
   - Node visibility does not imply scheduler eligibility.

3. **Node operations surface**
   - Owns maintenance actions such as status, probe, drain, promote, restart,
     upgrade, and rollback.
   - These actions are not prompt-level agent tools.

4. **Artifact transfer surface**
   - Owns file movement between gateway, local executor, and remote executor.
   - Transfers must be audited with task/session/node evidence and checksum
     data.

## Inference

If node maintenance commands are exposed as generic shell execution, then
`workspace:shell` becomes equivalent to node administration. That would make
agent task permission and operations permission indistinguishable.

If file transfer is handled through ad hoc `scp`, `curl`, or `run_shell`, then
large artifacts, checksums, retry, path safety, and task/session evidence become
hard to recover after weak-network failures.

If remote executor is introduced before these two surfaces are separated, every
later node capability change will need to reinterpret historical `task_runs`
and `session_events`.

## Decision

`los` will keep four contracts separate:

1. `los.run-spec`
   - Prompt, provider/model, workspace, tool mode, session, trace, tenant,
     project, user, request, and executor hints.

2. `los.run-stream`
   - Active SSE/NDJSON stream and replayable session/task/model/tool events.

3. `los.node-command`
   - Allowlisted operational commands for node lifecycle and rollout.
   - Not available through normal agent `run_shell`.

4. `los.artifact-transfer`
   - Put/get/list/delete for audited file and artifact movement.
   - Uses normalized paths, checksums, size metadata, and optional chunking.

`los.node-registry` remains the node visibility and scheduler eligibility
contract. Scheduler candidate selection must continue to require:

1. `node_kind=executor`
2. online status
3. fresh heartbeat
4. runnable `agent_http` or `agent_http_ndjson`
5. `capabilities.run_agent=true`
6. positive verification for the selected connect mode

## Execution Model

### Local Execution

Local execution has two valid forms:

1. `gateway-local`
   - Gateway calls `runAgent()` directly.
   - Useful for development and fallback.
   - `task_runs.node_id` should remain explicit as `gateway-local`.

2. local `los-node`
   - Gateway schedules through `agent_http_ndjson`.
   - The local executor runs the same agent loop outside the gateway process.
   - This is the first mesh-ready execution target.

The local `los-node` path is the validation target before any remote node is
trusted.

### Remote Execution

The first remote executor version should support only one execution protocol:

1. `agent_http_ndjson`
2. shared node auth key or stronger future node identity
3. executor heartbeat into `executor_nodes`
4. task lease renewal while work is active
5. streamed session events back to gateway

Tailscale, Cloudflare Tunnel, and SSH may provide connectivity, but they do not
make a node executable by themselves. They should enter the registry as
connectivity modes and probe results first.

### Artifact Transfer

Artifact transfer is a separate capability from shell execution.

Minimum supported operations:

1. `put`
2. `get`
3. `list`
4. `delete`

Minimum metadata:

1. `artifactId`
2. `nodeId`
3. `taskRunId` or `sessionId`
4. normalized path or artifact-store location
5. size
6. SHA-256 checksum
7. content type
8. trace and request identifiers when available

First implementation can be local filesystem backed. Remote implementation
should use HTTP endpoints on the executor before adding chunked transfer.

### Node Commands

Node commands are allowlisted operations:

1. `status`
2. `probe`
3. `drain`
4. `promote`
5. `restart`
6. `upgrade`
7. `rollback`

Each command must record:

1. command id
2. node id
3. requested command and arguments
4. request/trace identity
5. status
6. output or error summary
7. started/completed timestamps

The initial implementation may write command evidence to `session_events` and
`executor_nodes`. A dedicated `node_commands` table should be introduced before
remote operations become multi-node or user-facing.

### Upgrade Rollout

The upgrade state machine is:

1. `idle`
2. `draining`
3. `upgrading`
4. `verifying`
5. `idle` or `failed`

Rules:

1. Upgrade starts only after drain is requested.
2. A draining node should not be a scheduler candidate for new work.
3. Verification requires health, version match, and a smoke task or explicit
   probe.
4. Failed upgrades stay failed until a human or higher-level operator issues
   retry, rollback, or promote.
5. Rollout state must be visible in `executor_nodes`.

## Migration Order

1. Treat the local executor as the first mesh node.
2. Run the same prompt through `gateway-local` and local `los-node`; compare
   `task_runs`, `session_events`, and `/nodes`.
3. Add artifact transfer contracts to the local executor with filesystem-backed
   storage.
4. Add node command contract and persist command evidence.
5. Move `tools/executor.sh upgrade` semantics into node command state without
   removing the local helper.
6. Add one remote `agent_http_ndjson` executor.
7. Add replay and weak-network recovery.
8. Only then add multi-node scheduling and queue-aware candidate selection.

## Non-Goals

1. Do not implement arbitrary remote shell as a node operation.
2. Do not treat SSH reachability as agent execution capability.
3. Do not make SOCKS5 or ingress nodes scheduler candidates.
4. Do not add full multi-node claim before local executor parity is verified.
5. Do not make artifact transfer depend on provider/model behavior.

## Verification

Initial verification should prove:

1. `pnpm check` passes and includes `./tools/check-contracts.sh`.
2. `los chat` can run through gateway-local.
3. `los chat` can run through local `los-node` with `EXECUTOR_ENABLED=true`.
4. Both paths write `task_runs.node_id` and `session_events.node_id`.
5. `/nodes` shows local executor eligibility and blockers.
6. Drain prevents new node selection.
7. A local upgrade records rollout state transitions.
8. Artifact transfer records checksum and task/session evidence before remote
   use.
