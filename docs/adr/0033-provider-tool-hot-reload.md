# ADR 0033: Provider/Tool Hot Reload

## Status

Proposed.

## Context

Kimi's `checkpoint-engine` demonstrates 1T-parameter model weight updates in ~20 seconds without service restart. While los doesn't manage model weights, the hot-reload pattern applies to two los surfaces:

1. **Provider profiles** (`model-profiles.ts`): Adding a new provider or changing model defaults requires a gateway restart today.
2. **Tool registry** (`tools/core/registry.ts`): MCP server connections and tool definitions are loaded at startup.

## Decision

1. **Provider hot reload via file-watch**: `provider-defaults.ts` is already configuration-driven. Add a file watcher on the provider config directory (`~/.los/providers/` or equivalent) that reloads provider defaults and re-resolves model profiles without restarting the gateway.

2. **Tool registry hot reload via MCP reconnect**: When an MCP server configuration changes (new server added, transport updated), the tool registry:
   - Gracefully disconnects from changed servers
   - Reconnects with new configuration
   - Emits `tool.registry.updated` event with added/removed tool names
   - Active tool calls complete against the old configuration (no in-flight interruption)

3. **Graceful handoff**: New task runs pick up new provider/tool configuration immediately. In-flight task runs continue with the configuration that was active when they started.

4. **Version tracking**: Each hot-reload increments a `providerConfigVersion` and `toolRegistryVersion` counter. Session events include the active version at run start.

## Consequences

**Positive**: Zero-downtime provider/tool updates. Faster iteration on MCP server configuration.

**Negative**: In-flight runs may use stale configurations (acceptable trade-off). File-watcher adds minor process overhead.

**Risk**: Partial reload (provider A reloads but not provider B) could cause inconsistency. Mitigation: atomic batch reload — all providers reload together or none.

## References

- Kimi checkpoint-engine hot-reload pattern
- `packages/agent/src/model-profiles.ts`
- `packages/agent/src/tools/core/registry.ts`
