# Programmatic Agent Interface

## Supported Path

`los mcp serve` is the supported process interface for external editors and
agents. It speaks MCP over newline-delimited JSON-RPC on stdio and calls the
existing gateway HTTP routes. Start the managed gateway before connecting an
MCP host:

```bash
pnpm start
pnpm run status
./bin/los mcp serve
```

The last command is normally started by the MCP host. Its stdout is reserved
for protocol messages; readiness diagnostics go to stderr.

For a built or installed CLI package, use `los-mcp`. This dedicated binary
loads only the adapter; `bin/los mcp serve` is the source-checkout alias.

For a source checkout, use an absolute command path in host configuration:

```json
{
  "mcpServers": {
    "los": {
      "command": "/absolute/path/to/los/bin/los",
      "args": ["mcp", "serve", "--gateway", "http://127.0.0.1:8080"],
      "env": {
        "LOS_AUTH_TOKEN": "<access-token>",
        "LOS_OPERATOR_TOKEN": "<operator-token>",
        "LOS_MCP_TENANT_ID": "local",
        "LOS_MCP_USER_ID": "editor-agent"
      }
    }
  }
}
```

Do not put credentials in tool arguments or checked-in host configuration.
Use the host's secret/environment mechanism.

## Tools

| Tool | Required input | Gateway surface | Authorization |
| --- | --- | --- | --- |
| `los_run` | `prompt`, `projectId` | `POST /chat` | access token; `project-write` also requires configured operator credential |
| `los_run_state` | `runSpecId`, `projectId` | `GET /runs/:id/state` | access token |
| `los_run_replay` | `runSpecId`, `projectId` | `GET /runs/:id/stream` | access token |
| `los_operator_control` | `sessionId`, `projectId`, `type` | `POST /sessions/:id/operator-events` | access and operator tokens |

`los_run` returns a bounded terminal projection containing `sessionId`,
`runSpecId`, `taskRunId`, trace/request ids when present, run status, terminal
text, and the observed SSE event types. Use `los_run_state` for the current
recovery-grade decision and `los_run_replay` for persisted evidence rather
than treating the MCP result text as the task source of truth.

For steering, pass `type=steering` and `instruction`. For queued continuation,
pass `type=followup` and `prompt`. The gateway derives the operator actor from
the validated operator token; the adapter does not accept an actor override.

## Safety Boundary

1. `projectId` is explicit on every call and is forwarded as request context.
2. Tenant/user headers come from `LOS_MCP_TENANT_ID` and `LOS_MCP_USER_ID`.
3. Ordinary reads and `los_run` never receive the operator header.
4. `project-write` is unavailable when the adapter has no operator credential.
5. `all` tool mode is not part of the MCP contract.
6. The adapter never writes PostgreSQL or transitions execution state itself.

## Verification

```bash
./tools/check-contracts.sh
pnpm --filter @los/cli test
pnpm --filter @los/cli check
pnpm --filter @los/cli build
pnpm check
```

A deterministic stdio probe should start `los-mcp`, then send `initialize`,
`notifications/initialized`, and `tools/list` to the built CLI and assert that
the four contracted tools are present. A live run probe additionally requires
a current provider compatibility decision and may consume provider quota; it
is not implied by the protocol smoke.
