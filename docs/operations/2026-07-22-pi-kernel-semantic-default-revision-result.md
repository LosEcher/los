# Pi Kernel Semantic-Default Revision Result

- Date: 2026-07-22
- Status: deterministic evidence complete; live evidence not collected; K4 blocked
- Baseline: LOS kernel
- Candidate: Pi core `0.81.1`, kernel identity `0.81.1+los.2`
- Corpus: `1.1.0`
- Rubric: `pi-shadow-readonly-v2`
- Protocol: `0.1.0`
- Live-provider calls in this revision: none

## Observation

Before changing the candidate identity, the read-only scenario report for exact
identity `0.81.1+los.2` contained zero qualifying observations. Every one of
the 17 required cells was unobserved, with `observedCount=0` and
`ignoredCount=0`. Records from `0.81.1` and `0.81.1+los.1` were not relabeled or
reused. `[E]`

The Pi payload policy now preserves the LOS meaning of unspecified model
settings for OpenAI-compatible requests: `[E]`

- when LOS does not set `maxTokens`, Pi-generated `max_completion_tokens` and
  `max_tokens` fields are removed;
- when LOS sets neither `reasoningEffort` nor `thinking`, Pi-generated
  `thinking` and `reasoning_effort` fields are removed;
- explicitly supplied output-limit and reasoning fields are not removed by the
  payload policy;
- `parallel_tool_calls=false` remains enforced for profiles that do not support
  parallel tool calls;
- Pi streaming behavior is unchanged.

The deterministic second-turn envelope now omits both `thinking` and
`max_completion_tokens`. Prompt/history, tool call/result, normalized tool
schema, and parallel-tool policy remain equal to the LOS fixture. Streaming,
tool-choice, and representation differences remain. This regression proves the
intended request semantics; it does not prove which field caused the earlier
live duplicate read. `[E]`

## Verification

The focused adapter and envelope suite passed 14/14: `[E]`

```bash
pnpm --filter @los/agent exec node --import tsx \
  --import ./src/test-setup.ts --test --test-concurrency 1 \
  src/pi-kernel-input.test.ts \
  src/pi-kernel-envelope.test.ts \
  src/pi-execution-kernel.test.ts
```

`pnpm check` passed with the repository's 48 grandfathered structure warnings.
The payload policy was extracted into
`packages/agent/src/pi-kernel-payload-policy.ts`; the modified
`pi-kernel-input.ts` remains below the 400-line warning threshold. `[E]`

The deterministic corpus collection completed without a provider call: `[E]`

```bash
pnpm --filter @los/agent scenario:pi-shadow -- --collect-deterministic
```

The current read-only report is: `[E]`

- deterministic evidence: 11/11 passing, zero failures;
- live-provider evidence: 0/6 observed;
- overall status: `collecting`;
- `observedCount=11`;
- `ignoredCount=0`;
- automatic admission: disabled.

The full repository gate also passed: `[E]`

```text
pnpm run gate
phases run: 9
failures: 0
elapsed: 352s
```

## Judgment

Candidate `0.81.1+los.2` satisfies the deterministic prerequisite for a new
live corpus, but it does not satisfy the K3 gate. No live-provider evidence was
collected for this identity, Pi remains absent from the production registry,
and no read-only canary is authorized. `[E]`

Live collection requires a separate operator decision because it creates six
new provider observations and incurs provider cost. A future 17/17 result would
permit K4 policy review only; it would not itself authorize registry admission
or canary execution. `[E]`

## Residual Gap

The current change covers unspecified reasoning semantics. Explicit
`thinking='enabled'` is not yet mapped end to end through Pi model options;
explicit disablement remains fail-closed through admission. This does not
invalidate the current deterministic corpus, whose model settings do not
request explicit thinking, but it remains a blocker for broader model-setting
compatibility and default promotion. `[E]`

## Next Action

1. Keep the 17 observations for each failed candidate immutable.
2. Do not run `--collect-live` without operator authorization.
3. If live collection is authorized, collect only against exact identity
   `0.81.1+los.2` and stop on the first failed requirement.
4. Keep K4, registry admission, and production selection blocked until the
   persisted report and a separate operator decision both allow review.
