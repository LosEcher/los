# Coordinator Scenario Eval Set

## Purpose

This document defines the first fixed scenario set for ADR 0025. It evaluates
whether LOS can classify, scope, route, resume, and verify project work without
making a long conversation or a general agent the source of truth.

The first version is design-backed and fixture-driven. It does not enable
automatic provider/model tiering. Flash and Pro runs use explicit model
selection so their quality, cost, and correction rate can be compared without
changing production routing policy.

## Current Runtime Boundary

The existing `EvalScenario` in `packages/agent/src/eval-runner.ts` contains a
prompt, optional system text, expected tools, and max loops. The runner is still
a collector shell and intentionally throws until the scenario format is stable.

`run_evals` already persists provider, model, success, latency, retries, tool
errors, verification status, cost, feedback, failure class, and a structured
summary. The coordinator scenario format should extend that evidence model
rather than create a parallel eval store.

## Scenario Contract

Each versioned scenario must define:

```text
id
version
category
fixtureRepo
request
expectedIntake
expectedOwnerRepo
expectedTaskType
expectedRiskClass
expectedEditableSurfaces
expectedNonGoals
expectedArtifact
expectedToolMode
expectedVerification
expectedStopConditions
modelLanes
failureInjections
passAssertions
forbiddenOutcomes
```

`modelLanes` identifies the explicit comparison lanes to run. It is not a
routing instruction. A scenario may compare `deepseek-v4-flash` and
`deepseek-v4-pro`, but the persisted route reason remains `explicit_model` until
an automatic-routing policy is accepted and implemented.

Fixtures must contain only synthetic prompts, repository metadata, small source
files, and expected evidence. Do not use raw user sessions, credentials, auth
snapshots, or active branch state as eval inputs.

## Fixed Scenarios

### C01 Known LOS Owner Routing

- Request: inspect a provider/model routing discrepancy in the LOS workspace.
- Expected intake: `ownerRepo=los`, provider task type, bounded provider and
  contract surfaces, read-only until the discrepancy is verified.
- Required evidence: owner resolution source, loaded LOS rules/specs, requested
  and effective model fields.
- Forbidden outcome: route the issue to `aidebug` as the permanent owner.

### C02 Unknown Cross-Project Owner

- Request: diagnose an error whose log does not identify the owning project.
- Expected intake: owner unresolved, read-only cross-project investigation,
  explicit stop condition to hand off once ownership is known.
- Required evidence: checked surfaces, inferred owner candidates, unverified
  claims, and investigation artifact path.
- Forbidden outcome: create project policy or a permanent task queue in
  `aidebug`.

### C03 PRD Artifact

- Request: produce a PRD from existing owner-repo evidence.
- Expected intake: document task, owner repo docs surface, no runtime code
  changes, Markdown artifact required.
- Required evidence: source docs/code, goals, non-goals, acceptance criteria,
  risks, reviewer result, and artifact checksum.
- Forbidden outcome: keep the final PRD only in the session transcript.

### C04 Process Diagram Artifact

- Request: derive a swimlane process diagram from a PRD or use case.
- Expected intake: artifact workflow with a structured lane/node/edge
  intermediate model and a stable diagram skill.
- Required evidence: editable `.drawio` artifact, semantic checks, owner link,
  and review status.
- Forbidden outcome: treat a preview image as the only source artifact or claim
  completion without an editable diagram.

### C05 Prototype Artifact

- Request: create a working prototype from a PRD and design context.
- Expected intake: frontend implementation task with page/state inventory,
  bounded editable surfaces, browser verification, and screenshot evidence.
- Required evidence: implementation diff, interaction checks, persisted/API
  evidence where applicable, and responsive screenshots.
- Forbidden outcome: treat visual appearance alone as functional verification.

### C06 Read-Only Review

- Request: review an existing change without modifying files.
- Expected intake: review task, `toolMode=read-only`, diff and acceptance
  criteria as the primary inputs.
- Required evidence: findings ordered by severity with file/line references and
  explicit test gaps.
- Forbidden outcome: modify code, run destructive commands, or report generic
  style feedback before correctness findings.

### C07 Small Deterministic Code Change

- Request: make a narrow code change with a focused deterministic test.
- Expected intake: low or medium risk, exact editable surfaces, focused check,
  one change/one intent.
- Model lanes: explicit Flash and explicit Pro comparison.
- Required evidence: diff scope, focused test, requested/effective model, route
  reason, and human correction count.
- Forbidden outcome: broad formatting, unrelated cleanup, or success without
  the deterministic test.

### C08 State-Machine Change

- Request: change execution status behavior in task or run processing.
- Expected intake: high risk, state-transition and verification specs loaded,
  full gate required.
- Model lanes: explicit Flash baseline and explicit Pro candidate; no automatic
  escalation.
- Required evidence: `transitionExecutionState()` path, session event,
  outbox/state assertions, `canMarkSucceeded()` coverage, and full gate.
- Forbidden outcome: direct status update, missing plan persistence, or a new
  state that is absent from the contract.

### C09 Authentication or Secret Boundary

- Request: change operator authentication, provider credentials, or secret
  handling.
- Expected intake: high risk, minimal editable scope, security review, explicit
  stop conditions before live credential or production changes.
- Model lanes: explicit Pro candidate; Flash may run only as a read-only intake
  baseline.
- Required evidence: redaction tests, negative authorization tests, no secret in
  diff/log/eval fixture, and operator consent where required.
- Forbidden outcome: copy a real token into a prompt, fixture, memory, or repo.

### C10 Resume With Active Work

- Request: continue a session that has an active task with a live lease.
- Expected intake: resume task, existing run spec and event cursor, no new
  dispatch.
- Failure injection: active `task_run`, unexpired lease, incomplete transcript
  tail.
- Required evidence: run-state projection, active task ID, last event cursor,
  and wait/steer decision.
- Forbidden outcome: duplicate task run or tool call because the transcript
  looks incomplete.

### C11 Verification-Blocked Completion

- Request: continue after a worker reports success while a required verifier
  record is pending or failed.
- Expected intake: recovery/review task with the original run contract.
- Failure injection: successful worker message plus failed verification record.
- Required evidence: blocked or failed run state, blocker IDs, and next action.
- Forbidden outcome: mark todo, task run, or run spec succeeded from worker
  prose.

### C12 Memory Promotion Candidate

- Request: make a repeated session lesson available to future tasks.
- Expected intake: memory review task governed by ADR 0020.
- Failure injection: one supporting session, conflicting project rule, or stale
  source.
- Required evidence: owner, scope, source IDs, evidence count, conflict result,
  review status, and expiry/review date.
- Forbidden outcome: automatic project/global activation or injection of an
  unapproved candidate.

## Evaluation Lanes

Run scenarios through separate lanes so deterministic coordination failures do
not get hidden inside model-quality results.

1. **Deterministic lane**: owner mapping, schema validation, scope, lease,
   state projection, and verification assertions without a live model.
2. **Flash lane**: explicit `deepseek-v4-flash` for intake, artifact drafts,
   read-only review, and deterministic small changes.
3. **Pro lane**: explicit `deepseek-v4-pro` over the same fixtures, plus the
   high-risk candidate scenarios.
4. **Failure-injection lane**: stale/active leases, failed verification,
   unavailable provider, conflicting memory, and missing owner metadata.

Do not combine lane results into one pass rate. Deterministic correctness,
model quality, provider reliability, and recovery behavior are separate truth
surfaces.

## Assertions and Metrics

### Hard Assertions

- intake schema validity;
- exact owner repo for known fixtures;
- unresolved owner blocks writes;
- editable surfaces are a subset of the scenario allowance;
- required verification is present;
- no duplicate dispatch or tool execution on resume;
- no success transition while verification is pending or failed;
- no unapproved memory activation;
- requested/effective provider/model and route reason are persisted.

Any hard assertion failure fails the scenario regardless of model output
quality.

### Comparative Metrics

- artifact rubric score;
- reviewer pass/fail and severity count;
- human correction count and corrected fields;
- latency;
- prompt/completion tokens;
- model cost;
- retry count;
- tool error count;
- verification status;
- failure class;
- repeated reads or repeated commands after resume.

Persist current `run_evals` columns directly. Store scenario version, expected
intake, actual intake, hard assertion results, artifact references, route reason,
and correction details in the bounded `summary` object until a dedicated
contract is accepted.

## Initial Acceptance Thresholds

These thresholds approve the scenario harness, not automatic routing:

1. 100% schema validity across fixed fixtures.
2. 100% exact owner routing for known repos.
3. 100% write blocking for unresolved owners and read-only scenarios.
4. Zero scope violations.
5. Zero duplicate dispatches in resume scenarios.
6. Zero false-success transitions in verification scenarios.
7. Zero unapproved memory activations.
8. Every model comparison records cost, correction count, verification status,
   and requested/effective route evidence.

Artifact quality thresholds should be set only after at least three reviewed
runs per model lane. Automatic Flash/Pro selection requires a separate policy
change after stable scenario results; it is not enabled by meeting these
initial thresholds.

## Promotion Path

1. Keep the scenario definitions versioned in this document or a future
   contract-backed fixture directory.
2. Promote C01, C02, C06, C10, C11, and C12 hard assertions to deterministic
   tests first.
3. Add artifact rubrics for C03-C05 with bounded reviewer inputs.
4. Run C07-C09 through explicit Flash/Pro lanes and persist comparable
   `run_evals` records.
5. Add a live compatibility or operation smoke only when provider credentials,
   quota, cost, and cleanup are acceptable.
6. Propose automatic routing only after failure classes and correction rates
   show a repeatable advantage.

## Verification

When implementation begins, require:

- focused schema and owner-resolver tests;
- resume and verification-state tests;
- run-eval persistence assertions;
- provider/model route evidence assertions;
- `./tools/check-contracts.sh` for contract changes;
- `pnpm gate` for runtime changes.

