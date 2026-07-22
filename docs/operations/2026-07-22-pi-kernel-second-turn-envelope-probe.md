# Pi Kernel Second-Turn Envelope Probe

- Date: 2026-07-22
- Status: deterministic probe complete; cause narrowed but not proven
- Baseline: LOS kernel
- Candidate observed: Pi core `0.81.1`, kernel identity `0.81.1+los.1`
- Protocol: `0.1.0`
- Live-provider calls: none

## Observation

The focused test intercepts the real HTTP request bodies produced by the LOS
loop and Pi adapter. Each path receives the same deterministic first response,
executes one successful brokered `read_file` call, and then emits a second-turn
request. The test compares those two second-turn envelopes. `[E]`

```bash
pnpm --filter @los/agent exec node --import tsx \
  --import ./src/test-setup.ts --test --test-concurrency 1 \
  src/pi-kernel-envelope.test.ts
```

The command completed with one passing test and zero failures. The test uses an
in-memory `fetch` interceptor and fixture responses; it does not call DeepSeek
or add shadow-corpus observations. `[E]`

The following second-turn fields are equal: `[E]`

- message roles: `system`, `user`, `assistant`, `tool`;
- system and user content;
- assistant tool-call id, name, and JSON arguments;
- tool-result call id and content;
- `parallel_tool_calls=false`;
- tool schema after removing Pi's explicit `strict=false` default.

The observed differences are: `[E]`

| Surface | LOS request | Pi request |
| --- | --- | --- |
| streaming | `stream=false` | `stream=true`, `stream_options.include_usage=true` |
| tool choice | `tool_choice=auto` | omitted |
| output limit | omitted | `max_completion_tokens=32000` |
| reasoning | omitted | `thinking={"type":"disabled"}` |
| assistant content | empty string | `null` |
| reasoning content | omitted | empty string |
| tool function strictness | omitted | `strict=false` |

## Inference

The live duplicate read is not explained by a missing prompt, a missing tool
result, changed call identifiers, changed tool arguments, message-role order,
or the previously fixed parallel-tool policy. Those fields are equal in the
deterministic second-turn requests. `[E]`

The strongest remaining semantic candidates are Pi's conversion of an
unspecified LOS reasoning setting into explicit `thinking.disabled` and its
insertion of a default output-token limit. Both alter model-visible request
semantics rather than only wire representation. `[I]`

Streaming, omitted `tool_choice=auto`, `strict=false`, and empty-string versus
`null` fields may also affect a provider implementation, but this probe does
not isolate their causal effect. `[I]`

The probe does not establish a unique root cause for the second read. A passing
fixture proves request-shape comparison and turn-history parity; it does not
prove how the live model will react to each field independently. `[E]`

## Judgment

Candidate `0.81.1+los.1` remains failed at 14/17 and its persisted observations
remain immutable. Recollecting that exact candidate would not answer the new
question. K4 policy review remains blocked, and Pi remains absent from the
production registry. `[E]`

The next adapter revision should use exact identity `0.81.1+los.2` and preserve
the LOS meaning of an unspecified reasoning setting and unspecified output
limit. Pi's streaming mechanics may remain if the semantic settings can be
omitted independently. This is a candidate hypothesis, not an admission
decision. `[I]`

## Next Action

1. Prove that `0.81.1+los.2` has zero qualifying corpus observations before
   collection. `[E]`
2. Change only the Pi model-setting mapping needed to preserve unspecified
   reasoning and output-limit semantics. `[I]`
3. Re-run this deterministic envelope test and the existing Pi adapter suite
   before any live-provider request. `[E]`
4. Start a new live corpus only if the deterministic envelope confirms the
   intended semantics and the operator authorizes the provider cost. `[I]`
5. Even a 17/17 result does not authorize registry admission or K4 canary
   execution. `[E]`
