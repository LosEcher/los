# Pi Kernel Scheduler Shadow Probe

- Date: 2026-07-22
- Scope: K3 explicit LOS/Pi read-only scheduler shadow
- Safety: one turn per kernel, `allowedTools=[]`, `toolMode=read-only`,
  `sandboxMode=readonly`, no remote executor, no project writes, and no
  candidate text in the production comparison event

## Evidence

The probe called the production `runScheduledAgentTask()` entrypoint with LOS
as the selected kernel and Pi as the explicit shadow candidate. Both used the
LOS-resolved DeepSeek route. The command completed before a quoting error in a
post-run SQL query; the evidence below was recovered from the already persisted
rows without replaying either provider call.

| Surface | Observed result |
| --- | --- |
| Production task | `task-pi-shadow-live-1784743717484`, `succeeded` `[E]` |
| Production kernel | `los@0.1.0`, protocol `0.1.0` `[E]` |
| Candidate kernel | `pi@0.81.1`, protocol `0.1.0` `[E]` |
| Provider/model | `deepseek` / `deepseek-v4-flash` for both `[E]` |
| Exact production output | `LOS_PI_SHADOW_OK` `[E]` |
| Output comparison | production and candidate SHA-256 hashes equal `[E]` |
| Tools/project effects | zero tool calls; no project write `[E]` |
| Candidate terminal | `completed`, one turn, `kernel.finished` `[E]` |
| Candidate usage | 222 prompt / 7 completion tokens `[E]` |
| Production usage | 222 prompt / 111 completion tokens `[E]` |
| Candidate provider call | `pi:openai-completions`, HTTP 200, 887 ms `[E]` |
| Production provider call | `/chat/completions`, HTTP 200 `[E]` |

The production session contains LOS `kernel.started`, LOS `kernel.finished`,
and one `los.scheduler.shadow` comparison event. The Pi kernel events are in
`session-pi-shadow-live-1784743717484:shadow:pi`, and its provider call uses
`trace-pi-shadow-live-1784743717484:shadow:pi`. No Pi task lifecycle transition
was written.

The comparison event contains exact kernel identities, derived lineage, event
counts, usage, latency, terminal classification, and output hashes. It does not
contain either production or candidate response text.

## Judgment

This proves one real no-tool scheduler shadow with isolated LOS/Pi evidence and
an unchanged LOS production authority. It does not prove read-only tool parity,
failure rates across a task distribution, operator controls, context
compression, provider fallback, or write safety.

K3 is implemented and has an initial live record, but it is not a promotion
gate by itself. Pi remains absent from the production kernel registry. The next
step is a preregistered read-only scenario set and pairwise evidence before an
explicit read-only canary is considered.
