# ADR 0041: Preregistered Promotion Gates For Kernel And Provider Replacement

- Status: Accepted
- Date: 2026-08-16
- Supersedes: none (extends ADR 0039 upgrade policy and ADR 0017 advisory
  provider promotion with numeric gates)
- Tracking: roadmap R4 (todo `todo-los-rm-kernel-economics`)

## Context

ADR 0039 (execution-kernel replacement) and ADR 0017 (advisory provider
promotion) require pairwise evidence before replacement, but neither defines
**numeric** thresholds. ADR 0039 states "numeric promotion thresholds must be
preregistered in an eval ADR before the comparison data is inspected. They are
not chosen retrospectively" — this ADR is that preregistration.

Current data posture (2026-08-16, production DB):

- `run_evals`: 436 rows, all `evaluation_kind=single`, `pairwise_verdict`
  never populated — no pairwise baseline-vs-candidate evidence exists yet.
- `execution_experiments`: 4 K4 experiments (Pi shadow/canary lineage).
- Effort attribution (`request_meta_json`) started capturing on 2026-08-16,
  so effort-tier comparisons need a ≥ 30 day observation window from that date.

The promotion gates below are therefore intentionally **stricter than any
current data can satisfy**. They define when the operator may consider a
replacement decision, not a commitment that any replacement is planned.

## Decision

### 1. Evidence Dimensions (what gets measured)

Every pairwise evaluation records, per baseline and candidate, on the **same
preregistered corpus** (same RunContract, ToolBroker, verifier, task classes):

| Dimension | Source field | Definition |
| --- | --- | --- |
| Success rate | `run_evals.success` | verifier-confirmed success fraction (AP3-gated) |
| First-pass success | `success` with `retry_count=0` | success without retries |
| Recovery | `retry_count>0` and final success | fraction of multi-attempt runs that succeed |
| Tool side effects | `tool_error_count` | invalid/repeated tool calls per run |
| Latency | `latency_ms` | P50/P95 end-to-end per task class |
| Cost | `model_cost` | total USD per run (telemetry L1 when available) |
| Operator intervention | `user_feedback` + blocked-task fraction | human steering or approval actions |
| Governance violations | `failure_class` taxonomy | policy/verification/context failures |

`pairwise_verdict` must be populated from `deterministic_evidence_json` first,
then `judge_evidence_json`, then `human_evidence_json` — never from the
executing model's self-report (`same_model` independence is not a verdict).

### 2. Sample Gates (observation adequacy, checked before any comparison)

All must hold for the **decision window** (the last N days being compared):

1. Paired runs ≥ 50 per task class, spread over ≥ 30 days.
2. Baseline and candidate each ≥ 30 terminal samples per class.
3. Effort-tier comparisons additionally require ≥ 30 days of
   `request_meta_json.reasoningEffort` coverage (from 2026-08-16).
4. No failed/unpersisted observation in the window (K4 corpus discipline).

If any gate fails, the comparison is **not ready** — it cannot be retroactively
marked ready by redefining the corpus.

### 3. Non-Inferiority Thresholds (per task class)

Candidate is **not worse** than baseline when all of:

- success rate ≥ baseline − 2 percentage points;
- first-pass success ≥ baseline − 3 pp;
- P95 latency ≤ baseline × 1.5;
- model cost ≤ baseline × 1.5 (or ≤ baseline + $0.02/run when baseline < $0.02);
- operator intervention rate ≤ baseline + 2 pp;
- tool error rate ≤ baseline + 1 pp.

### 4. Promotion Decision Rules

- Promote only when the candidate is **strictly better** on at least one
  dimension and **not worse** on all others; a tie keeps the current kernel.
- A promotion is reversible: per-run rollback must remain available for the
  accepted observation window (≥ 14 days) after promotion.
- Numeric thresholds are fixed at the preregistration date. A later revision
  requires a new ADR and a fresh observation window; revised thresholds cannot
  be applied to data collected before the revision.
- Any quality panel must show miss samples and skipped checks, not just the
  passing rate (verification ritualization guard).

### 5. Cadence

- At most one kernel/provider promotion decision per 30-day window.
- The 2026-09-16 checkpoint runs the SQL in
  `docs/operations/2026-08-16-deployment-convergence.md` (pairwise volume
  vs §2 gates) and reports readiness — a report of "not ready" is a valid
  outcome.

## Consequences

- Positive: replacement decisions become checkable before data is inspected;
  the R2 SLO report and R3 recovery drills give the decision window its
  operational context; effort-tier routing can be evaluated from
  request_meta_json once §2.3 holds.
- Costs: pairwise corpus collection is real work (double execution cost);
  gates may delay a beneficial replacement; the ≥ 30-day windows delay any
  Pi-default decision to at least mid-September 2026.
- Risks: sample-gate gaming (mitigated by §2.4 and fixed preregistration);
  judge-model correlation with the candidate (mitigated by §1 verdict order
  and independence levels from roadmap R1).

## Non-Goals

1. This ADR does not authorize any promotion.
2. It does not set provider-tier routing thresholds for chat routing
   (that remains ADR 0031 provider-health-aware routing scope).
3. It does not waive operator approval: gates are necessary, not sufficient.

## Verification

1. ADR recorded before any pairwise verdict is inspected (this file, dated).
2. The 2026-09-16 checkpoint produces a readiness report against §2 gates.
3. Any promotion PR references this ADR's thresholds and the checkpoint data.

## References

- ADR 0039 upgrade policy (§Upgrade Policy) and replacement gates
- ADR 0017 advisory provider promotion playbook
- `contracts/execution-pairwise-eval.yaml`, `contracts/run-evals` fields
- `packages/agent/src/run-evals/pairwise.ts`
- roadmap R2 SLO report, R3 recovery drills (decision-window context)
