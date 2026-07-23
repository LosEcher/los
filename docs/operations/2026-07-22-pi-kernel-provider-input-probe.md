# Pi Kernel Provider Input Probe

- Date: 2026-07-22
- Scope: K2b LOS provider/auth/model input mapping into the unregistered Pi
  execution-kernel adapter
- Safety: one no-tool turn, 64 output-token ceiling, 120-second timeout, no
  scheduler selection, no project writes, and no credential or raw response
  persistence

## Evidence

The probe loaded the normal LOS configuration, resolved the effective
credential through LOS, built a single-model Pi runtime, and consumed the
result through the canonical `ExecutionKernel` event stream.

| Surface | Observed result |
| --- | --- |
| Configured provider/model | `deepseek` / `deepseek-v4-flash` `[E]` |
| Effective provider/model | `deepseek` / `deepseek-v4-flash` `[E]` |
| Pi API mapping | `openai-completions` `[E]` |
| Configured endpoint | `https://api.deepseek.com/v1` `[E]` |
| Effective endpoint | `https://api.deepseek.com/v1` `[E]` |
| Expected output | exact `LOS_PI_PROBE_OK` match `[E]` |
| Canonical terminal event | `kernel.finished` `[E]` |
| Tool or project effect | none; `allowedTools=[]` `[E]` |
| Provider telemetry | one row: status 200, 906 ms, 24 prompt / 6 completion tokens `[E]` |

The event sequence contained `kernel.started`, one `turn.started`, streamed
`message.delta` events, `message.completed`, `usage.recorded`,
`turn.completed`, `checkpoint.created`, and `kernel.finished`. Sequence ids
were produced by the same adapter path covered by the deterministic tests.

## Judgment

This proves that the current LOS DeepSeek route, LOS-resolved credential, Pi
model shape, and canonical adapter can complete one live no-tool invocation.
It does not prove that Pi is production-selectable.

The production registry remains LOS-only. The Pi stream now writes LOS-owned
provider telemetry, but registration still requires an explicit decision for
unsupported provider fallback, architect-editor, context compression, and
model-setting mappings. Read-only scheduler shadow evidence remains K3 work.
