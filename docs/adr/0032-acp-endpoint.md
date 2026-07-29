# ADR 0032: ACP (Agent Client Protocol) Endpoint

## Status

Proposed.

## Context

kimi-code natively supports the Agent Client Protocol (ACP), allowing it to be driven by IDEs like Zed and JetBrains. los currently exposes only a REST/WebSocket gateway API (`GET /chat`, `POST /runs`, etc.). Adding ACP support would make los usable as a backend agent in IDE workflows.

ACP is a lightweight JSON-RPC style protocol over stdio or HTTP. Key operations include:
- `initialize` — capability negotiation
- `agent/run` — start an agent task
- `agent/cancel` — cancel a running task
- `agent/events` — streaming event subscription
- `tools/list` — list available tools

## Decision

1. **Route**: `POST /acp` — single endpoint handling all ACP requests (JSON-RPC style routing by `method` field).

2. **Implementation**:
   - New file: `packages/gateway/src/routes/acp.ts`
   - Map ACP methods to existing los operations:
     - `agent/run` → `createRunSpec()` + `claimNextTask()`
     - `agent/cancel` → `cancelTaskRun()`
     - `agent/events` → SSE subscription filtered by `sessionId`
     - `tools/list` → `getToolRegistry().list()`

3. **Capabilities advertisement**:
   ```json
   {
     "protocol": "acp/1.0",
     "capabilities": {
       "streaming": true,
       "tools": true,
       "planning": true,
       "verification": true,
       "memory": true
     }
   }
   ```

4. **Authentication**: Reuse existing gateway auth (bearer token / session token).

5. **Transport**: HTTP POST with JSON body, SSE for streaming events.

## Consequences

**Positive**: IDE integration (Zed/JetBrains/VSCode via ACP plugin).

**Negative**: Maintaining ACP protocol parity with kimi-code and other ACP implementations.

**Risk**: ACP spec is evolving. Pin to ACP 1.0 and version-negotiate.

## Migration

1. Phase 1: Implement `agent/run`, `agent/cancel`, `agent/events` (core loop)
2. Phase 2: Add `tools/list`, `memory/search`
3. Phase 3: ACP plugin for Zed/JetBrains

## References

- kimi-code ACP implementation
- `packages/gateway/src/server.ts` — route registration
- `packages/gateway/src/routes/` — existing route patterns
