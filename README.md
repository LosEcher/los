# los

Lightweight Agent Execution + Memory Management Platform.

## Primary Use

Use `los` as the project-owned execution and evidence surface for local agent
runs, runtime checks, provider compatibility, node readiness, and recurring
governance reports. Codex, Claude, OpenCode, Reasonix, and OMX can remain
entrypoints or comparison tools, but `los` owns the project-specific runtime
evidence when a claim depends on task execution, session events, node state, or
provider gates.

Read these first for project work:

1. [`AGENTS.md`](AGENTS.md) - architecture principles, commands, and
   AI-assisted change rules.
2. [`SKILL.md`](SKILL.md) - repeated los-specific workflows.
3. [`docs/README.md`](docs/README.md) - documentation index and truth surfaces.
4. [`docs/governance/periodic-analysis.md`](docs/governance/periodic-analysis.md)
   - daily, weekly, and monthly governance checks.
5. [`docs/governance/agent-workflow-roadmap.md`](docs/governance/agent-workflow-roadmap.md)
   - stage goals for personal high-autonomy agent workflows, evals, and
   toolchain governance.

## Local Runtime

Install dependencies:

```bash
pnpm install
```

For a first source-checkout run, use the repeatable setup entrypoint:

```bash
pnpm run setup
```

It checks Node, pnpm, dependencies, configuration, and PostgreSQL; starts the
gateway and optional executor idempotently; then reports auth, provider,
workspace, channel, node, and external-tool readiness. It reports credential
presence but never prints credential values. Rerun the read-only readiness
summary later with `./bin/los setup`, or open `Setup` in the Web console.

Provider discovery is not compatibility proof. When setup reports configured
providers without passing evidence, run the displayed `los compat --execute`
command before treating that provider as executable for a required gate.

Run the gateway in the foreground for development:

```bash
pnpm dev
```

Run the gateway in the background:

```bash
pnpm start
```

Run the client CLI:

```bash
pnpm run cli -- chat --provider deepseek "inspect the current workspace"
pnpm run cli -- chat --provider deepseek --model deepseek-v4-flash "inspect the current workspace"
pnpm run cli -- chat --fallback-target deepseek:deepseek-v4-flash,xai:grok-4.3 "inspect the current workspace"
pnpm run cli -- compat
pnpm run cli -- compat --target openai:gpt-5.5,codex:gpt-5.5 --probe read-context
pnpm run cli -- sessions
pnpm run cli -- tasks
```

`los compat` is dry-run by default. Its default target is the required
DeepSeek compatibility gate. Pass explicit `--target` values for advisory
provider exploration. Add `--execute` to run probes through the gateway:

```bash
pnpm run cli -- compat --execute --workspace . --target deepseek:deepseek-v4-flash --probe read-context --timeout-ms 120000
```

If `SERVER_PORT` is already occupied by a gateway from this same checkout,
`pnpm start` adopts that process into `.los-runtime/gateway.pid` instead of
starting a second server. `pnpm run status` shows this as `managed=true`.

Common local process commands:

```bash
pnpm run status
pnpm run stop
pnpm run restart
pnpm run doctor
pnpm run help
pnpm run channels:status
```

Local Telegram and WeChat processes are disabled until their mode is set to
`optional` or `required` in `.env`. `pnpm start`, `pnpm stop`, and
`pnpm status` then manage and report them through the same entrypoint while
keeping their readiness separate from gateway health. Use
`pnpm run channels:start|stop|restart|status` for channel-only operations.

## Skill And MCP Distribution

The Web `Skills` page imports file-backed skills through an explicit preview:

1. Select the scope and click `inspect`.
2. Review each `create`, `update`, or `unchanged` version.
3. Click `apply` to persist the exact inspected hashes.
4. Use `pin` to prevent source drift, or select an older history entry to
   rollback after unpinning.

The Web `MCP Servers` page uses a separate registration lifecycle:

1. Enter the source URI, transport, connection metadata, auth mode, and tool
   allow/deny policy; click `inspect`.
2. Apply the inspected registration. New and rolled-back registrations remain
   disabled and unverified.
3. Click `verify`, review discovered tools, then `enable`.
4. Pin a reviewed version or rollback from the version history.

MCP responses expose environment key names only, never values. New Web/API
registrations do not accept raw environment secrets. `credential_ref` and
`oauth` store only an opaque reference and currently fail closed because LOS
does not yet implement an MCP credential resolver. SSE and streamable HTTP
registrations are inspectable but are not executable; stdio with auth mode
`none` is the supported runtime path.

`pnpm help` is pnpm's own help command. Use `pnpm run help` for los help.

## Programmatic Agent Interface

External editors and agents can call LOS through its stdio MCP adapter. From a
source checkout, configure the MCP host with the absolute path to `bin/los`:

```json
{
  "mcpServers": {
    "los": {
      "command": "/absolute/path/to/los/bin/los",
      "args": ["mcp", "serve"],
      "env": {
        "LOS_GATEWAY_URL": "http://127.0.0.1:8080",
        "LOS_AUTH_TOKEN": "<access-token>",
        "LOS_OPERATOR_TOKEN": "<operator-token>"
      }
    }
  }
}
```

When consuming a built or installed `@los/cli` package, use the dedicated
`los-mcp` binary instead. It loads only the MCP adapter and does not depend on
the rest of the CLI command tree.

The adapter exposes `los_run`, `los_run_state`, `los_run_replay`, and
`los_operator_control`. Every tool call requires an explicit `projectId`.
`los_run` defaults to `read-only`; `project-write` requires an operator token,
and the adapter does not expose `all` mode. The operator token is forwarded
only to the existing operator-gated control route. Run execution, state,
verification, replay, and actor evidence remain owned by the gateway and
PostgreSQL rather than the MCP process.

See [`docs/operations/programmatic-agent-interface.md`](docs/operations/programmatic-agent-interface.md)
for tool inputs, host configuration, and verification steps.

## Managed Workspaces

Existing queued executor tasks can be allocated to isolated jj workspaces:

```bash
los workspaces plan GRAPH_ID --project PROJECT_ID
los workspaces apply GRAPH_ID --project PROJECT_ID
los workspaces list --graph GRAPH_ID
los workspaces release WORKSPACE_ID --confirm WORKSPACE_ID
```

Planning and inspection use the access credential. Apply, backup, and release
require the operator credential. Release always persists a checksummed diff in
the artifact store before removing the registered managed directory. LOS does
not automatically merge isolated changes in this version. See
[`docs/operations/managed-workspaces.md`](docs/operations/managed-workspaces.md).

By default the gateway listens on `http://127.0.0.1:8080`.
Override with `SERVER_HOST` and `SERVER_PORT`.

Runtime process files are written to `.los-runtime/`:

```text
.los-runtime/gateway.pid
.los-runtime/gateway.log
```

## Health

```bash
curl -fsS http://127.0.0.1:8080/health
```

## Checks

```bash
pnpm check
pnpm test
```

Use `pnpm check` as the default project coherence check. It runs package checks,
structure checks, and contract checks. Use `pnpm test` when behavior changed or
ADR 0014 requires a broader regression gate.

## Documentation

Project documentation starts at [`docs/README.md`](docs/README.md).

Key surfaces:

- `docs/adr/` - durable design decisions and status.
- `docs/operations/` - dated runtime smoke evidence.
- `docs/governance/` - recurring analysis and documentation hygiene.
- `contracts/` - public runtime contracts checked by `./tools/check-contracts.sh`.

Keep config truth, runtime truth, persisted evidence, and ADR intent separate
when making current-state claims.
