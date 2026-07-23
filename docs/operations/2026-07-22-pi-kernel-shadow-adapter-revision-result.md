# Pi Kernel Shadow Adapter Revision Result

- Date: 2026-07-22
- Status: K3 gate failed; deterministic envelope probe complete; no recollection authorized
- Candidate: Pi core `0.81.1`, kernel identity `0.81.1+los.1`
- Protocol: `0.1.0`
- Corpus: `1.1.0`
- Rubric: `pi-shadow-readonly-v2`

## Observed

Before collection, the versioned report contained zero observations for
`0.81.1+los.1`; records from candidate `0.81.1` were not mixed into the new
candidate report. `[E]`

The deterministic collection completed all 11 required observations with zero
failed assertions: one no-tool case, one read-only-tool case, three broker
denials, three provider failures, and three interruptions. `[E]`

The six live DeepSeek observations completed, but the final report remained
`collecting` at 14/17: `[E]`

| Scenario | Evidence class | Passing / required | Failed assertion |
| --- | --- | ---: | --- |
| `PKS01-no-tool` | live provider | 3 / 3 | none |
| `PKS02-read-only-tool` | live provider | 0 / 3 | `tool_sequence_equal` |

All three read-only candidate runs returned the expected typed
`{"packageName":"@los/agent"}` value. Production and candidate value hashes
matched, both candidate reads completed successfully, candidate lineage was isolated,
and each candidate emitted one `kernel.finished` event. `[E]`

The tool mismatch was a repeated read across consecutive turns, not two calls
in one provider response. Each LOS production run made one brokered
`read_file` call. Each Pi candidate first read `package.json`, then made a
second narrower read before returning the correct value: `[E]`

| Candidate session suffix | First read | Second read |
| --- | --- | --- |
| `8472c28d-817e-4312-8cb1-d93ed73691cb` | `{"path":"package.json"}` | `{"path":"package.json","range":"2-4"}` |
| `19fd70d1-b025-4c86-b90b-7a378d1c3fb9` | `{"path":"package.json"}` | `{"path":"package.json","range":"1-5"}` |
| `5a1521eb-4613-41d2-a272-f7c2d1b2cc09` | `{"path":"package.json"}` | `{"path":"package.json","range":"1-5"}` |

## Inference

Mapping `supportsParallelToolCalls=false` into Pi's outgoing payload remains a
valid provider-contract correction, but it did not remove the observed parity
failure. The previous claim that missing `parallel_tool_calls=false` was the
root cause is therefore falsified by the fixed-candidate run. `[E]`

The remaining difference is somewhere in the request fields still emitted
differently by the two paths. Persisted evidence alone cannot identify which
field caused the second request. `[I]`

## Deterministic Envelope Probe

The follow-up probe captured both real second-turn HTTP request bodies after an
identical successful `read_file` result. System/user content, role order, tool
call, tool result, `parallel_tool_calls=false`, and the tool schema after
normalizing Pi's explicit `strict=false` are equal. `[E]`

Pi additionally sends streaming usage fields, `max_completion_tokens=32000`,
`thinking.disabled`, empty `reasoning_content`, and explicit tool strictness;
it omits LOS `tool_choice=auto` and normalizes assistant empty content to
`null`. `[E]`

The probe excludes several turn-history hypotheses but does not prove a unique
cause. The strongest semantic candidates are Pi's conversion of unspecified
reasoning and output-limit settings into explicit defaults. `[I]`

See
`docs/operations/2026-07-22-pi-kernel-second-turn-envelope-probe.md`.

## Judgment

Candidate `0.81.1+los.1` does not satisfy the preregistered K3 gate. K4
read-only canary policy review remains blocked, Pi remains absent from the
production registry, and these 17 observations must not be deleted, relabeled,
or replaced by a rerun. `[E]`

Exact candidate `0.81.1+los.2` now preserves unspecified LOS reasoning and
output-limit semantics and passes the deterministic envelope probe plus all 11
deterministic corpus requirements. Its six live-provider requirements remain
unobserved, so the report remains `collecting`. `[E]`

The behavior-changing adapter fix therefore uses exact kernel identity
`0.81.1+los.2`. Corpus `1.1.0` and its rubric remain unchanged because the
scenarios and assertions are unchanged; the new candidate was verified at zero
qualifying observations before deterministic collection. `[E]`

The new candidate's deterministic result is recorded in
`docs/operations/2026-07-22-pi-kernel-semantic-default-revision-result.md`.
Live collection has not been authorized or run. `[E]`

## Commands

```bash
pnpm --filter @los/agent scenario:pi-shadow
pnpm --filter @los/agent scenario:pi-shadow -- --collect-deterministic
pnpm --filter @los/agent scenario:pi-shadow -- --collect-live
```

The collection commands exited with status 0. Scenario readiness is determined
by the persisted report, not by the command exit code. `[E]`
