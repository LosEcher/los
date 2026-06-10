# 2026-06-10 Stage A Exit Audit

## Background

`docs/governance/agent-workflow-roadmap.md` defined Stage A as the evidence
harness phase. The repo has since added run specs, stream checkpoints,
verification records, provider compatibility evidence, recovery read models,
memory compaction, and DAG verifier paths. This audit checks whether Stage A
can be marked complete and which later-stage work has already started.

## Current State

Stage A exit criteria:

1. every current-state claim names its truth surface;
2. a run can be reviewed without relying on UI state alone;
3. periodic governance reports create owned follow-up items instead of loose
   observations.

### Criterion 1: Truth Surfaces Are Named

Observed evidence:

1. `packages/agent/src/run-specs.ts` persists run specs with tenant, project,
   request, trace, prompt, provider, model, tool mode, run contract, gateway id,
   and status.
2. `packages/agent/src/task-runs.ts` persists task lifecycle records with
   session, run spec, trace, tenant, project, node, workspace root, status,
   heartbeat, lease, and metadata.
3. `packages/agent/src/session-events.ts` stores session-level events for
   replay and audit.
4. `packages/agent/src/tool-call-states.ts` stores durable tool-call state used
   by recovery decisions.
5. `packages/agent/src/verification-records.ts` stores required checks and
   verifier results.
6. `packages/agent/src/provider-compat-evidence.ts` and
   `packages/agent/src/provider-promotion-decisions.ts` keep provider
   readiness and compatibility evidence separate.
7. `docs/adr/0015-external-transcript-truncation-and-run-replay-policy.md` and
   `docs/adr/0016-omx-tool-level-logging-scope.md` separate los-owned run
   evidence from external summarized evidence.

Inference: current-state claims have concrete truth surfaces available in code
and docs. The remaining risk is process discipline, not missing storage.

Judgment: satisfied for Stage A.

### Criterion 2: Runs Are Reviewable Without UI State

Observed evidence:

1. `contracts/run-spec.yaml` and `contracts/run-stream.yaml` define run spec
   metadata and stream replay surfaces.
2. `packages/gateway/src/routes/run-routes.ts` exposes run inspection, state,
   recovery, verification, approval, plan revision, events, and stream replay
   APIs.
3. `packages/gateway/src/run-events-routes.test.ts` covers run event replay,
   inspect/state/recover/verify routes, and interleaved stream checkpoints.
4. `packages/agent/src/stream-checkpoints.ts` persists model/tool/turn stream
   checkpoints.
5. `packages/gateway/src/chat-stream-persist.ts` persists chat stream
   checkpoints through awaited chat callbacks.
6. `packages/agent/src/runtime-evidence-graph.ts` projects runtime evidence
   across run specs, tasks, tool calls, verification records, and events.
7. `docs/operations/2026-06-07-run-verification-recovery-smoke.md` and
   `docs/operations/2026-06-09-phase-b0-contract-enforcement-smoke.md`
   document live operator checks for verification recovery and run contract
   enforcement.

Inference: a run can be reviewed through persisted rows, HTTP/API read models,
tests, and operation smokes without trusting UI state alone.

Judgment: satisfied for Stage A.

### Criterion 3: Governance Reports Create Owned Follow-Up Items

Observed evidence:

1. `docs/governance/eval-backlog.md` defines narrow cases with trigger, bad
   pattern, required evidence, passing pattern, and owner surface.
2. `docs/governance/periodic-analysis.md` defines recurring analysis inputs
   and routing for findings.
3. `docs/governance/run-chain-changes/` contains dated change records linking
   implementation slices to evidence and residual work.
4. `packages/agent/src/todos.ts` and `packages/agent/src/todo-seeds.ts` provide
   the persisted planning ledger for owned follow-up items.
5. `packages/agent/src/todo-seeds-governance.ts` seeds governance-oriented
   follow-up work.

Inference: the repo has an owned follow-up surface. The missing part is not a
data model; it is a recurring report that records Stage A closure and keeps the
eval backlog moving.

Judgment: satisfied with one follow-up: monthly governance reports should
explicitly update eval backlog implementation status.

## Stage Drift

Observed implementation has moved beyond the roadmap labels:

1. Stage B started early: `run_contract_json`, mode/phase/plan/verification
   metadata, approval, plan revision, and completion gates exist.
2. Stage D started early: durable run specs, stream checkpoints, run state
   projections, tool-call recovery, task leases, service heartbeats, and
   failover recovery surfaces exist.
3. Stage E started early: task graph records, dependency claims, bounded
   parallelism, verifier tasks, provider/model task selection, and procedural
   memory candidates exist.

Judgment: Stage A can be closed as complete. Stages B, D, and E should be
marked as partially implemented early, with evidence gaps tracked instead of
being described only as future work.

## Decision

Stage A is complete as of 2026-06-10.

The next P0 is structure convergence, not feature expansion:

1. keep gateway route modules under `packages/gateway/src/routes/`;
2. prevent root-level gateway `*-routes.ts` from returning via
   `tools/check-structure.sh`;
3. open a separate pass for the web package dual-track layout;
4. promote the top eval backlog cases into automated probes after the structure
   pass.

## Remaining Verification

Run before closing the structural pass:

```bash
pnpm check
pnpm --filter @los/gateway test
pnpm --filter @los/web check
```

Residual risks:

1. `docs/governance/eval-backlog.md` still has more cases than automated
   probes.
2. GitHub Actions is not yet the remote gate for `pnpm gate`.
3. Go executor contract compatibility remains only indirectly checked.
