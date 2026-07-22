# Pi Kernel Shadow Adapter Revision Result

- Date: 2026-07-22
- Status: K3 gate failed; no recollection authorized
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

The remaining difference is somewhere in the turn boundary seen by the model:
the converted message sequence, tool-result envelope, tool schema, prompt, or
another OpenAI-compatible request field may differ between the LOS and Pi
paths. Current persisted evidence is intentionally bounded and cannot identify
which field caused the second request. `[I]`

## Judgment

Candidate `0.81.1+los.1` does not satisfy the preregistered K3 gate. K4
read-only canary policy review remains blocked, Pi remains absent from the
production registry, and these 17 observations must not be deleted, relabeled,
or replaced by a rerun. `[E]`

The failure also changes the next engineering task. Another live collection is
not useful until a deterministic transport-envelope probe compares the LOS and
Pi second-turn requests after one successful tool result. That probe should
compare system prompt, message roles and content, tool-call/result identifiers,
tool-result name and content, tool schema, `tool_choice`, and
`parallel_tool_calls`, while excluding credentials and raw persisted
transcripts. `[I]`

Any behavior-changing adapter fix must use a new exact kernel identity such as
`0.81.1+los.2`. Corpus `1.1.0` and its rubric may remain unchanged only if the
scenarios and assertions remain unchanged; the new candidate must start with
zero qualifying observations. `[E]`

## Commands

```bash
pnpm --filter @los/agent scenario:pi-shadow
pnpm --filter @los/agent scenario:pi-shadow -- --collect-deterministic
pnpm --filter @los/agent scenario:pi-shadow -- --collect-live
```

The collection commands exited with status 0. Scenario readiness is determined
by the persisted report, not by the command exit code. `[E]`
