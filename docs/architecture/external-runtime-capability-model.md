# External Runtime Capability Model

Date: 2026-08-07

## Decision

Agent intelligence is represented in two layers, not as one large Skill:

1. **Machine-readable runtime capability** — contract, TypeScript profile,
   live availability probe, and HTTP discovery. This is current execution
   truth for LOS, Reasonix, Pi-based orchestrators, and future callers.
2. **Delegation Skill** — a reusable procedure describing when to choose a
   worker, how to construct a bounded prompt, what approval is required, and
   what evidence must be accepted. It does not declare installed state,
   credentials, effective provider/model, or endpoint health.

The authoritative contract is `contracts/external-runtime.yaml`. In-process Pi
continues to use `contracts/execution-kernel.yaml` and the `ExecutionKernel`
SPI from ADR 0039.

The tracked project Skill is `.los/skills/los-external-runtime-delegation.md`.
LOS can import it into the project Skill registry, while a Reasonix adapter may
keep a host-native `SKILL.md` copy under `.reasonix/` and a future Pi host can
use the same procedure directly. The copies are transport adapters; the
contract and live capability response remain authoritative.

## Current Invocation Surfaces

| Surface | Current kinds | Intended caller |
| --- | --- | --- |
| `POST /runtimes/:kind/run` | Codex, Grok, Claude Code | External host, Reasonix, Pi orchestrator, operator UI |
| `run_runtime_task` | Codex, Grok, Claude Code | Governed LOS agent tool |
| Message command | Codex, Claude Code | Operator chat command |
| `ExecutionKernel` registry | LOS; gated Pi candidate | LOS scheduler only |

Gemini, Reasonix, and `pi-external` appear as `planned` until an adapter meets
the output, cancellation, evidence, and test requirements. Discovery hints are
advisory and never grant authority.

## Discovery

```bash
curl -fsS \
  -H "Authorization: Bearer $LOS_AUTH_TOKEN" \
  -H "x-los-operator-token: $LOS_OPERATOR_TOKEN" \
  http://127.0.0.1:8080/runtimes/capabilities
```

Each profile separates:

- implementation state: `runnable`, `planned`, or `unavailable`;
- live availability and a bounded reason;
- invocation modes;
- streaming, output, cancellation, resume, telemetry, and durable-evidence
  mechanics;
- advisory specialties such as coding, review, research, or planning.

Callers must select only `implementation=runnable` and `available=true`.

## Invocation

```bash
curl -N -X POST \
  -H "Authorization: Bearer $LOS_AUTH_TOKEN" \
  -H "x-los-operator-token: $LOS_OPERATOR_TOKEN" \
  -H "Content-Type: application/json" \
  http://127.0.0.1:8080/runtimes/codex/run \
  -d '{"prompt":"Review the current diff and return findings only","workspaceRoot":"/absolute/workspace","timeoutMs":300000}'
```

The SSE sequence is:

```text
runtime.started
runtime.process
runtime.output
runtime.completed | runtime.error | runtime.cancelled
```

`runtime.output` is bounded and redacted. Client disconnect aborts the child.
The durable ledger stores lifecycle fields and at most 2000 characters of the
redacted output summary; it never stores the raw prompt, stderr, environment,
credentials, or full external transcript.

## Adding Reasonix Or Another Worker

1. Implement an adapter that exposes a killable process handle and bounded,
   redacted output.
2. Add the kind to the external-runtime contract and TypeScript runnable-kind
   union.
3. Add a capability profile with measured mechanics; keep it `planned` until
   the implementation and live probe exist.
4. Route HTTP, tools, and message commands through `runExternalRuntime()` rather
   than spawning separately.
5. Add focused tests for output, non-zero exit, spawn failure, abort/kill,
   evidence projection, and capability discovery.
6. Run the provider compatibility probe and project gate before promotion.

If the implementation instead owns provider turns inside a governed LOS run,
it belongs behind `ExecutionKernel` and ToolBroker, not this external-worker
protocol.

## Tool Definition Cache Impact

Adding Claude Code to `run_runtime_task` changes one enum value and the bounded
tool description. This invalidates the provider tool-definition prefix for the
first request after deployment; it does not change the system prompt text or
context-window strategy. `SYSTEM_PROMPT_VERSION` is bumped from `1.3.0` to
`1.3.1`, and the registry harness asserts the runnable-kind enum.
