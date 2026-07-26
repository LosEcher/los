# ADR 0040: Execution Experiment Provenance And Candidate Lifecycle

- Status: Accepted
- Date: 2026-07-26
- Implementation status: Contract and base lifecycle implemented; scoped access,
  idempotent creation, explicit candidate approval, and focused gates are part
  of this decision.

## Context

LOS already supports session branch, resume, retry, durable run specs, stream
replay, and verification-gated completion. Those recovery operations preserve
or continue an existing intent. An execution experiment has a different goal:
derive a new candidate run from immutable source evidence while making every
configuration change reviewable.

Without a dedicated boundary, a rerun can be mistaken for side-effect-free
replay, a candidate can bypass persisted plan approval, or an operator from one
tenant can act on an experiment from another tenant by guessing its id.

## Decision

`los.execution-experiment` owns a single-candidate lifecycle:

```text
source session/run/event evidence
              |
          draft experiment
              | operator approval
           approved
              | create planning candidate -> approveRunSpecPhase
            running
              | verification records / canMarkSucceeded
       succeeded | blocked | failed | cancelled
```

The source reference contains session id, run spec id, event cursor, evidence
hash, and optional prompt/spec/memory/tool-catalog fingerprints. It does not
copy or rewrite source session events. `configDiff` is the complete enumerable
candidate override surface; all omitted values inherit from the source run.

`POST /execution-experiments` accepts `x-idempotency-key` through the shared
gateway idempotency ledger. Replaying the same scoped key and body returns the
persisted response; a different body conflicts. All reads and mutations are
scoped to the request tenant and project. Approval and execution require the
validated operator principal when authentication is enabled.

The candidate is persisted with phase `planning`, including the inherited plan
and verification mapping. The gateway then calls `approveRunSpecPhase()` before
the run enters `running`. It must not construct a new run directly in
`plan_approved`. Candidate completion remains owned by the ordinary AP3 path;
experiment status can become `succeeded` only after the candidate run has
passing verification evidence.

`maxLoops` and `timeoutMs` are execution budgets. They inherit from the source
unless explicitly listed in `configDiff`, and an override must be a positive
integer accepted by the run-spec contract. Tool mode and allowed-tool changes
are likewise explicit and remain subject to the scheduler/tool policy.

## Semantic Boundaries

| Operation | Meaning | New run spec | May repeat side effects |
| --- | --- | --- | --- |
| resume | continue an interrupted run from durable state | no | continues existing attempt |
| retry | create another attempt for the same run spec | no | yes |
| branch | create a related conversational/session lineage | optional | depends on later execution |
| rerun experiment | execute a new candidate from source evidence | yes | yes |

The UI and API must not describe experiment execution as replay. Replay reads
persisted evidence; rerun invokes providers and tools again.

## Consequences

- Experiment IDs remain globally unique, while authorization is enforced by
  tenant/project scope and operator gates.
- Idempotency protects draft creation; execute retries still follow lifecycle
  status and cannot start a second candidate after the experiment leaves
  `approved`.
- Live experiment execution remains operator-gated and requires a separate
  runtime smoke; deterministic tests do not grant production admission.
- Pairwise evaluation can reference immutable experiment, baseline, and
  candidate identities without owning execution state.

## Verification

- `./tools/check-contracts.sh`
- focused `@los/agent` execution experiment tests
- focused `@los/gateway` route and idempotency tests
- `pnpm check:migration-drift`
- `pnpm run gate` for cross-package delivery
