# Pi Kernel Parallel Tool Policy Gap

- Date: 2026-07-22
- Status: deterministic second-turn probe complete; K3 gate still failed
- Failed candidate: Pi core `0.81.1`, kernel identity `0.81.1`
- Adapter-revision candidate: Pi core `0.81.1`, kernel identity `0.81.1+los.1`
- Corpus: `1.1.0`
- Rubric: `pi-shadow-readonly-v2`

## Observed

Corpus `1.1.0` completed 17 observations against kernel identity `0.81.1`.
Fourteen passed and all three live `PKS02-read-only-tool` observations failed.
The immutable report remains `collecting` for that candidate.

All three candidate task-value envelopes parsed and produced the expected
`@los/agent` digest. Two production envelopes also parsed and matched. One
production envelope did not satisfy the typed result contract. This confirms
that the v1 byte-level output comparison was too sensitive, but it is not the
reason all three v2 observations failed.

Every live candidate requested and completed `read_file` twice while the LOS
production run requested it once. This is not projection duplication:

- each candidate comparison recorded `toolNames = ["read_file", "read_file"]`;
- each candidate session contained two LOS ToolBroker `tool.call` and
  `tool.result` events;
- each candidate session contained two `los.kernel.pi` `tool.requested` and
  `tool.completed` events;
- each production session contained one brokered `read_file` call.

## Initial Hypothesis

The DeepSeek model profile declares `supportsParallelToolCalls=false`. The LOS
provider path maps that capability to `parallel_tool_calls=false` in the
OpenAI-compatible request body. The Pi input adapter mapped provider, model,
credential, messages, tools, and sampling settings, but did not map this
provider capability. Pi therefore used its default OpenAI-compatible payload
behavior. This was treated as the root-cause hypothesis for the duplicate
reads.

Provider capability mapping before invocation was a real missing boundary, but
the initial evidence did not establish that both calls came from one provider
response.

## Decision

The Pi provider wrapper now applies the LOS model profile to the outgoing
payload. For an `openai-chat-completions` profile with tools and
`supportsParallelToolCalls=false`, it sets `parallel_tool_calls=false` through
Pi's supported `onPayload` hook. Profiles that support parallel calls and
payloads without tools remain unchanged.

The candidate kernel identity is now `0.81.1+los.1`: `0.81.1` is the pinned Pi
core and `los.1` is the LOS adapter behavior revision. Corpus and rubric remain
`1.1.0` / `pi-shadow-readonly-v2` because their scenarios and assertions did
not change. Exact candidate identity keeps the failed `0.81.1` records
immutable and prevents them from being mixed with the fixed adapter.

## Adapter-Revision Result

Candidate `0.81.1+los.1` started with zero qualifying observations and completed
the same corpus at 14/17. All 11 deterministic observations and all three live
no-tool observations passed. All three live read-only-tool observations failed
only `tool_sequence_equal`.

Persisted kernel and broker events show that Pi made the reads in consecutive
turns: it first read the full `package.json`, then requested a narrow range.
The typed production and candidate values were valid and equal in all three
runs. Mapping `parallel_tool_calls=false` therefore did not close the gap and
the earlier root-cause claim is falsified.

The detailed evidence and next diagnostic boundary are recorded in
`docs/operations/2026-07-22-pi-kernel-shadow-adapter-revision-result.md`.

## Second-Turn Probe Result

The deterministic request-envelope probe now shows that LOS and Pi send the
same system/user content, message-role sequence, tool call, tool result,
`parallel_tool_calls=false`, and equivalent tool schema after one successful
read. `[E]`

The remaining request differences are Pi streaming fields, omitted
`tool_choice=auto`, explicit `max_completion_tokens=32000`, explicit
`thinking.disabled`, assistant `null`/empty-string normalization,
`reasoning_content`, and `strict=false`. `[E]`

This excludes the original parallel-policy hypothesis and several turn-history
hypotheses, but it does not identify a unique causal field. Explicit reasoning
disablement and output-limit defaulting are the strongest semantic candidates;
the other fields remain unisolated protocol candidates. `[I]`

The full probe record is
`docs/operations/2026-07-22-pi-kernel-second-turn-envelope-probe.md`.

## Next Verification

1. Keep both failed candidate reports immutable; do not recollect them.
2. Keep the deterministic transport-envelope comparison as a regression test.
3. Revise the model-setting mapping so unspecified LOS reasoning and output
   limits remain unspecified, then verify the resulting envelope.
4. Assign exact identity `0.81.1+los.2` to that behavior change and prove it has
   zero qualifying observations before collection.
5. Require zero failures before K4 policy review.

Even a passing report does not authorize registry admission or a canary.
