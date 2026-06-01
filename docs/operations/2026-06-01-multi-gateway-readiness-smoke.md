# Multi-Gateway Readiness Smoke

Date: 2026-06-01

## Scope

This smoke validates the Phase 2 service-entry baseline from ADR 0012 without
changing the user-facing gateway on `127.0.0.1:8080`.

It validates:

1. Two gateway service instances can run against the same PostgreSQL database.
2. Both instances self-register in `service_instances`.
3. Draining one gateway makes its `/ready` fail while `/live` semantics remain
   separate.
4. Another gateway can still serve shared read surfaces.
5. Gateway startup recovery is protected by a PostgreSQL advisory lock in code
   and unit tests.

It does not validate real `/chat` model execution or cross-gateway stream
replay. Those remain part of durable run spec work.

## Setup

Temporary gateways:

```txt
smoke-gateway-a-18081 -> http://127.0.0.1:18081
smoke-gateway-b-18082 -> http://127.0.0.1:18082
```

Both were started with explicit `GATEWAY_SERVICE_ID` and
`GATEWAY_PUBLIC_URL`, sharing the same `DATABASE_URL`.

## Evidence

Initial readiness:

```json
{
  "port": 18081,
  "ready": true,
  "serviceId": "smoke-gateway-a-18081",
  "blockers": []
}
```

```json
{
  "port": 18082,
  "ready": true,
  "serviceId": "smoke-gateway-b-18082",
  "blockers": []
}
```

Service registry from gateway B:

```json
[
  {
    "serviceId": "smoke-gateway-b-18082",
    "status": "online",
    "ready": true,
    "publicUrl": "http://127.0.0.1:18082",
    "blockers": []
  },
  {
    "serviceId": "smoke-gateway-a-18081",
    "status": "online",
    "ready": true,
    "publicUrl": "http://127.0.0.1:18081",
    "blockers": []
  }
]
```

After draining gateway A:

```txt
GET http://127.0.0.1:18081/ready -> 503
```

```json
{
  "ready": false,
  "serviceId": "smoke-gateway-a-18081",
  "blockers": ["status:draining"]
}
```

Gateway B stayed ready:

```json
{
  "ready": true,
  "serviceId": "smoke-gateway-b-18082",
  "blockers": []
}
```

Gateway B served shared read surfaces while A was draining:

```json
{
  "route": "/sessions",
  "ok": true,
  "count": 7
}
```

```json
{
  "route": "/tasks",
  "ok": true,
  "count": 50
}
```

Executor registry from gateway B:

```json
{
  "nodeId": "mbp-executor-1",
  "candidate": true,
  "mode": "agent_http_ndjson",
  "blockers": []
}
```

## Cleanup

Both temporary gateway processes were stopped, and their smoke service records
were removed from `service_instances`.

## Remaining Phase 2 Work

1. Add a real local routing/load-balancer config that uses `/ready`.
2. Validate a real `/chat` request through the standby gateway without mixing
   provider health with service routing evidence.
3. Move stream replay to durable `run_specs` so a gateway switch can resume
   visible output instead of only proving read APIs.
