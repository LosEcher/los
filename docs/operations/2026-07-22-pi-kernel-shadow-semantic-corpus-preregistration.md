# Pi Kernel Shadow Semantic Corpus Preregistration

- Date: 2026-07-22
- Status: preregistered; no observations collected under this revision
- Candidate: Pi `0.81.1`, execution-kernel protocol `0.1.0`
- Corpus: `1.1.0`
- Rubric: `pi-shadow-readonly-v2`
- Supersedes for future collection: `1.0.1` / `pi-shadow-readonly-v1`

## Observed

Corpus `1.0.1` completed 17 fixed observations with 16 passes and one live
read-only-tool failure. Tool sequence, successful tool state, terminal event,
and actual session/task/trace lineage all matched. The only failed assertion
was byte-level output-hash equality: the two independent provider calls
returned the same package value with different Markdown presentation.

The `1.0.1` records remain immutable and continue to report `collecting`.
This revision does not reinterpret those records or authorize a canary.

## Decision

The next read-only-tool scenario uses a typed answer envelope:

```json
{"packageName":"<package name>"}
```

The comparator accepts either direct JSON or one `json` Markdown fence, then
requires exactly one `packageName` string field. It records only SHA-256
digests of the parsed value in comparison evidence. It does not preserve or
compare raw response bytes for this scenario.

The following assertions are preregistered before any `1.1.0` collection:

1. production and candidate envelopes parse;
2. both parsed values equal the pinned repository value `@los/agent`;
3. both parsed values are equal;
4. the existing tool sequence, tool state, terminal, status, contract, and
   lineage assertions continue to apply.

The no-tool scenario keeps exact output-hash equality because its sentinel is
deliberately deterministic. Denial, provider-failure, and interruption remain
deterministic-only scenarios.

## Collection Rule

No `1.1.0` observation may be counted until this file and the implementation
revision are committed. Existing `1.0.0` and `1.0.1` rows are ignored by the
versioned report and are not deleted or rewritten. Readiness remains a report
for K4 policy review only; automatic registry admission and canary use stay
disabled.

## Verification

Before collection, the focused scenario and shadow tests must pass, followed by
the package check and root contract check. After collection, the report must
show every required `1.1.0` cell with zero failures. A ready report still
requires a separate operator decision, persisted candidate run spec,
operator-visible rollback, and formal pairwise evidence before K4.
