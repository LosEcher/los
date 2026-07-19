# ADR 0036: CanTool MCP Capability Adapter

- Status: Accepted
- Date: 2026-07-19

## Observation

CanTool 2.0.0-alpha exposes its packaged desktop capabilities through a stdio
MCP bridge. A live handshake from the current LOS MCP client negotiated protocol
`2024-11-05` and discovered 61 tools. CanTool remains the owner of DataGrant,
plugin trust, local-only secrets, and user-presence policy.

LOS already owns a project-scoped MCP distribution lifecycle with inspect,
apply, verify, enable, pin, and rollback. It does not currently forward CanTool
DataGrant references or support checkpoint continuation across MCP calls.

MCP tool discovery alone is not sufficient execution evidence. A discovered
tool may expose local-private data, omit safety annotations, or be added by a
future CanTool release without LOS review.

## Inference

CanTool should enter LOS through an explicit capability adapter, not as a source
dependency or a generic trusted MCP server. Capability discovery, policy
eligibility, and execution registration must remain separate decisions.

An LOS-side grant-shaped object cannot authorize CanTool data access while the
stdio bridge cannot pass it to the CanTool authorization owner. Treating such an
object as authorization would create a fail-open path.

## Decision

1. Reuse `mcp_servers.distribution_json` for adapter configuration and verified
   capability evidence. Do not add a connector table for this integration.
2. Persist adapter kind as `generic` or `cantool`. The CanTool adapter fixes the
   provider identity to `cantool.mcp.local`, provider location to `local`,
   DataGrant owner to `cantool`, and session binding to `per_call`.
3. Project every discovered CanTool tool into a data classification,
   availability, reason, approval mode, safety annotations, cancellation
   semantics, and resume semantics.
4. Register only capabilities present in the reviewed adapter map and carrying
   read-only, non-destructive, closed-world MCP annotations. Missing or unsafe
   annotations fail closed.
5. The initial available set is limited to runtime/plugin and file-index status,
   local metadata without content, caller-supplied transforms, calculators,
   regex operations, and unit conversion.
6. Clipboard content, snippet content, file search/recent/excerpts, secret tools,
   and unknown future capabilities remain blocked. A registry allowlist cannot
   override this adapter decision.
7. LOS may validate and record opaque grant binding evidence for provider,
   location, session, expiry, and revocation. The current adapter still returns
   `data_grant_forwarding_unavailable` after a matching preflight because the
   stdio bridge forwards no grant reference.
8. Cancellation sends `notifications/cancelled`; the client removes the pending
   request and discards a late result. A later call is a new call. The adapter
   reports resume semantics as `new_call_only`, not checkpoint resume.
9. Verification and pinning do not enable the server. Execution remains subject
   to the existing MCP enabled, connected, pinned-version, transport, auth, and
   tool-policy gates.

## Ownership

- CanTool owns capability execution, DataGrant authorization, plugin trust, and
  desktop-local policy.
- `packages/agent/src/cantool-capability-adapter.ts` owns LOS classification,
  projection, grant preflight, and the reviewed initial capability set.
- `packages/agent/src/mcp-distribution.ts` and `mcp-servers.ts` own lifecycle,
  version, pin, and persisted evidence.
- `packages/agent/src/tools/external/` owns stdio transport, cancellation, and
  late-result handling.
- `packages/gateway/src/routes/tools/mcp-routes.ts` owns inspect/apply/verify
  HTTP behavior. `packages/web` renders persisted evidence without inferring a
  broader capability state.

## Verification

- Adapter tests cover unavailable private capabilities for missing, mismatched,
  expired, revoked, and cross-session grant evidence.
- Distribution tests cover fixed adapter identity and rejection of unreviewed
  allowlist entries.
- Registry tests prove private and unknown capabilities remain unregistered even
  when the persisted allowlist is broader.
- The stdio cancellation fixture proves notification emission, late-result
  discard, and a successful fresh call after cancellation.
- A packaged CanTool lifecycle smoke covers inspect, disabled apply, verify,
  pin, status/pure-tool calls, private-capability denial, cancellation, and a
  fresh call. The retained project-scoped record remains disabled and pinned;
  the smoke does not enable execution mode.

## Consequences

The first release favors a small auditable capability set over discovery breadth.
Enabling private CanTool data later requires an explicit grant-forwarding
protocol and a new compatibility test; expanding the reviewed map requires a
focused adapter change. Remote MCP transport, OAuth, and generic credential
resolution remain outside this ADR.
