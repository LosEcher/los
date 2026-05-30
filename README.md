# los

Lightweight Agent Execution + Memory Management Platform.

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
pnpm run cli -- sessions
pnpm run cli -- tasks
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
