# Pi Kernel Parallel Tool Policy Gap

- Date: 2026-07-22
- Status: adapter fix implemented; new candidate not yet collected
- Failed candidate: Pi core `0.81.1`, kernel identity `0.81.1`
- Fixed candidate: Pi core `0.81.1`, kernel identity `0.81.1+los.1`
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

## Root Cause

The DeepSeek model profile declares `supportsParallelToolCalls=false`. The LOS
provider path maps that capability to `parallel_tool_calls=false` in the
OpenAI-compatible request body. The Pi input adapter mapped provider, model,
credential, messages, tools, and sampling settings, but did not map this
provider capability. Pi therefore used its default OpenAI-compatible payload
behavior and the live provider returned two identical calls in each sampled
tool turn.

The existing LOS storm breaker is not the parity mechanism for this case: its
default threshold suppresses the third repeated call, while these responses
contained two calls in one turn. The missing boundary is provider capability
mapping before invocation.

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

## Next Verification

1. Commit the adapter revision before collecting evidence.
2. Confirm the new candidate report contains zero qualifying observations and
   ignores prior candidates.
3. Run deterministic collection, then the six fixed live observations.
4. Require zero failures before K4 policy review.

Even a passing report does not authorize registry admission or a canary.
