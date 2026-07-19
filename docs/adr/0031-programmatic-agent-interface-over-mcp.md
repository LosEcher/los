# ADR 0031: Programmatic Agent Interface Over MCP

## Status

Accepted.

## Observation

LOS already has the programmatic execution primitives needed by an external
client:

1. `POST /chat` validates the run-spec request, resolves project ownership,
   persists `run_specs` and `task_runs`, and streams run events.
2. `GET /runs/:id/state` and `GET /runs/:id/stream` expose persisted state and
   bounded replay.
3. `POST /sessions/:id/operator-events` persists steering and follow-up behind
   `requireOperator()`.
4. `packages/gateway/src/los-mcp-server.ts` contains a standalone MCP sketch,
   but no package script, CLI command, or production entrypoint calls it. The
   sketch also omits the access and operator headers, does not submit runs, and
   is not covered by an MCP harness.

The missing capability is therefore a supported adapter and user path, not a
new execution protocol in the gateway.

## Inference

Adding ACP, a new JSON-RPC gateway route, or a separate SDK-owned execution
path would duplicate the existing run and evidence semantics. An MCP stdio
adapter is smaller and is directly usable by editors and agent hosts that
already support MCP.

The adapter belongs to `@los/cli`, because it is a client of the gateway. It
must not live in the gateway package as a second server lifecycle.

## Decision

Implement the source-checkout command `bin/los mcp serve` and the dedicated
package binary `los-mcp` as the formal programmatic agent interface defined by
`contracts/programmatic-agent-interface.yaml`. The dedicated build entrypoint
loads only the adapter, so it does not inherit unrelated CLI command imports.

The adapter exposes four tools:

1. `los_run` submits `POST /chat`, consumes the SSE response, and returns the
   terminal text plus persisted run identifiers.
2. `los_run_state` reads the recovery-grade run projection.
3. `los_run_replay` reads bounded persisted events with explicit cursors.
4. `los_operator_control` writes steering or follow-up through the existing
   operator-gated route.

`projectId` is required for each tool call. Tenant and user identity come from
adapter configuration and are forwarded as request-context headers. Access
and operator credentials remain process configuration, never MCP arguments or
tool output.

`los_run` defaults to `read-only`. The adapter exposes `project-write` only
when an operator credential is configured, and it does not expose `all` mode.
The operator credential is sent only to operator-controlled gateway routes.
Gateway policy and persisted evidence remain authoritative even when the MCP
host is trusted.

## Rejected Alternatives

### TypeScript SDK

A published SDK could improve typed integration, but LOS packages are private
and the current consumers need a process protocol. An SDK would still need to
implement SSE, auth, and lifecycle semantics that MCP hosts already provide.

### ACP

ACP would add another long-lived session protocol before there is a confirmed
consumer that requires it. The current need is tool invocation and evidence
lookup, which MCP covers.

### New Gateway JSON-RPC Route

This would create a second HTTP contract over the same run lifecycle and make
auth, error, replay, and idempotency behavior drift from the existing routes.

### Keep The MCP Server In Gateway

The existing file is not part of gateway startup and should not become another
gateway-managed daemon. Keeping the adapter in CLI preserves the client/server
boundary from ADR 0009.

## Consequences

External clients get one stable command and four bounded tools. Every run still
passes through project-owner resolution, run-contract handling, tool policy,
state transitions, verification, and session evidence.

MCP calls are request/response operations. They do not provide token-by-token
interactive UI, and steering cannot interrupt an in-flight provider or tool
call. Those timing semantics remain defined by `run-stream.yaml`.

## Verification

1. Contract check accepts the adapter definition.
2. A deterministic CLI test verifies initialize, tools/list, invalid input,
   access headers, tenant/project/user headers, SSE evidence projection, and
   operator-only header forwarding.
3. A stdio probe starts the built `los-mcp` entrypoint and completes MCP initialize and
   tools/list against the built CLI.
4. Root `pnpm check` reports no new unwired export.
