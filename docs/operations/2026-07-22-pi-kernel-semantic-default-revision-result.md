# Pi Kernel Semantic-Default Revision Result

- Date: 2026-07-22
- Updated: 2026-07-23
- Status: v3 live corpus stopped at 5/6 with one failure; v4 envelope
  remediation completed; current v4 evidence 17/17 with zero failures;
  ready for K4 policy review
- Baseline: LOS kernel
- Candidate: Pi core `0.81.1`, current kernel identity `0.81.1+los.3`
- Corpus: `1.1.2`
- Rubric: `pi-shadow-readonly-v4`
- Protocol: `0.1.0`
- Current v4 live-provider collection: 6/6 passing observations and 18 recorded
  HTTP calls

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

Before live collection, the read-only report was: `[E]`

- deterministic evidence: 11/11 passing, zero failures;
- live-provider evidence: 0/6 observed;
- overall status: `collecting`;
- `observedCount=11`;
- `ignoredCount=0`;
- automatic admission: disabled.

## Historical Live Collection Failure

The operator authorized the six-observation live corpus on 2026-07-23. The
batch `--collect-live` entrypoint does not stop after the first failed
requirement, so collection used the same `_collectPiKernelShadowLiveEvidence()`
path one observation at a time and re-read the persisted report after every
observation. Collection stopped after the first failing record, as required by
the preregistered protocol. `[E]`

| Scenario | Result | Production task run |
| --- | --- | --- |
| `PKS01-no-tool` | pass | `task-pi-shadow-live-PKS01-no-tool-af5a0e7b-0010-49a1-b48f-9af60175e56a` |
| `PKS01-no-tool` | pass | `task-pi-shadow-live-PKS01-no-tool-c19fc2ff-9fa1-462c-9db3-8235622e8c88` |
| `PKS01-no-tool` | pass | `task-pi-shadow-live-PKS01-no-tool-2f491c63-611d-4825-8d69-300f59e996f2` |
| `PKS02-read-only-tool` | fail | `task-pi-shadow-live-PKS02-read-only-tool-b79cc24d-07a9-4e29-ba6b-5581513d7473` |

The `PKS02` record is an operation-input failure, not evidence of a Pi/LOS
semantic difference. Both kernels made exactly one successful `read_file`
call, completed in two turns, returned the same typed value, produced equal
output hashes, and passed every rubric assertion except `task_value_expected`.
The one-at-a-time command set `workspaceRoot` to the repository root, so both
kernels read root `package.json` and returned `"los"`; the preregistered fixture
expects `"@los/agent"` from `packages/agent/package.json`. The persisted value
hash `sha256:cb6e53541e37a1d6076e5b516510607a5f3af6c4c4d7f5ce7ac2ffbd18b340a2`
matches `"los"` on both sides. `[E]`

The persisted v2 report after collection was: `[E]`

- deterministic evidence: 11/11 passing, zero failures;
- live-provider evidence: 4/6 observed, 3 passing, 1 failing, 2 unobserved;
- overall corpus: 15/17 observed, 14 passing, 1 failing;
- overall status: `collecting`;
- `observedCount=15`;
- `ignoredCount=0`;
- automatic admission: disabled.

The four observations produced 10 `provider_call_telemetry` rows against
`deepseek/deepseek-v4-flash`; all recorded HTTP status 200. Comparison events
record 2,479/221 LOS prompt/completion tokens and 1,196/178 Pi
prompt/completion tokens. Candidate-side estimated cost totals
`$0.00021728`; this is not total provider billing because the LOS telemetry
rows did not contain normalized usage. `[E]`

The full repository gate also passed: `[E]`

```text
pnpm run gate
phases run: 9
failures: 0
elapsed: 352s
```

## Corpus And Collector Remediation

Corpus `1.1.1` / rubric `pi-shadow-readonly-v3` makes the workspace fixture part
of the scenario contract. `PKS02-read-only-tool` is bound to
`packages/agent/package.json`, field `name`, expected value `"@los/agent"`.
Before a provider call, the collector parses that JSON fixture and rejects a
missing, unreadable, non-object, or mismatched value. Persisted evidence contains
only a SHA-256 fixture-identity hash and a SHA-256 content-value hash; it does
not store the path, field value, or file contents. Report evaluation requires
those hashes to match the preregistered fixture. `[E]`

The batch live collector now applies the stop rule itself: `[E]`

1. It validates every workspace fixture needed by the outstanding batch before
   issuing the first provider request.
2. It re-reads the persisted report after each observation.
3. It stops when an observation is not `completed`, was not persisted, or makes
   any live requirement fail.
4. It refuses with zero provider calls when the current corpus already contains
   failing live evidence.

The remediation checks passed: `./tools/check-contracts.sh` validated 27
contracts, and the focused shadow scenario suites passed 20/20. `pnpm check`
also passed with the existing 48 grandfathered structure warnings. The final
`pnpm run gate` passed all 9 phases with zero failures in 374 seconds. `[E]`

The deterministic `1.1.1` corpus was then collected without a provider call.
Before v3 live collection, the persisted report was: `[E]`

- deterministic evidence: 11/11 passing, zero failures;
- live-provider evidence: 0/6 observed;
- overall status: `collecting`;
- `observedCount=11`;
- `ignoredCount=15`, comprising the preserved v2 observations that do not
  satisfy the v3 corpus/rubric identity;
- automatic admission: disabled.

No live-provider HTTP request was made during remediation or that report
verification. `[E]`

## V3 Live Collection Result

The operator authorized one six-observation v3 live collection on 2026-07-23.
The batch collector verified the workspace fixture before its first request and
re-read persisted readiness after each observation. It stopped after the fifth
observation failed, so the sixth observation made no provider call. `[E]`

| Scenario | Result | Production task run |
| --- | --- | --- |
| `PKS01-no-tool` | pass | `task-pi-shadow-live-PKS01-no-tool-d68ad368-f55f-4067-842b-8bc3641edc80` |
| `PKS01-no-tool` | pass | `task-pi-shadow-live-PKS01-no-tool-ce6e421e-3cb2-4d7a-af63-c67a9b73f506` |
| `PKS01-no-tool` | pass | `task-pi-shadow-live-PKS01-no-tool-25941499-8808-4db2-a5b5-93a55f92d97e` |
| `PKS02-read-only-tool` | pass | `task-pi-shadow-live-PKS02-read-only-tool-5e9c5008-2f73-4ea5-811b-4885cf42a753` |
| `PKS02-read-only-tool` | fail | `task-pi-shadow-live-PKS02-read-only-tool-85ed76e5-c1ec-4d96-8b31-172e9dc0d6b1` |

The failed `PKS02` observation passed the scenario contract, workspace fixture,
production completion, candidate terminal status, isolated lineage, tool-call
presence, tool sequence, candidate tool success, production result envelope,
and candidate finished-event assertions. LOS and Pi each made one successful
`read_file` call. Production returned the expected
`{"packageName":"@los/agent"}` value. The candidate final text did not match the
strict single-field JSON envelope, so it had no candidate value hash and failed
`candidate_result_envelope_valid`, `task_value_expected`, and
`task_value_equal`. Its output hash also differed from production. `[E]`

This is a candidate result-envelope failure, not a workspace, provider, tool
sequence, or tool-execution failure. The bounded comparison event does not
persist candidate text. The candidate event stream does establish a final
length of 61 characters, and the sum of its 64 text-delta lengths is also 61;
Pi did not duplicate text while projecting or aggregating the provider stream.
`[E]`

The persisted output hash is
`sha256:09495217cafbe537e5cde0f4933d185c42d0773f611b8c6e39618f1cbc8575e0`.
A bounded reconstruction containing a prose prefix followed by the correct
fenced `{"packageName":"@los/agent"}` object is 61 characters and matches that
hash exactly. The failure is therefore established as
`prefixed_fenced_json`: the task value was correct, but the final response
violated the preregistered envelope. `[E]`

The five observations produced 14 `provider_call_telemetry` rows against
`deepseek/deepseek-v4-flash`; every row recorded HTTP 200. Comparison events
record 3,947/329 LOS prompt/completion tokens and 1,644/334 Pi
prompt/completion tokens. `[E]`

The current persisted v3 report is: `[E]`

- deterministic evidence: 11/11 passing, zero failures;
- live-provider evidence: 5/6 observed, 4 passing, 1 failing, 1 unobserved;
- overall corpus: 16/17 observed, 15 passing, 1 failing;
- overall status: `collecting`;
- `observedCount=16`;
- `ignoredCount=15`, comprising preserved v2 observations;
- automatic admission: disabled.

Because the corpus now has failing live evidence, another `--collect-live`
attempt is required to fail before any provider call. The sixth observation
must not be filled by bypassing this stop rule. `[E]`

## V4 Envelope Remediation

The remediation keeps the v3 failure immutable and does not relax the typed
comparator. Candidate `0.81.1+los.3`, corpus `1.1.2`, and rubric
`pi-shadow-readonly-v4` make these bounded changes: `[E]`

1. `PKS02` now states that the entire final response must be the single-field
   JSON object and explicitly forbids markdown fences and other text.
2. Typed comparison evidence records production/candidate envelope shape as
   `json_object`, `fenced_json`, `prefixed_fenced_json`, or `other`, plus text
   length. Raw text remains absent; output and typed values remain hashed.
3. The 61-character v3 regression fixture remains invalid, is classified as
   `prefixed_fenced_json`, and does not expose its prose or package value in the
   persisted comparison JSON.

The focused K3 suites pass 18/18 and `pnpm --filter @los/agent check` passes.
The read-only v4 report initially contained zero qualifying observations,
which verifies that v3 records were not relabeled. Deterministic v4 collection
then completed 11/11 without a provider call. Before live collection, the
report was 11/17 observed, 11 passing, zero failing, live 0/6,
`ignoredCount=0`, and `collecting`. `[E]`

After the v4 implementation and version-identity regression assertion were
aligned, `pnpm check` passed with the repository's 48 grandfathered structure
warnings. The final `pnpm run gate` passed all 9 phases with zero failures in
409 seconds. `[E]`

## V4 Live Collection Result

The operator authorized one six-observation v4 live collection on 2026-07-23.
The collector verified the PKS02 workspace fixture before its first provider
request and re-read persisted evidence after every observation. All six
observations completed and passed, so the stop-on-first-failure rule did not
terminate the batch early. `[E]`

```bash
pnpm --filter @los/agent scenario:pi-shadow -- --collect-live
```

| Scenario | Result | Production task run |
| --- | --- | --- |
| `PKS01-no-tool` | pass | `task-pi-shadow-live-PKS01-no-tool-e46afc6b-0c07-4b47-aff4-30fc26b28a74` |
| `PKS01-no-tool` | pass | `task-pi-shadow-live-PKS01-no-tool-ece32693-f002-403d-92aa-bf9da042c910` |
| `PKS01-no-tool` | pass | `task-pi-shadow-live-PKS01-no-tool-228e8d8a-7a75-4108-83b2-26301e525fb5` |
| `PKS02-read-only-tool` | pass | `task-pi-shadow-live-PKS02-read-only-tool-4acb522f-4f47-4826-8c7b-ac617ebc08e2` |
| `PKS02-read-only-tool` | pass | `task-pi-shadow-live-PKS02-read-only-tool-4f5248bf-72fd-41e3-9953-241310048cd0` |
| `PKS02-read-only-tool` | pass | `task-pi-shadow-live-PKS02-read-only-tool-1ae0f80a-a1e0-4321-8438-f774ca209cf5` |

All six production task runs are persisted as `succeeded`, and all six matching
`kernel.shadow.compared` events have `passed=true`. Each of the three PKS02
records classifies both production and candidate envelopes as `json_object`;
no raw provider output was persisted in the comparison evidence. `[E]`

The collection produced 18 `provider_call_telemetry` rows against
`deepseek/deepseek-v4-flash`; every row recorded HTTP 200. Comparison events
record 7,532/419 LOS prompt/completion tokens and 1,644/379 Pi
prompt/completion tokens. Candidate-side estimated cost totals `$0.00033628`.
This is not total provider billing because the LOS telemetry rows do not all
contain normalized usage or cost. `[E]`

The persisted v4 report after collection is: `[E]`

- deterministic evidence: 11/11 passing, zero failures;
- live-provider evidence: 6/6 passing, zero failures;
- overall corpus: 17/17 observed and passing;
- overall status: `ready_for_k4_policy_review`;
- `observedCount=17`;
- `ignoredCount=0`;
- automatic admission: disabled.

## Judgment

Candidate `0.81.1+los.3` now satisfies the preregistered K3 corpus gate and is
eligible for K4 policy review. The v2 operation-input failure and v3 candidate
result-envelope failure remain immutable historical evidence and were not
reinterpreted as v4 evidence. Pi remains absent from the production registry,
and no read-only canary is authorized. `[E]`

The remaining two v2 observations were not collected after the historical v2
failure. The sixth v3 observation was not collected after the new v3 failure.
The clean v4 corpus permits K4 policy review only; it does not itself authorize
registry admission or canary execution. `[E]`

## Residual Gap

The current change covers unspecified reasoning semantics. Explicit
`thinking='enabled'` is not yet mapped end to end through Pi model options;
explicit disablement remains fail-closed through admission. This does not
invalidate the current deterministic corpus, whose model settings do not
request explicit thinking, but it remains a blocker for broader model-setting
compatibility and default promotion. `[E]`

## Next Action

1. Keep the operation-input failure and all earlier candidate observations
   immutable; do not delete or relabel persisted rows.
2. Do not rerun or bypass the failed v3 corpus, and do not recollect the
   complete v4 corpus.
3. K4 policy review is now eligible but was not performed by this collection.
   Keep registry admission, canary use, and production selection blocked until
   their separate review and operator decisions are recorded.
4. Keep the parent task `in_progress` until Web-first manual acceptance and
   graph integration review are complete.
