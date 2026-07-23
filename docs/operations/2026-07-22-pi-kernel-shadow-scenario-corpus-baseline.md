# Pi Kernel Shadow Scenario Evidence Run

- Date: 2026-07-22
- Scope: K3 preregistration, deterministic collection, and live read-only collection
- Candidate: Pi `0.81.1`, execution-kernel protocol `0.1.0`
- Corpus: `1.0.1` (supersedes invalid promotion evidence from `1.0.0`)
- Rubric: `pi-shadow-readonly-v1`

## Observed

The initial read-only report observed zero qualifying records and ignored the
pre-corpus smoke. The following bounded collection commands then used the
preregistered fixtures and persisted standard `kernel.shadow.compared` events:

```bash
pnpm --filter @los/agent scenario:pi-shadow -- --collect-deterministic
pnpm --filter @los/agent scenario:pi-shadow -- --collect-live
pnpm --filter @los/agent scenario:pi-shadow
```

The deterministic command invoked the Pi adapter with a faux provider and no
network. The live command invoked the production `runScheduledAgentTask()`
entrypoint with LOS authoritative and Pi comparison-only, using the effective
`deepseek/deepseek-v4-flash` route, local readonly sandbox, and only the fixed
empty or `read_file` catalog `[E]`.

| Scenario | Evidence class | Required | Passing | Failing |
| --- | --- | ---: | ---: | ---: |
| `PKS01-no-tool` | deterministic | 1 | 1 | 0 |
| `PKS01-no-tool` | live provider | 3 | 3 | 0 |
| `PKS02-read-only-tool` | deterministic | 1 | 1 | 0 |
| `PKS02-read-only-tool` | live provider | 3 | 2 | 1 |
| `PKS03-policy-denial` | deterministic | 3 | 3 | 0 |
| `PKS04-provider-failure` | deterministic | 3 | 3 | 0 |
| `PKS05-interruption` | deterministic | 3 | 3 | 0 |

The report observed 17 qualifying records: 16 passing and 1 failing. It ignored
18 earlier records: the pre-corpus smoke plus the 17 corpus `1.0.0` records
`[E]`. All three live
read-only-tool attempts completed, both kernels called `read_file` exactly
once, the tool succeeded, lineage remained isolated, and Pi emitted
`kernel.finished`. Two output hashes matched; the remaining attempt failed only
`output_hash_equal` `[E]`.

The failed LOS result used a different Markdown rendering of `@los/agent` from
Pi. The returned package value agreed, but the byte-level response hashes did
not.
Raw output text is not copied into the comparison event; this diagnosis used
the existing bounded LOS `model.response` preview plus the stored hashes.

## Judgment

K3 collection is complete for corpus `1.0.1`, but the preregistered gate failed.
The result is `collecting`, not `ready_for_k4_policy_review`. The failure is not
a tool-boundary failure: tool name, count, state, lineage, and terminal evidence
passed. It is a strict output-equivalence failure caused by presentation
variation. Corpus `1.0.1` must remain immutable; rerunning or weakening its
rubric after seeing the data would invalidate the gate.

Corpus `1.0.0` was retired before promotion judgment because its lineage
assertion checked only the comparison outcome identifiers, not the identifiers
actually passed into Pi. No record was deleted or rewritten. Version `1.0.1`
adds `traceId` to canonical `kernel.started` evidence and binds the assertion to
the actual session/task/trace input. All 17 replacement observations passed
this corrected lineage assertion `[E]`.

A future corpus may preregister a semantic value assertion or a deterministic
answer envelope before collecting new observations. That is a new evaluation
revision, not a reinterpretation of these three failures.

Even a ready report cannot register Pi or start a canary. K4 still requires a
separate operator decision, persisted candidate run spec, operator-visible
rollback, and formal pairwise records through
`los.execution-pairwise-eval`.
