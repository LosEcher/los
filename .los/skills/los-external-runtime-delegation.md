---
name: los-external-runtime-delegation
enabled: true
scope: project
skillLayer: project
category: integration
runMode: manual
description: Discover and invoke bounded LOS external runtimes through the operator HTTP/SSE protocol.
---

# LOS External Runtime Delegation

Use this Skill when another agent host (Reasonix, Pi, Claude Code, or a
custom orchestrator) should delegate a bounded task to a LOS-managed Codex,
Grok, or Claude Code worker.

## Source of truth

The Skill is a procedure, not a capability registry. Read
`contracts/external-runtime.yaml` when the route or event contract matters,
then query `GET /runtimes/capabilities` immediately before selecting a worker.
Select only `implementation=runnable` and `available=true`. Treat specialties,
provider names, model names, credentials, quota, and health claims as advisory
until the live response or runtime evidence proves them.

## Delegation procedure

1. Confirm that the caller and operator have authorized external execution.
2. Build a self-contained prompt containing the goal, absolute workspace root,
   editable scope, non-goals, requested output shape, timeout, and acceptance
   checks. Do not put credentials or raw environment values in the prompt.
3. Call `POST /runtimes/<kind>/run` with the access token and
   `x-los-operator-token` when authentication is enabled.
4. Consume SSE events until one terminal event. Accept a result only when
   `runtime.output` is followed by `runtime.completed` with `status=success`.
   A non-zero completion, `runtime.error`, or `runtime.cancelled` is a failed
   delegation.
5. Run the caller's own review and verification. `runtime.*` proves child
   lifecycle and bounded output capture; it does not satisfy a LOS RunContract
   verification gate or prove task correctness.

## HTTP example

```bash
curl -N -X POST \
  -H "Authorization: Bearer $LOS_AUTH_TOKEN" \
  -H "x-los-operator-token: $LOS_OPERATOR_TOKEN" \
  -H "Content-Type: application/json" \
  http://127.0.0.1:8080/runtimes/codex/run \
  -d '{"prompt":"Review the current diff and return findings only","workspaceRoot":"/absolute/workspace","timeoutMs":300000}'
```

Abort the HTTP request to cancel the child. Output is bounded and redacted;
stderr, raw prompts, credentials, and full transcripts are not returned or
persisted.

## Pi boundary

An external Pi orchestrator may use this HTTP/SSE protocol. Pi running inside a
governed LOS task remains an `ExecutionKernel` implementation behind the
ToolBroker and is not invoked through this Skill. Reasonix and `pi-external`
remain planned until their adapters, live probes, cancellation, output,
evidence projection, and focused tests exist.
