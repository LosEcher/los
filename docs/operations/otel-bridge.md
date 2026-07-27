# OTel Bridge Operator Guide

Date baseline: 2026-07-27

Owning todo: `todo-los-p1-otel-docs`

## Purpose

The los OTel bridge is a **local OTLP/HTTP ingest adapter** that maps external
agent CLI spans into los `session_events` and the in-process event bus. It is
not a general OpenTelemetry Collector, not a metrics backend, and not a
substitute for los-owned run/task/verification evidence.

Primary implementation:

- `packages/agent/src/runtime-adapter/otel-bridge.ts`
- gateway routes in `packages/gateway/src/routes/orchestration/runtime-adapter-routes.ts`
- CLI spawn helpers in `packages/agent/src/runtime-adapter/claude-code.ts` and `codex.ts`

## Architecture Boundary

```text
External agent CLI (Claude Code / Codex / future OTLP client)
        │  OTLP/HTTP JSON
        ▼
los OTel bridge  (default 127.0.0.1:4318)
        │  appendSessionEvent + eventBus
        ▼
session_events / real-time consumers

Optional external collector is OUTSIDE this path:
  CLI → OTel Collector → (optional) los bridge
```

| Surface | Owner | What it proves |
| --- | --- | --- |
| Bridge `/health` | bridge process | process is listening |
| `GET /runtimes/bridge/status` | gateway | whether the in-process bridge server handle is running |
| `session_events` rows | PostgreSQL | spans were mapped and persisted |
| External collector UI | third party | collector received export traffic; **not** los verification |

## Port, Host, And Protocol

| Item | Default / value | Notes |
| --- | --- | --- |
| Host | `127.0.0.1` | Bound only to loopback unless code is changed |
| Port | `4318` | OTLP/HTTP standard port; override via `startOtelBridge({ port })` |
| Protocol | OTLP/HTTP JSON | `OTEL_EXPORTER_OTLP_PROTOCOL=http/json` |
| Trace path | `POST /v1/traces` | Mapped into `session_events` |
| Metrics path | `POST /v1/metrics` | Accepted and ACKed; **not processed** |
| Logs path | `POST /v1/logs` | Accepted and ACKed; **not processed** |
| Health path | `GET /health` | `{ status, service: "los-otel-bridge", uptime }` |

The gateway does **not** auto-start the bridge on `pnpm start`. Start paths:

1. Operator API: `POST /runtimes/bridge/start` (requires operator auth when enabled)
2. Runtime helpers: Claude Code / Codex run routes start a bridge if one is not already running

## Gateway Control Plane

### Start

```bash
# Requires LOS_AUTH_TOKEN and LOS_OPERATOR_TOKEN when auth is enabled.
curl -fsS -X POST \
  -H "Authorization: Bearer $LOS_AUTH_TOKEN" \
  -H "x-los-operator-token: $LOS_OPERATOR_TOKEN" \
  http://127.0.0.1:8080/runtimes/bridge/start
```

Responses:

- `{ "status": "started", "port": 4318 }`
- `{ "status": "already_running" }`

### Status

```bash
curl -fsS -H "Authorization: Bearer $LOS_AUTH_TOKEN" \
  http://127.0.0.1:8080/runtimes/bridge/status
# { "running": true|false }
```

`running` reflects the in-process Node HTTP server handle. It does not prove
that an external collector is healthy, that any CLI is exporting, or that
`session_events` are being written.

### Bridge health (data plane)

```bash
curl -fsS http://127.0.0.1:4318/health
# { "status": "ok", "service": "los-otel-bridge", "uptime": <seconds> }
```

If this fails while gateway status says `running: false`, start the bridge.
If gateway says `running: true` but `/health` fails, treat the process state as
broken and restart the bridge via the operator API or process recovery.

## External Collector Boundary

Use an external OTel Collector only when you need vendor backends, sampling,
or multi-service aggregation. Rules:

1. **los truth remains `session_events` / task runs / verification records.**
   Collector dashboards are supporting evidence only.
2. Prefer one of these topologies:
   - CLI → **los bridge** (default for local CLI adapters)
   - CLI → collector → **los bridge** (when you need preprocessing/redaction)
3. Do **not** configure CLI `OTEL_EXPORTER_OTLP_ENDPOINT` to a remote collector
   and then claim los has the run ledger. That export path bypasses los unless
   the collector also forwards to the local bridge.
4. The bridge is loopback-bound by default. Exposing `:4318` on a public
   interface is out of scope and unsafe without an explicit network/auth design.
5. Metrics and logs posts are currently no-ops beyond HTTP 200 ACK. Do not
   build capacity or billing decisions on bridge metrics export.

## CLI Environment Contract (Claude Code / Codex adapters)

When los spawns a supported CLI, it injects (conceptually):

```text
CLAUDE_CODE_ENABLE_TELEMETRY=1          # Claude Code path
OTEL_METRICS_EXPORTER=otlp
OTEL_LOGS_EXPORTER=otlp
OTEL_EXPORTER_OTLP_PROTOCOL=http/json
OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:<bridge-port>
```

Resource attributes may include `los.tenant_id`, `los.project_id`, and
`los.user_id` when provided. Missing session identity falls back to an
`otel-<uuid>` session id; operators should treat that as uncorrelated noise
until headers/attributes are fixed.

## Failure Checks

| Symptom | First check | Action |
| --- | --- | --- |
| Bridge status `running: false` | `GET /runtimes/bridge/status` | `POST /runtimes/bridge/start` or spawn a runtime that starts it |
| Port in use / start 500 | local listener on 4318 | free the port or start with a different `port` in code path |
| CLI runs but no events | bridge `/health`, CLI env endpoint, DB `session_events` | confirm endpoint is the los bridge, not a remote collector |
| Invalid JSON 400 | request body encoding | ensure OTLP/HTTP JSON, not protobuf, against this bridge |
| 404 from bridge | path | use `/v1/traces`, `/v1/metrics`, `/v1/logs`, or `/health` |
| Metrics/logs “missing” | code path | expected: currently ACK only |
| Operator start 401/403 | auth headers | provide `Authorization` + operator token when required |

## Non-Goals

1. Replacing Prometheus/Grafana or a production collector mesh.
2. Using bridge ingest as `canMarkSucceeded()` or verification evidence.
3. Auto-starting the bridge for every gateway process without an explicit path.
4. Treating external collector success as los execution success.

## Related

- Research context: `docs/research/2026-07-16-llm-space-observability-and-execution-optimization.md`
- Queue item: `todo-los-p1-otel-docs`
- Example env comments: `.env.example` (OTel bridge section)
