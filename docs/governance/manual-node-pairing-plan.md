# Manual Node Pairing Plan

Date: 2026-06-07

## Purpose

This note maps the manual remote-device pairing pattern observed in Hermes Web
UI to the existing `los` node registry. It is a design note, not a runtime
contract. Promote it to `contracts/node-registry.yaml`, gateway routes, and web
UI work only after the source surfaces below are re-read.

## Current Evidence

Current `los` source already has these pieces:

1. `contracts/node-registry.yaml` defines node visibility separately from
   execution eligibility. It includes `nodeKind`, `status`, `connectModes`,
   `connectConfig`, `capabilities`, and `verified`.
2. `packages/agent/src/executor-nodes.ts` persists `executor_nodes` with
   rollout state, probe state, queue pressure, and execution-candidate
   evaluation.
3. `packages/gateway/src/node-routes.ts` exposes:
   - `GET /nodes`
   - `PATCH /nodes/:id`
   - `POST /nodes/:id/probe`
   - `POST /nodes/import-ssh-config`
4. `packages/web/src/nodes-page.tsx` already supports manual registry edits,
   dry-run probe, SSH config import, and node command actions.
5. ADR 0010 and ADR 0011 already require connectivity, capability, probe
   verification, node operations, and scheduler eligibility to stay separate.

Observed Hermes Web UI pattern:

1. discover or manually enter a remote URL;
2. fetch signed public device identity;
3. persist inbound and outbound relation states;
4. require approval before peer operations;
5. keep online status separate from pair/approval status.

## Inference

`los` should not copy Hermes LAN discovery or SQLite relation storage. The
useful part is the operator contract:

1. an operator can add a node even when auto-discovery does not find it;
2. a node can be known but not approved for execution;
3. a reachable node is not automatically a scheduler candidate;
4. approval state and runtime health are separate truth surfaces.

## Proposed los Semantics

Add a pairing layer on top of the existing node registry instead of replacing
it.

### Pairing States

Suggested state values:

1. `none` - the node is known only as a registry row or discovery result.
2. `requested` - an operator requested pairing or imported an endpoint.
3. `verified` - identity and at least one connect mode have been probed.
4. `approved` - the operator allows the node to be used for its declared
   capabilities.
5. `rejected` - the operator rejected this pairing request.
6. `blocked` - the operator does not want this node to be offered again without
   explicit unblock.

Do not overload `status=online|draining|offline` with pairing meaning.

### Identity Evidence

For a first implementation, use bounded fields inside `connectConfig` or
`verified` rather than a new table:

```json
{
  "pairing": {
    "state": "requested",
    "source": "manual_url",
    "requestedAt": "2026-06-07T00:00:00.000Z",
    "approvedAt": null,
    "identity": {
      "method": "agent_http",
      "endpoint": "http://host:8090",
      "nodeId": "node-id",
      "version": "0.1.0"
    }
  }
}
```

Move this into first-class columns only when filtering, history, or audit
requirements justify it.

### Manual URL Flow

1. Operator enters an agent HTTP or health URL.
2. Gateway normalizes the URL and rejects unsupported schemes.
3. Gateway fetches a bounded identity endpoint when available.
4. Gateway creates or updates an `executor_nodes` row with:
   - `nodeKind`
   - `baseUrl`
   - `hostLabel`
   - `connectModes`
   - `connectConfig`
   - pairing state `requested`
5. Operator runs probe.
6. Probe writes `verified` without declaring execution eligibility by itself.
7. Operator approves the node.
8. Scheduler candidate rules still require executor kind, online status, fresh
   heartbeat, runnable mode, `capabilities.run_agent=true`, and positive
   verification.

### SSH Import Flow

The existing SSH config import should remain a connectivity import, not an
execution approval.

1. Import may create `nodeKind=ssh_target`.
2. It may set `connectModes=direct_ssh` or `tailscale_ssh`.
3. It should set pairing state `requested` or leave `none` in dry-run mode.
4. It should not set `capabilities.run_agent=true`.
5. Probe may verify TCP reachability, but not workspace/shell capability unless
   a later authenticated command proves it.

### UI Changes

Nodes page should eventually show four separate columns or panels:

1. Runtime: online, draining, offline, heartbeat age.
2. Pairing: none, requested, verified, approved, rejected, blocked.
3. Connectivity: connect modes and latest probe result.
4. Execution: candidate, mode, blockers, warnings.

The current editor/probe/import panel can stay. The first UI change should be a
pairing status field and manual URL action, not a new discovery system.

## Contract Placement

First phase:

1. Document the pairing semantics here.
2. Add tests around existing node-route behavior if a code change touches it.
3. Store pairing metadata in `connectConfig.pairing` or a similar scoped
   object.

Second phase:

1. Add explicit contract fields to `contracts/node-registry.yaml`.
2. Add route-level schema/normalization in `packages/gateway/src/node-routes.ts`.
3. Add web UI controls in `packages/web/src/nodes-page.tsx`.

Do not introduce a separate `devices` table until there is a concrete history,
audit, or multi-tenant query need.

## Verification Plan

Docs-only design step:

```bash
./tools/check-contracts.sh
```

First route/API implementation:

```bash
pnpm --filter @los/gateway test
pnpm check
./tools/check-contracts.sh
```

First UI implementation:

```bash
pnpm --filter @los/web test
pnpm --filter @los/web check
pnpm check
```

First live/manual pairing smoke:

1. create a manual URL entry;
2. verify it is visible in `/nodes`;
3. run probe;
4. approve the node;
5. prove scheduler eligibility remains blocked until execution-candidate
   requirements are satisfied.

## Open Questions

1. Should pairing approval be per node, per connect mode, or per capability?
2. Should approval history be append-only before remote multi-node execution is
   user-facing?
3. Which identity endpoint should be required for non-local executors:
   `/health`, `/v1/tasks/run-agent`, or a future `/identity` endpoint?
4. Should rejected SSH imports stay visible by default or move into a hidden
   history view?
