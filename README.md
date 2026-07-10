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
```

`pnpm help` is pnpm's own help command. Use `pnpm run help` for los help.

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
